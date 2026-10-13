-- Account staging workspace and audited controls. No bootstrap admin, paid grant,
-- production configuration or existing financial/legacy row is modified.
create table public.account_admin_profiles (
  user_id uuid primary key references auth.users(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.account_admin_audit (
  operation_id uuid primary key,
  actor_id uuid not null references public.account_admin_profiles(user_id),
  subject_id uuid references public.customer_accounts(user_id),
  action text not null,
  reason text not null check(length(trim(reason)) between 10 and 500),
  detail jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index account_admin_audit_subject on public.account_admin_audit(subject_id,created_at desc);
create index account_admin_audit_actor on public.account_admin_audit(actor_id,created_at desc);
create table public.customer_workspace_profiles (
  user_id uuid primary key references public.customer_accounts(user_id),
  display_name text not null default '' check(length(display_name)<=80),
  updated_at timestamptz not null default now()
);
create table public.customer_context_documents (
  id uuid primary key,
  user_id uuid not null references public.customer_accounts(user_id),
  kind text not null check(kind in ('RESUME','JOB_DESCRIPTION','SUPPORTING','INSTRUCTIONS')),
  name text not null check(length(name) between 1 and 120),
  body text not null check(octet_length(body) between 1 and 120000),
  updated_at timestamptz not null default now(),
  unique(user_id,id)
);
create index customer_context_documents_owner on public.customer_context_documents(user_id,updated_at desc,id);
create table public.account_ai_models (
  model_id text primary key check(model_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$'),
  display_name text not null check(length(display_name) between 1 and 80),
  provider text not null check(provider in ('gemini','deepgram')),
  enabled boolean not null default false,
  is_default boolean not null default false,
  priority integer not null default 100 check(priority between 0 and 1000),
  capabilities text[] not null,
  health text not null default 'UNVERIFIED' check(health in ('UNVERIFIED','HEALTHY','DEGRADED','UNAVAILABLE')),
  updated_at timestamptz not null default now(),
  check(not is_default or enabled),
  check(capabilities <@ array['text','image','audio']::text[] and cardinality(capabilities)>0),
  check((provider='gemini' and capabilities <@ array['text','image']::text[])
    or (provider='deepgram' and capabilities=array['audio']::text[]))
);
create unique index account_ai_models_default on public.account_ai_models(provider) where is_default;
insert into public.account_ai_models(model_id,display_name,provider,enabled,is_default,capabilities)
 values('gemini-3.5-flash','Gemini 3.5 Flash','gemini',true,true,array['text','image']),
       ('flux-general-en','Live transcription','deepgram',true,true,array['audio']);

alter table public.account_admin_profiles enable row level security;
alter table public.account_admin_audit enable row level security;
alter table public.customer_workspace_profiles enable row level security;
alter table public.customer_context_documents enable row level security;
alter table public.account_ai_models enable row level security;
revoke all on public.account_admin_profiles,public.account_admin_audit,public.customer_workspace_profiles,
 public.customer_context_documents,public.account_ai_models from public,anon,authenticated,service_role;

create function public.account_audit_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='Account audit history is immutable'; end $$;
revoke all on function public.account_audit_immutable() from public,anon,authenticated,service_role;
create trigger account_audit_immutable before update or delete on public.account_admin_audit
 for each row execute function public.account_audit_immutable();

create function public.account_admin_check(p_actor uuid,p_session uuid,p_require_mfa boolean default true)
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.account_admin_profiles a join auth.users u on u.id=a.user_id
   join auth.sessions s on s.user_id=u.id where a.user_id=p_actor and a.active
   and u.email_confirmed_at is not null and s.id=p_session and (s.not_after is null or s.not_after>now())
   and (not p_require_mfa or s.aal::text='aal2'));
$$;
revoke all on function public.account_admin_check(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.account_admin_check(uuid,uuid,boolean) to service_role;

create function public.customer_workspace(p_user uuid,p_session uuid,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; balance jsonb; ident uuid; documents jsonb; plans jsonb; breakdown jsonb; sessions jsonb;
begin
 a:=public.customer_authorize(p_user,p_session); if a->>'code'<>'ACTIVE' then return a; end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 if (select state from public.customer_accounts where user_id=p_user)<>'ACTIVE' then return jsonb_build_object('code','SUSPENDED'); end if;
 if p_action='PROFILE' then
   if jsonb_typeof(p_input->'displayName')<>'string' or length(p_input->>'displayName')>80 then return jsonb_build_object('code','INVALID'); end if;
   insert into public.customer_workspace_profiles(user_id,display_name) values(p_user,trim(p_input->>'displayName'))
   on conflict(user_id) do update set display_name=excluded.display_name,updated_at=now();
 elsif p_action='SAVE_CONTEXT' then
   ident:=(p_input->>'id')::uuid;
   if ident is null or p_input->>'kind' not in ('RESUME','JOB_DESCRIPTION','SUPPORTING','INSTRUCTIONS')
     or jsonb_typeof(p_input->'name')<>'string' or length(p_input->>'name') not between 1 and 120
     or jsonb_typeof(p_input->'body')<>'string' or octet_length(p_input->>'body') not between 1 and 120000 then
     return jsonb_build_object('code','INVALID'); end if;
   if exists(select 1 from public.customer_context_documents where id=ident and user_id<>p_user) then return jsonb_build_object('code','FORBIDDEN'); end if;
   if (select count(*) from public.customer_context_documents where user_id=p_user and id<>ident)>=20 then return jsonb_build_object('code','CAPACITY'); end if;
   insert into public.customer_context_documents(id,user_id,kind,name,body) values(ident,p_user,p_input->>'kind',p_input->>'name',p_input->>'body')
   on conflict(id) do update set kind=excluded.kind,name=excluded.name,body=excluded.body,updated_at=now()
   where customer_context_documents.user_id=p_user;
 elsif p_action='DELETE_CONTEXT' then
   delete from public.customer_context_documents where user_id=p_user and id=(p_input->>'id')::uuid;
 elsif p_action<>'READ' then return jsonb_build_object('code','INVALID'); end if;
 balance:=public.customer_usage_balance(p_user,p_session);
 if balance->>'code'<>'ACTIVE' then return balance; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'name',name,'bytes',octet_length(body),'updatedAt',updated_at) order by updated_at desc),'[]')
 into documents from public.customer_context_documents where user_id=p_user;
 select coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'state',t.state,'endsAt',t.ends_at,'remainingMilliseconds',t.remaining_ms,
   'paymentState',s.state,'cancelFuture',s.cancel_future,'graceUntil',s.grace_until)),'[]') into plans
 from (select * from public.customer_recurring_terms where user_id=p_user order by created_at desc limit 30) t
 join public.customer_recurring_subscriptions s on s.subscription_id=t.subscription_id;
 select coalesce(jsonb_object_agg(kind,amount),'{}') into breakdown from (
   select kind,sum(greatest(0,granted_ms-spent_ms-reserved_ms)) amount from public.customer_usage_grants
   where user_id=p_user and state='ACTIVE' and starts_at<=now() and (expires_at is null or expires_at>now()) group by kind) g;
 select coalesce(jsonb_agg(jsonb_build_object('startedAt',created_at,'state',state)),'[]') into sessions
 from (select created_at,state from public.customer_usage_runs where user_id=p_user order by created_at desc limit 20) r;
 return jsonb_build_object('code','ACTIVE','balance',balance,'balances',breakdown,'plans',plans,'sessions',sessions,
   'displayName',coalesce((select display_name from public.customer_workspace_profiles where user_id=p_user),''),'documents',documents);
end $$;
revoke all on function public.customer_workspace(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.customer_workspace(uuid,uuid,text,jsonb) to service_role;

create function public.account_models_read() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('modelId',model_id,'displayName',display_name,'provider',provider,
  'enabled',enabled,'isDefault',is_default,'priority',priority,'capabilities',capabilities,'health',health) order by priority,model_id),'[]')
 from public.account_ai_models;
$$;
revoke all on function public.account_models_read() from public,anon,authenticated;
grant execute on function public.account_models_read() to service_role;

create function public.account_admin_read(p_actor uuid,p_session uuid,p_subject uuid default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare users jsonb; audit jsonb; grants jsonb;
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('userId',a.user_id,'email',u.email,'state',a.state,'createdAt',a.created_at)),'[]') into users
 from (select * from public.customer_accounts where p_subject is null or user_id=p_subject order by created_at desc limit 100) a join auth.users u on u.id=a.user_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',operation_id,'actor',actor_id,'subject',subject_id,'action',action,'reason',reason,'detail',detail,'createdAt',created_at)),'[]') into audit
 from (select * from public.account_admin_audit where p_subject is null or subject_id=p_subject order by created_at desc limit 100) x;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'state',state,'grantedMilliseconds',granted_ms,'spentMilliseconds',spent_ms,
   'reservedMilliseconds',reserved_ms,'expiresAt',expires_at,'testGrant',source_key like 'admin-test:%')),'[]') into grants
 from public.customer_usage_grants where p_subject is not null and user_id=p_subject;
 return jsonb_build_object('code','ACTIVE','users',users,'audit',audit,'grants',grants,'models',public.account_models_read());
end $$;
revoke all on function public.account_admin_read(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.account_admin_read(uuid,uuid,uuid) to service_role;

create function public.account_admin_mutate(p_actor uuid,p_session uuid,p_operation uuid,p_subject uuid,p_action text,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit%rowtype; detail jsonb; ident uuid; n integer; at_time timestamptz:=clock_timestamp(); r record;
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_operation is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 or p_action is null or p_input is null then return jsonb_build_object('code','INVALID'); end if;
 -- Lock actor first to serialize idempotency; every account writer locks the subject before grants/runs.
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
   if prior.actor_id<>p_actor or prior.subject_id is distinct from p_subject or prior.action<>p_action or prior.reason<>trim(p_reason) or prior.detail->'input'<>p_input then return jsonb_build_object('code','CONFLICT'); end if;
   return jsonb_build_object('code','APPLIED');
 end if;
 if p_action='MODEL' then
   if p_subject is not null or p_input->>'provider' not in ('gemini','deepgram') then return jsonb_build_object('code','INVALID'); end if;
   -- Deepgram routing remains internal and fixed until another protocol adapter is explicitly supported.
   if p_input->>'provider'='deepgram' and p_input->>'modelId'<>'flux-general-en' then return jsonb_build_object('code','INVALID'); end if;
   perform pg_advisory_xact_lock(7918201);
   if not exists(select 1 from public.account_ai_models where model_id=p_input->>'modelId') and (select count(*) from public.account_ai_models)>=100 then return jsonb_build_object('code','CAPACITY'); end if;
   if exists(select 1 from public.account_ai_models where model_id=p_input->>'modelId' and provider<>p_input->>'provider') then return jsonb_build_object('code','CONFLICT'); end if;
   if (p_input->>'isDefault')::boolean then update public.account_ai_models set is_default=false where provider=p_input->>'provider'; end if;
   insert into public.account_ai_models(model_id,display_name,provider,enabled,is_default,priority,capabilities,health)
   values(p_input->>'modelId',p_input->>'displayName',p_input->>'provider',(p_input->>'enabled')::boolean,
     (p_input->>'isDefault')::boolean,(p_input->>'priority')::integer,array(select jsonb_array_elements_text(p_input->'capabilities')),p_input->>'health')
   on conflict(model_id) do update set display_name=excluded.display_name,enabled=excluded.enabled,is_default=excluded.is_default,
     priority=excluded.priority,capabilities=excluded.capabilities,health=excluded.health,updated_at=now()
   where account_ai_models.provider=excluded.provider;
   if not found then return jsonb_build_object('code','CONFLICT'); end if;
 else
   perform 1 from public.customer_accounts where user_id=p_subject for update;
   if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
   if p_action in ('SUSPEND','REACTIVATE') then
     if p_action='SUSPEND' then
       for r in select run_id,sequence from public.customer_usage_runs where user_id=p_subject and state='ACTIVE' loop
         perform public.customer_usage_settle(p_subject,r.run_id,r.sequence,at_time,'DENIED');
         update public.customer_usage_runs set state='DENIED',last_result=jsonb_build_object('code','DENIED') where user_id=p_subject and run_id=r.run_id;
       end loop;
     end if;
     update public.customer_accounts set state=case p_action when 'SUSPEND' then 'SUSPENDED' else 'ACTIVE' end where user_id=p_subject;
   elsif p_action='GRANT_TEST' then
     n:=(p_input->>'minutes')::integer;
     if n is null or n not between 1 and 6000 or p_input->>'environment' is distinct from 'account-staging' then return jsonb_build_object('code','INVALID'); end if;
     insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at)
       values(p_subject,'admin-test:'||p_operation,'RECURRING',n::bigint*60000,at_time,at_time+interval '7 days') returning id into ident;
   elsif p_action='REVOKE_TEST' then
     ident:=(p_input->>'grantId')::uuid;
     if not exists(select 1 from public.customer_usage_grants where id=ident and user_id=p_subject and source_key like 'admin-test:%') then return jsonb_build_object('code','NOT_FOUND'); end if;
     perform public.customer_recurring_stop_grant(p_subject,ident,at_time);
     update public.customer_usage_grants set state='REVOKED' where id=ident and user_id=p_subject;
   else return jsonb_build_object('code','INVALID'); end if;
 end if;
 detail:=jsonb_build_object('input',p_input,'grantId',ident);
 insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
   values(p_operation,p_actor,p_subject,p_action,trim(p_reason),detail);
 return jsonb_build_object('code','APPLIED');
end $$;
revoke all on function public.account_admin_mutate(uuid,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_admin_mutate(uuid,uuid,uuid,uuid,text,text,jsonb) to service_role;
