-- Account-only admin operations. Never represent adjustments as Paddle purchases.
-- A fully removed grant must remain zero through queued/paused plan resumption.
-- Keep the original amount in immutable adjustment audit; trial remains exactly 900000.
alter table public.customer_usage_grants drop constraint customer_usage_grants_granted_ms_check;
alter table public.customer_usage_grants add constraint customer_usage_grants_granted_ms_check check(granted_ms>=0);
create table public.account_catalog_policy (
 offer_code text primary key check(offer_code in ('pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly')),
 display_name text not null check(length(trim(display_name)) between 2 and 80),
 enabled boolean not null default true,
 priority integer not null check(priority between 0 and 1000),
 updated_at timestamptz not null default now()
);
insert into public.account_catalog_policy(offer_code,display_name,priority) values
 ('pro_3_hours','SigmaPro 3 Hours',10),('pro_40_hours','SigmaPro 40 Hours',20),
 ('enterprise_weekly','SigmaEnterprise Weekly',30),('enterprise_monthly','SigmaEnterprise Monthly',40);
alter table public.account_catalog_policy enable row level security;
revoke all on public.account_catalog_policy from public,anon,authenticated,service_role;
create index customer_accounts_admin_cursor on public.customer_accounts(created_at desc,user_id desc);
create index customer_usage_runs_recent on public.customer_usage_runs(user_id,created_at desc,run_id);
create index customer_usage_grants_admin_recent on public.customer_usage_grants(user_id,starts_at desc,id);

create function public.account_catalog_read() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('code',offer_code,'name',display_name,'enabled',enabled,'priority',priority) order by priority,offer_code),'[]')
 from public.account_catalog_policy;
$$;
revoke all on function public.account_catalog_read() from public,anon,authenticated;
grant execute on function public.account_catalog_read() to service_role;

-- Preserve original checkout invariants and replay behavior; disable NEW intent creation only.
alter function public.customer_checkout_prepare(uuid,uuid,uuid,text) rename to customer_checkout_prepare_core;
revoke all on function public.customer_checkout_prepare_core(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.customer_checkout_prepare(p_user_id uuid,p_session_id uuid,p_request_id uuid,p_offer_code text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare enabled_now boolean;
begin
 select enabled into enabled_now from public.account_catalog_policy where offer_code=p_offer_code for share;
 if enabled_now is distinct from true and not exists(select 1 from public.customer_checkout_intents where user_id=p_user_id and request_id=p_request_id) then
   return jsonb_build_object('code','UNAVAILABLE');
 end if;
 return public.customer_checkout_prepare_core(p_user_id,p_session_id,p_request_id,p_offer_code);
end $$;
revoke all on function public.customer_checkout_prepare(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.customer_checkout_prepare(uuid,uuid,uuid,text) to service_role;

create function public.account_admin_adjust(p_actor uuid,p_session uuid,p_operation uuid,p_subject uuid,p_action text,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit%rowtype; g public.customer_usage_grants%rowtype; amount bigint; ident uuid; before_ms bigint; t timestamptz;
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_operation is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 or p_input is null
   or p_action is null or p_action not in ('ADD_MINUTES','REMOVE_MINUTES','CATALOG') then return jsonb_build_object('code','INVALID'); end if;
 -- Match existing admin lock order: actor, operation, subject, grant. UUID lock also protects cross-actor reuse.
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation::text,912345));
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
   if prior.actor_id<>p_actor or prior.subject_id is distinct from p_subject or prior.action<>p_action
     or prior.reason<>trim(p_reason) or prior.detail->'input' is distinct from p_input then return jsonb_build_object('code','CONFLICT'); end if;
   return jsonb_build_object('code','APPLIED');
 end if;
 if p_action='CATALOG' then
   if p_subject is not null or jsonb_typeof(p_input->'name') is distinct from 'string'
     or length(trim(p_input->>'name')) not between 2 and 80
     or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
     or coalesce(p_input->>'priority','') !~ '^[0-9]{1,4}$' then return jsonb_build_object('code','INVALID'); end if;
   if (p_input->>'priority')::integer>1000 then return jsonb_build_object('code','INVALID'); end if;
   update public.account_catalog_policy set display_name=trim(p_input->>'name'),enabled=(p_input->>'enabled')::boolean,
     priority=(p_input->>'priority')::integer,updated_at=clock_timestamp() where offer_code=p_input->>'code';
   if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
 else
   if coalesce(p_input->>'minutes','') !~ '^[1-9][0-9]{0,4}$' then return jsonb_build_object('code','INVALID'); end if;
   amount:=(p_input->>'minutes')::bigint*60000;
   if amount>3600000000 then return jsonb_build_object('code','INVALID'); end if;
   perform 1 from public.customer_accounts where user_id=p_subject for update;
   if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
   t:=clock_timestamp();
   if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
   if p_action='ADD_MINUTES' then
     insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at)
       values(p_subject,'admin-adjustment:'||p_operation,'PACK',amount,t) returning id into ident;
   else
     begin ident:=(p_input->>'grantId')::uuid; exception when invalid_text_representation then return jsonb_build_object('code','INVALID'); end;
     select * into g from public.customer_usage_grants where user_id=p_subject and id=ident for update;
     if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
     -- The once-ever trial's 900-second grant is immutable. Suspension controls access to it.
     if g.kind='TRIAL' or g.state not in ('ACTIVE','PAUSED') or (g.expires_at is not null and g.expires_at<=t and g.state<>'PAUSED') then return jsonb_build_object('code','INVALID'); end if;
     before_ms:=g.granted_ms;
     if amount>g.granted_ms-g.spent_ms-g.reserved_ms then return jsonb_build_object('code','INSUFFICIENT_UNUSED'); end if;
     update public.customer_usage_grants set granted_ms=granted_ms-amount where id=g.id;
   end if;
 end if;
 insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
 values(p_operation,p_actor,p_subject,p_action,trim(p_reason),jsonb_build_object('input',p_input,'grantId',ident,
   'adjustmentMilliseconds',case when p_action='REMOVE_MINUTES' then -amount else amount end,'priorGrantedMilliseconds',before_ms,'source','ADMIN_ADJUSTMENT'));
 return jsonb_build_object('code','APPLIED');
end $$;
revoke all on function public.account_admin_adjust(uuid,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_admin_adjust(uuid,uuid,uuid,uuid,text,text,jsonb) to service_role;

create function public.account_admin_read_v2(p_actor uuid,p_session uuid,p_subject uuid default null,p_query text default '',p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare users jsonb; audit jsonb; grants jsonb; plans jsonb:='[]'; sessions jsonb:='[]'; billing jsonb:='[]'; balances jsonb:='{}'; trial jsonb; search_user uuid;
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_query is null or length(p_query)>254 or (p_before is null)<>(p_before_id is null) then return jsonb_build_object('code','INVALID'); end if;
 -- Auth normalizes email at creation. Resolve exact indexed identity once, not a
 -- lower(email)/UUID-text scan across the account list on each administration read.
 if trim(p_query)<>'' then
   begin search_user:=trim(p_query)::uuid;
   exception when invalid_text_representation then
     select id into search_user from auth.users where email=lower(trim(p_query)) limit 1;
   end;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('userId',a.user_id,'email',u.email,'emailVerified',u.email_confirmed_at is not null,
   'state',a.state,'createdAt',a.created_at) order by a.created_at desc,a.user_id desc),'[]') into users
 from (select c.* from public.customer_accounts c join auth.users u on u.id=c.user_id
   where (p_subject is null or c.user_id=p_subject) and (trim(p_query)='' or c.user_id=search_user)
   and (p_before is null or (c.created_at,c.user_id)<(p_before,p_before_id)) order by c.created_at desc,c.user_id desc limit 50) a
 join auth.users u on u.id=a.user_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',operation_id,'actor',actor_id,'subject',subject_id,'action',action,'reason',reason,'detail',detail,'createdAt',created_at) order by created_at desc),'[]') into audit
 from (select * from public.account_admin_audit where p_subject is null or subject_id=p_subject order by created_at desc limit 100) x;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'state',state,'grantedMilliseconds',granted_ms,'spentMilliseconds',spent_ms,
   'reservedMilliseconds',reserved_ms,'expiresAt',expires_at,'testGrant',source_key like 'admin-test:%','adminAdjustment',source_key like 'admin-adjustment:%') order by starts_at desc),'[]') into grants
 from (select * from public.customer_usage_grants where user_id=p_subject order by starts_at desc,id limit 100) g;
 if p_subject is not null then
   select coalesce(jsonb_object_agg(kind,amount),'{}') into balances from (select kind,sum(greatest(0,granted_ms-spent_ms-reserved_ms)) amount
    from public.customer_usage_grants where user_id=p_subject and state='ACTIVE' and starts_at<=clock_timestamp()
      and (expires_at is null or expires_at>clock_timestamp()) group by kind) b;
   select jsonb_build_object('registered',true,'grantedMilliseconds',t.granted_seconds::bigint*1000,
     'remainingMilliseconds',coalesce(g.granted_ms-g.spent_ms-g.reserved_ms,t.granted_seconds::bigint*1000)) into trial
     from public.customer_trial_grants t left join public.customer_usage_grants g on g.user_id=t.user_id and g.source_key='lifetime-trial' where t.user_id=p_subject;
   select coalesce(jsonb_agg(jsonb_build_object('offerCode',s.offer_code,'tier',s.tier,'state',t.state,'startsAt',t.starts_at,'endsAt',t.ends_at,
     'remainingMilliseconds',t.remaining_ms,'paymentState',s.state,'cancelFuture',s.cancel_future,'graceUntil',s.grace_until)),'[]') into plans
   from (select * from public.customer_recurring_terms where user_id=p_subject order by created_at desc limit 30) t
    join public.customer_recurring_subscriptions s on s.subscription_id=t.subscription_id;
   select coalesce(jsonb_agg(jsonb_build_object('id',run_id,'startedAt',created_at,'state',state) order by created_at desc),'[]') into sessions
     from (select * from public.customer_usage_runs where user_id=p_subject order by created_at desc,run_id limit 30) x;
   select coalesce(jsonb_agg(jsonb_build_object('id',id,'offerCode',offer_code,'state',state,'createdAt',created_at,'transactionId',transaction_id) order by created_at desc),'[]') into billing
     from (select * from public.customer_checkout_intents where user_id=p_subject order by created_at desc limit 30) x;
 end if;
 return jsonb_build_object('code','ACTIVE','users',users,'audit',audit,'grants',grants,'models',public.account_models_read(),
   'catalog',public.account_catalog_read(),'balances',balances,'trial',trial,'plans',plans,'sessions',sessions,'billing',billing);
end $$;
revoke all on function public.account_admin_read_v2(uuid,uuid,uuid,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.account_admin_read_v2(uuid,uuid,uuid,text,timestamptz,uuid) to service_role;
