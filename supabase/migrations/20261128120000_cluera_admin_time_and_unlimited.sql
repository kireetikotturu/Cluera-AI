-- Admin time controls that work, unlimited access, and one account on several devices.
--
-- 1. Time added by Admin counts. billing_mode marked every grant that was not a real Razorpay payment as 'test', so
--    with the live billing bank the usage engine and balances ignored all Admin-added minutes. Admin grants
--    ('admin-*') are now 'shared', like the free trial: they count in either bank. Test purchases stay 'test'.
-- 2. Unlimited access, given only by Admin (never sold): an 'UNLIMITED' grant for a day, week, month, 3 months, a year,
--    or with no end. It is used first, so bought time stays saved. Removing it, or it running out, moves a running
--    session onto the remaining time instead of ending it. Existing apps keep working: time left includes the time the
--    unlimited access has left (9999 hours when it has no end), and the relay sees the same allocation names as before.
-- 3. Reducing time takes only from time that counts. Admin views and the website breakdown show only time that counts.
-- 4. An administrator cannot block their own account (that would lock them out of Admin).
-- 5. Request limits may be set above 120 per 15 minutes. The signed-in app's requests are counted per network address,
--    which every device on one Wi-Fi shares (and the saved documents are read before each answer), so the website
--    raises that ceiling.
--
-- Existing functions are patched in place; every patch stops the migration if the text it expects has changed.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create function pg_temp.cluera_patch(p_function regprocedure,p_old text,p_new text,p_times integer default 1) returns void
language plpgsql as $patch$
declare d text; matches integer;
begin
 d:=pg_get_functiondef(p_function);
 matches:=(length(d)-length(replace(d,p_old,'')))/length(p_old);
 if matches<>p_times then raise exception '% changed: % matches of "%", expected %. Review before patching.',
  p_function,matches,left(p_old,80),p_times; end if;
 execute replace(d,p_old,p_new);
end $patch$;

-- 1. Admin-provided time counts in every billing bank.
alter table public.customer_usage_grants alter column billing_mode set expression as(
 case when kind='TRIAL' and source_key='lifetime-trial' then 'shared'
  when source_key like 'admin-%' then 'shared'
  when source_key like 'razorpay-live:%' or source_key like 'razorpay-live-invoice:%' then 'live'
  else 'test' end);

-- 2. The unlimited kind: Admin only, with or without an end.
do $$begin
 if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.customer_usage_grants'::regclass
   and conname='customer_usage_grants_check2') not like '%RECURRING%' then
  raise exception 'The expiry rule changed. Review before patching.';
 end if;
end$$;
alter table public.customer_usage_grants drop constraint customer_usage_grants_kind_check;
alter table public.customer_usage_grants drop constraint customer_usage_grants_check2;
alter table public.customer_usage_grants
 add constraint customer_usage_grants_kind_check check (kind in ('TRIAL','RECURRING','PACK','UNLIMITED')),
 add constraint customer_usage_grants_expiry_check check (
  case kind when 'RECURRING' then expires_at is not null when 'UNLIMITED' then true else expires_at is null end),
 add constraint customer_usage_grants_unlimited_check check (kind<>'UNLIMITED' or source_key like 'admin-unlimited:%');

-- The unlimited access in force at a moment (no end first, then the latest end).
create function public.cluera_unlimited_at(p_user uuid,p_at timestamptz) returns setof public.customer_usage_grants
language sql stable security definer set search_path='' as $$
 select * from public.customer_usage_grants where user_id=p_user and kind='UNLIMITED' and state='ACTIVE'
  and starts_at<=p_at and (expires_at is null or expires_at>p_at)
 order by expires_at desc nulls first,starts_at desc,id limit 1
$$;
-- What an app that knows nothing about unlimited access adds to "time left".
create function public.cluera_unlimited_compat_ms(p_user uuid,p_at timestamptz) returns bigint
language sql stable security definer set search_path='' as $$
 select coalesce((select case when g.expires_at is null then 35996400000
   else greatest(0,floor(extract(epoch from (g.expires_at-p_at))*1000))::bigint end
  from public.cluera_unlimited_at(p_user,p_at) g),0)
$$;
-- For the website and apps: null, or when the unlimited access ends (null: it has no end).
create function public.cluera_unlimited_status(p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('endsAt',g.expires_at,'startedAt',g.starts_at,
   'compatibleMilliseconds',public.cluera_unlimited_compat_ms(p_user,statement_timestamp()))
 from public.cluera_unlimited_at(p_user,statement_timestamp()) g
$$;
revoke all on function public.cluera_unlimited_at(uuid,timestamptz),public.cluera_unlimited_compat_ms(uuid,timestamptz),
 public.cluera_unlimited_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.cluera_unlimited_status(uuid) to service_role;

-- Usage: unlimited access is used first (except in its last 5 seconds, so a running session moves on smoothly), and
-- ending or removing it moves the session to the remaining time instead of denying it.
select pg_temp.cluera_patch('public.customer_usage_command_base(uuid,uuid,uuid,integer,text)',
 $o$if g.billing_mode not in('shared',cluera_billing_runtime_private.bank()) or g.state<>'ACTIVE' or (g.expires_at is not null and g.expires_at<=t) then$o$,
 $n$if g.kind<>'UNLIMITED' and (g.billing_mode not in('shared',cluera_billing_runtime_private.bank()) or g.state<>'ACTIVE' or (g.expires_at is not null and g.expires_at<=t)) then$n$);
select pg_temp.cluera_patch('public.customer_usage_command_base(uuid,uuid,uuid,integer,text)',
 $o$order by case kind when 'RECURRING' then 0 when 'PACK' then 1 else 2 end,$o$,
 $n$order by case when kind='UNLIMITED' then case when expires_at is null or expires_at>=t+interval '5 seconds' then 0 else 4 end
      when kind='RECURRING' then 1 when kind='PACK' then 2 else 3 end,$n$);
select pg_temp.cluera_patch('public.customer_usage_command_base(uuid,uuid,uuid,integer,text)',
 $o$'allocation',g.kind);$o$,
 $n$'allocation',case g.kind when 'UNLIMITED' then 'PACK' else g.kind end);$n$);

-- Balances: the same fields as before; unlimited access counts as the time it has left.
select pg_temp.cluera_patch('public.customer_usage_balance_base(uuid,uuid)',
 $o$then granted_ms-spent_ms-reserved_ms else 0 end),0)$o$,
 $n$then granted_ms-spent_ms-reserved_ms else 0 end) filter (where kind<>'UNLIMITED'),0)
      +public.cluera_unlimited_compat_ms(p_user_id,t)$n$);
select pg_temp.cluera_patch('public.customer_credits_read_paddle_base(uuid,uuid)',
 $o$where user_id=p_user and billing_mode in('shared',cluera_billing_runtime_private.bank()) and state='ACTIVE' and starts_at<=t and (expires_at is null or expires_at>t)$o$,
 $n$where user_id=p_user and billing_mode in('shared',cluera_billing_runtime_private.bank()) and kind<>'UNLIMITED' and state='ACTIVE' and starts_at<=t and (expires_at is null or expires_at>t)$n$);
-- 3. The website's "where your time comes from" shows only time that counts.
select pg_temp.cluera_patch('public.customer_workspace(uuid,uuid,text,jsonb)',
 $o$where user_id=p_user and state='ACTIVE' and starts_at<=now() and (expires_at is null or expires_at>now()) group by kind) g;$o$,
 $n$where user_id=p_user and billing_mode in('shared',cluera_billing_runtime_private.bank()) and kind<>'UNLIMITED' and state='ACTIVE' and starts_at<=now() and (expires_at is null or expires_at>now()) group by kind) g;$n$);

-- Reducing time takes only from time that counts and never from unlimited access.
select pg_temp.cluera_patch('public.account_admin_adjust(uuid,uuid,uuid,uuid,text,text,jsonb)',
 $o$user_id=p_subject and kind<>'TRIAL' and state in ('ACTIVE','PAUSED')$o$,
 $n$user_id=p_subject and kind not in ('TRIAL','UNLIMITED') and billing_mode in('shared',cluera_billing_runtime_private.bank()) and state in ('ACTIVE','PAUSED')$n$,3);
select pg_temp.cluera_patch('public.account_admin_adjust(uuid,uuid,uuid,uuid,text,text,jsonb)',
 $o$if g.kind='TRIAL' or g.state not in ('ACTIVE','PAUSED')$o$,
 $n$if g.kind in ('TRIAL','UNLIMITED') or g.state not in ('ACTIVE','PAUSED')$n$);

-- 4. No self-blocking; give or remove unlimited access.
select pg_temp.cluera_patch('public.account_admin_mutate(uuid,uuid,uuid,uuid,text,text,jsonb)',
 $o$for r in select run_id,sequence from public.customer_usage_runs where user_id=p_subject and state='ACTIVE' loop$o$,
 $n$if p_subject=p_actor then return jsonb_build_object('code','INVALID'); end if;
       for r in select run_id,sequence from public.customer_usage_runs where user_id=p_subject and state='ACTIVE' loop$n$);
select pg_temp.cluera_patch('public.account_admin_mutate(uuid,uuid,uuid,uuid,text,text,jsonb)',
 $o$elsif p_action='GRANT_TEST' then$o$,
 $n$elsif p_action='GRANT_UNLIMITED' then
     if p_input-'duration'<>'{}'::jsonb or coalesce(p_input->>'duration','') not in ('DAY','WEEK','MONTH','QUARTER','YEAR','FOREVER') then
       return jsonb_build_object('code','INVALID'); end if;
     -- One at a time: new unlimited access replaces what is left of the old one.
     update public.customer_usage_grants set state='REVOKED' where user_id=p_subject and kind='UNLIMITED' and state<>'REVOKED';
     insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at)
       values(p_subject,'admin-unlimited:'||p_operation,'UNLIMITED',315360000000000,at_time,
         case p_input->>'duration' when 'DAY' then at_time+interval '1 day' when 'WEEK' then at_time+interval '7 days'
           when 'MONTH' then at_time+interval '1 month' when 'QUARTER' then at_time+interval '3 months'
           when 'YEAR' then at_time+interval '1 year' else null end) returning id into ident;
   elsif p_action='REVOKE_UNLIMITED' then
     if p_input<>'{}'::jsonb then return jsonb_build_object('code','INVALID'); end if;
     update public.customer_usage_grants set state='REVOKED' where user_id=p_subject and kind='UNLIMITED' and state='ACTIVE'
       and (expires_at is null or expires_at>at_time);
     if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
   elsif p_action='GRANT_TEST' then$n$);

-- The Admin customer screen: who has unlimited access, balances that count, and which grants count.
select pg_temp.cluera_patch('public.account_admin_read_v2(uuid,uuid,uuid,text,timestamptz,uuid)',
 $o$'state',a.state,'createdAt',a.created_at) order by$o$,
 $n$'state',a.state,'createdAt',a.created_at,'unlimited',public.cluera_unlimited_status(a.user_id)) order by$n$);
select pg_temp.cluera_patch('public.account_admin_read_v2(uuid,uuid,uuid,text,timestamptz,uuid)',
 $o$from public.customer_usage_grants where user_id=p_subject and state='ACTIVE' and starts_at<=clock_timestamp()$o$,
 $n$from public.customer_usage_grants where user_id=p_subject and billing_mode in('shared',cluera_billing_runtime_private.bank())
      and kind<>'UNLIMITED' and state='ACTIVE' and starts_at<=clock_timestamp()$n$);
select pg_temp.cluera_patch('public.account_admin_read_v2(uuid,uuid,uuid,text,timestamptz,uuid)',
 $o$'adminAdjustment',source_key like 'admin-adjustment:%')$o$,
 $n$'adminAdjustment',source_key like 'admin-adjustment:%','counted',billing_mode in('shared',cluera_billing_runtime_private.bank()))$n$);

-- 5. Larger request limits for the signed-in app on a shared network.
select pg_temp.cluera_patch('public.customer_auth_rate_limit(text,integer)',
 $o$p_maximum > 120 then return false$o$, $n$p_maximum > 5000 then return false$n$);
select pg_temp.cluera_patch('public.customer_auth_rate_limit(text,integer)',
 $o$least(customer_request_limits.hits + 1, 121)$o$, $n$least(customer_request_limits.hits + 1, 5001)$n$);

drop function pg_temp.cluera_patch(regprocedure,text,text,integer);
commit;
