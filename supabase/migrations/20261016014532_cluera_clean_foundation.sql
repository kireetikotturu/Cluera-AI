-- NEW CLEAN CLUERA FOUNDATION: target yhnqlfcgrmckhyjdxegg, Mumbai.
-- No identity/history import, external financial handoff, provider/payment activation or scheduler dispatch.
-- Exactly pinned sources; old frozen proposals remain unchanged. Connector project identity MUST independently match.

do $$begin
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p'))
 or to_regnamespace('billing_private') is not null or to_regnamespace('cluera_billing_private') is not null or to_regnamespace('cluera_private') is not null
 or exists(select 1 from auth.users) or exists(select 1 from auth.identities) or exists(select 1 from auth.sessions)
 then raise exception 'Clean empty destination prerequisite failed';end if;
end$$;
create schema billing_private;
revoke all on schema billing_private from public,anon,authenticated,service_role;

-- SOURCE supabase/migrations/20261004024730_customer_account_foundation.sql SHA256 65baaf42f3f7389641d5cde6ec7d80fc5bac5b9ac2a51ab696b33b5ae96b4c23
-- Account foundation only. No legacy rows are deleted and no payment entitlement is granted.
-- BFF-only access: browser roles receive neither table access nor RPC execution.
create table public.customer_accounts (
  user_id uuid primary key references auth.users(id),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz not null default now()
);
create table public.customer_trial_grants (
  user_id uuid primary key references public.customer_accounts(user_id),
  granted_seconds integer not null default 900 check (granted_seconds = 900),
  created_at timestamptz not null default now()
);
create table public.customer_request_limits (
  bucket_hash text primary key check (bucket_hash ~ '^[a-f0-9]{64}$'),
  hits integer not null check (hits > 0),
  expires_at timestamptz not null
);
create index customer_request_limits_expiry on public.customer_request_limits(expires_at);
alter table public.customer_accounts enable row level security;
alter table public.customer_trial_grants enable row level security;
alter table public.customer_request_limits enable row level security;
revoke all on public.customer_accounts, public.customer_trial_grants, public.customer_request_limits
  from public, anon, authenticated, service_role;

-- Parameters come only from a server-verified Supabase user/token, never a browser body.
-- Checking auth.sessions prevents a logged-out access JWT from continuing until JWT expiry.
create function public.customer_authorize(p_user_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_state text;
begin
  if not exists(select 1 from auth.users u join auth.sessions s on s.user_id = u.id
    where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null
      and s.id = p_session_id and (s.not_after is null or s.not_after > now())) then
    return jsonb_build_object('code', 'UNAUTHENTICATED');
  end if;
  select state into account_state from public.customer_accounts where user_id = p_user_id;
  if not found then
    insert into public.customer_accounts(user_id) values(p_user_id) on conflict do nothing;
    select state into account_state from public.customer_accounts where user_id = p_user_id;
  end if;
  if account_state <> 'ACTIVE' then return jsonb_build_object('code', 'SUSPENDED'); end if;
  -- At most one forever per Auth UUID; sign-in, password recovery and linked Google
  -- identities cannot replenish it. No periodic renewal or client-provided amount.
  if not exists(select 1 from public.customer_trial_grants where user_id = p_user_id) then
    insert into public.customer_trial_grants(user_id) values(p_user_id) on conflict do nothing;
  end if;
  return jsonb_build_object('code', 'ACTIVE', 'userId', p_user_id,
    'trialSecondsGranted', 900, 'remoteDesktop', false);
end $$;

create function public.customer_auth_rate_limit(p_bucket_hash text, p_maximum integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare total integer;
begin
  if p_bucket_hash is null or p_bucket_hash !~ '^[a-f0-9]{64}$'
    or p_maximum is null or p_maximum < 1 or p_maximum > 120 then return false; end if;
  insert into public.customer_request_limits(bucket_hash, hits, expires_at)
    values(p_bucket_hash, 1, now() + interval '15 minutes')
    on conflict (bucket_hash) do update set
      hits = case when customer_request_limits.expires_at <= now() then 1
                  else least(customer_request_limits.hits + 1, 121) end,
      expires_at = case when customer_request_limits.expires_at <= now()
                        then now() + interval '15 minutes' else customer_request_limits.expires_at end
    returning hits into total;
  return total <= p_maximum;
end $$;
revoke all on function public.customer_authorize(uuid,uuid) from public, anon, authenticated;
revoke all on function public.customer_auth_rate_limit(text,integer) from public, anon, authenticated;
grant execute on function public.customer_authorize(uuid,uuid) to service_role;
grant execute on function public.customer_auth_rate_limit(text,integer) to service_role;

-- SOURCE supabase/migrations/20261004025407_paddle_sandbox_inbox.sql SHA256 726ffc2033d7881ec33d1e1dd251a0c2e46b78b5492a22a7bf68e64779230ea5
-- Durable intake only: no purchases, balances or paid entitlement are granted here.
create table public.paddle_sandbox_events (
  event_id text primary key check (event_id ~ '^evt_[a-z0-9]{26}$'),
  event_type text not null check (event_type ~ '^(transaction|subscription|adjustment)\.[a-z_]{1,48}$'),
  occurred_at timestamptz not null,
  resource_id text not null check (resource_id ~ '^(txn|sub|adj)_[a-z0-9]{26}$'),
  event_digest text not null check (event_digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null default now(),
  state text not null default 'PENDING' check (state in ('PENDING','CONFLICT')),
  check ((split_part(event_type,'.',1)='transaction' and resource_id like 'txn_%')
      or (split_part(event_type,'.',1)='subscription' and resource_id like 'sub_%')
      or (split_part(event_type,'.',1)='adjustment' and resource_id like 'adj_%'))
);
create index paddle_sandbox_pending on public.paddle_sandbox_events(received_at,event_id) where state='PENDING';
alter table public.paddle_sandbox_events enable row level security;
revoke all on public.paddle_sandbox_events from public,anon,authenticated,service_role;

-- Inputs are a narrow projection from a raw-signature-verified server request.
-- UNIQUE event_id handles parallel deliveries. A changed event is quarantined,
-- never overwritten or interpreted as a second payment. No PII/payload is stored.
create function public.paddle_sandbox_receive(p_event_id text,p_event_type text,
  p_occurred_at timestamptz,p_resource_id text,p_event_digest text)
returns text language plpgsql security definer set search_path='' as $$
declare existing public.paddle_sandbox_events%rowtype;
begin
  if p_event_id is null or p_event_id !~ '^evt_[a-z0-9]{26}$'
    or p_event_type is null or p_event_type !~ '^(transaction|subscription|adjustment)\.[a-z_]{1,48}$'
    or p_occurred_at is null or not isfinite(p_occurred_at)
    or p_resource_id is null or p_resource_id !~ '^(txn|sub|adj)_[a-z0-9]{26}$'
    or p_event_digest is null or p_event_digest !~ '^[a-f0-9]{64}$'
    or not ((split_part(p_event_type,'.',1)='transaction' and p_resource_id like 'txn_%')
      or (split_part(p_event_type,'.',1)='subscription' and p_resource_id like 'sub_%')
      or (split_part(p_event_type,'.',1)='adjustment' and p_resource_id like 'adj_%')) then
    raise exception using errcode='22023',message='Invalid billing event envelope';
  end if;
  insert into public.paddle_sandbox_events(event_id,event_type,occurred_at,resource_id,event_digest)
    values(p_event_id,p_event_type,p_occurred_at,p_resource_id,p_event_digest) on conflict do nothing;
  if found then return 'STORED'; end if;
  select * into existing from public.paddle_sandbox_events where event_id=p_event_id for update;
  if existing.state='CONFLICT' then return 'CONFLICT'; end if;
  if existing.event_type<>p_event_type or existing.occurred_at<>p_occurred_at
    or existing.resource_id<>p_resource_id or existing.event_digest<>p_event_digest then
    update public.paddle_sandbox_events set state='CONFLICT' where event_id=p_event_id;
    return 'CONFLICT';
  end if;
  return 'DUPLICATE';
end $$;
revoke all on function public.paddle_sandbox_receive(text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.paddle_sandbox_receive(text,text,timestamptz,text,text) to service_role;

-- SOURCE supabase/migrations/20261004061853_paddle_simulation_receipts.sql SHA256 9ab2afa2061ec325576320a1198a58c87924c457ba705a55dfd0718512c43f99
-- Simulator-only receipts. Never enter the real sandbox billing inbox or grant usage.
-- Additive: existing event table, RPC and permissions are unchanged.
create table public.paddle_sandbox_simulations (
  event_id text primary key check (event_id ~ '^ntfsimevt_[a-z0-9]{26}$'),
  event_type text not null check (event_type ~ '^(transaction|subscription|adjustment)\.[a-z_]{1,48}$'),
  occurred_at timestamptz not null,
  resource_id text not null check (resource_id ~ '^(txn|sub|adj)_[a-z0-9]{26}$'),
  event_digest text not null check (event_digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null default now(),
  state text not null default 'RECEIVED' check (state in ('RECEIVED','CONFLICT')),
  check ((split_part(event_type,'.',1)='transaction' and resource_id like 'txn_%')
      or (split_part(event_type,'.',1)='subscription' and resource_id like 'sub_%')
      or (split_part(event_type,'.',1)='adjustment' and resource_id like 'adj_%'))
);
alter table public.paddle_sandbox_simulations enable row level security;
revoke all on public.paddle_sandbox_simulations from public,anon,authenticated,service_role;

-- Inputs are a narrow projection from a raw-signature-verified server request.
-- UNIQUE event_id handles parallel deliveries. A changed event is quarantined,
-- never overwritten or interpreted as a second payment. No PII/payload is stored.
create function public.paddle_sandbox_receive_simulation(p_event_id text,p_event_type text,
  p_occurred_at timestamptz,p_resource_id text,p_event_digest text)
returns text language plpgsql security definer set search_path='' as $$
declare existing public.paddle_sandbox_simulations%rowtype;
begin
  if p_event_id is null or p_event_id !~ '^ntfsimevt_[a-z0-9]{26}$'
    or p_event_type is null or p_event_type !~ '^(transaction|subscription|adjustment)\.[a-z_]{1,48}$'
    or p_occurred_at is null or not isfinite(p_occurred_at)
    or p_resource_id is null or p_resource_id !~ '^(txn|sub|adj)_[a-z0-9]{26}$'
    or p_event_digest is null or p_event_digest !~ '^[a-f0-9]{64}$'
    or not ((split_part(p_event_type,'.',1)='transaction' and p_resource_id like 'txn_%')
      or (split_part(p_event_type,'.',1)='subscription' and p_resource_id like 'sub_%')
      or (split_part(p_event_type,'.',1)='adjustment' and p_resource_id like 'adj_%')) then
    raise exception using errcode='22023',message='Invalid billing event envelope';
  end if;
  insert into public.paddle_sandbox_simulations(event_id,event_type,occurred_at,resource_id,event_digest)
    values(p_event_id,p_event_type,p_occurred_at,p_resource_id,p_event_digest) on conflict do nothing;
  if found then return 'STORED'; end if;
  select * into existing from public.paddle_sandbox_simulations where event_id=p_event_id for update;
  if existing.state='CONFLICT' then return 'CONFLICT'; end if;
  if existing.event_type<>p_event_type or existing.occurred_at<>p_occurred_at
    or existing.resource_id<>p_resource_id or existing.event_digest<>p_event_digest then
    update public.paddle_sandbox_simulations set state='CONFLICT' where event_id=p_event_id;
    return 'CONFLICT';
  end if;
  return 'DUPLICATE';
end $$;
revoke all on function public.paddle_sandbox_receive_simulation(text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.paddle_sandbox_receive_simulation(text,text,timestamptz,text,text) to service_role;

-- SOURCE supabase/migrations/20261004064105_shared_usage_reservations.sql SHA256 1c571042be638c57624087458c309be6846705fb25ac333aff1d9a0e6d7eb8c9
-- Staging account usage foundation. No checkout/paid grant writer or legacy cutover.
-- Lock order for every future billing writer: account, then that account's grants/runs.
create table public.customer_usage_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.customer_accounts(user_id),
  source_key text not null check (length(source_key) between 1 and 160),
  kind text not null check (kind in ('TRIAL','RECURRING','PACK')),
  state text not null default 'ACTIVE' check (state in ('ACTIVE','PAUSED','REVOKED')),
  granted_ms bigint not null check (granted_ms > 0),
  spent_ms bigint not null default 0 check (spent_ms >= 0),
  reserved_ms bigint not null default 0 check (reserved_ms >= 0),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  unique(user_id,source_key), unique(user_id,id),
  check (spent_ms + reserved_ms <= granted_ms),
  check (isfinite(starts_at) and (expires_at is null or (isfinite(expires_at) and expires_at > starts_at))),
  check ((kind='RECURRING' and expires_at is not null) or (kind<>'RECURRING' and expires_at is null)),
  check (kind<>'TRIAL' or (source_key='lifetime-trial' and granted_ms=900000))
);
create index customer_usage_grants_available on public.customer_usage_grants(user_id,kind,expires_at,id)
  where state='ACTIVE';
create table public.customer_usage_runs (
  user_id uuid not null references public.customer_accounts(user_id),
  run_id uuid not null,
  auth_session_id uuid not null,
  state text not null check (state in ('ACTIVE','CLOSED','EXPIRED','EXHAUSTED','DENIED')),
  sequence integer not null check (sequence between 0 and 1000000000),
  last_action text not null check (last_action in ('START','CHECKPOINT','STOP')),
  last_result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,run_id)
);
create index customer_usage_active_runs on public.customer_usage_runs(user_id,run_id) where state='ACTIVE';
-- Reservation and settlement rows are append-only through the application API.
-- Browser/service roles have no direct table privileges; no RPC updates/deletes them.
create table public.customer_usage_windows (
  user_id uuid not null,
  run_id uuid not null,
  sequence integer not null,
  grant_id uuid not null,
  reserved_ms integer not null check (reserved_ms between 1 and 30000),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  primary key(user_id,run_id,sequence),
  foreign key(user_id,run_id) references public.customer_usage_runs(user_id,run_id),
  foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
  check (isfinite(starts_at) and expires_at=starts_at+reserved_ms*interval '1 millisecond')
);
create index customer_usage_windows_grant on public.customer_usage_windows(user_id,grant_id);
create table public.customer_usage_settlements (
  user_id uuid not null,
  run_id uuid not null,
  sequence integer not null,
  spent_ms integer not null check (spent_ms between 0 and 30000),
  released_ms integer not null check (released_ms between 0 and 30000),
  reason text not null check (reason in ('CHECKPOINT','STOP','EXPIRED','DENIED')),
  created_at timestamptz not null default now(),
  primary key(user_id,run_id,sequence),
  foreign key(user_id,run_id,sequence) references public.customer_usage_windows(user_id,run_id,sequence),
  check (spent_ms+released_ms between 1 and 30000)
);
alter table public.customer_usage_grants enable row level security;
alter table public.customer_usage_runs enable row level security;
alter table public.customer_usage_windows enable row level security;
alter table public.customer_usage_settlements enable row level security;
revoke all on public.customer_usage_grants,public.customer_usage_runs,
  public.customer_usage_windows,public.customer_usage_settlements from public,anon,authenticated,service_role;

-- Internal helper: caller must already own the account lock. Not callable via service API.
create function public.customer_usage_settle(p_user uuid,p_run uuid,p_sequence integer,p_at timestamptz,p_reason text)
returns void language plpgsql set search_path='' as $$
declare w public.customer_usage_windows%rowtype; used integer;
begin
  select * into strict w from public.customer_usage_windows
    where user_id=p_user and run_id=p_run and sequence=p_sequence;
  if exists(select 1 from public.customer_usage_settlements where user_id=p_user and run_id=p_run and sequence=p_sequence) then return; end if;
  used := least(w.reserved_ms,greatest(0,floor(extract(epoch from (p_at-w.starts_at))*1000)))::integer;
  update public.customer_usage_grants set reserved_ms=reserved_ms-w.reserved_ms,spent_ms=spent_ms+used
    where user_id=p_user and id=w.grant_id;
  insert into public.customer_usage_settlements(user_id,run_id,sequence,spent_ms,released_ms,reason)
    values(p_user,p_run,p_sequence,used,w.reserved_ms-used,p_reason);
end $$;
revoke all on function public.customer_usage_settle(uuid,uuid,integer,timestamptz,text) from public,anon,authenticated,service_role;

create function public.customer_usage_command(p_user_id uuid,p_session_id uuid,p_run_id uuid,p_sequence integer,p_action text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; t timestamptz; r public.customer_usage_runs%rowtype;
  w public.customer_usage_windows%rowtype; g public.customer_usage_grants%rowtype;
  stale record; amount integer; result jsonb; account_state text;
begin
  if p_user_id is null or p_session_id is null or p_run_id is null or p_sequence is null
    or p_sequence not between 0 and 1000000000 or p_action is null or p_action not in ('START','CHECKPOINT','STOP') then
    return jsonb_build_object('code','INVALID');
  end if;
  a := public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  select state into account_state from public.customer_accounts where user_id=p_user_id for update;
  t := date_trunc('milliseconds',clock_timestamp());
  if account_state<>'ACTIVE' then return jsonb_build_object('code','SUSPENDED'); end if;
  -- Recheck after waiting for the account lock; server time/session are authoritative.
  if not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
    where s.id=p_session_id and s.user_id=p_user_id and (s.not_after is null or s.not_after>t)
    and u.email is not null and u.email_confirmed_at is not null) then
    return jsonb_build_object('code','UNAUTHENTICATED');
  end if;
  -- Lazily materialize the existing once-ever grant, never an amount supplied by a client.
  insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms)
    select p_user_id,'lifetime-trial','TRIAL',granted_seconds::bigint*1000
    from public.customer_trial_grants where user_id=p_user_id
    on conflict(user_id,source_key) do nothing;
  -- Crash/disconnect: reserve at most 30 seconds; expired authorizations cannot be reused.
  -- Bounded to at most 32 simultaneously active runs; no global scan or cron required.
  for stale in select x.run_id,x.sequence from public.customer_usage_runs x
    join public.customer_usage_windows y on (y.user_id,y.run_id,y.sequence)=(x.user_id,x.run_id,x.sequence)
    where x.user_id=p_user_id and x.state='ACTIVE' and y.expires_at<=t
  loop
    perform public.customer_usage_settle(p_user_id,stale.run_id,stale.sequence,t,'EXPIRED');
    update public.customer_usage_runs set state='EXPIRED',last_result=jsonb_build_object('code','EXPIRED')
      where user_id=p_user_id and run_id=stale.run_id;
  end loop;
  select * into r from public.customer_usage_runs where user_id=p_user_id and run_id=p_run_id;
  if found then
    if r.auth_session_id<>p_session_id then return jsonb_build_object('code','FORBIDDEN'); end if;
    if r.state='ACTIVE' then
      select * into strict w from public.customer_usage_windows where user_id=p_user_id and run_id=p_run_id and sequence=r.sequence;
      select * into strict g from public.customer_usage_grants where user_id=p_user_id and id=w.grant_id;
      if g.state<>'ACTIVE' or (g.expires_at is not null and g.expires_at<=t) then
        perform public.customer_usage_settle(p_user_id,p_run_id,r.sequence,t,'DENIED');
        update public.customer_usage_runs set state='DENIED',last_result=jsonb_build_object('code','DENIED')
          where user_id=p_user_id and run_id=p_run_id;
        return jsonb_build_object('code','DENIED');
      end if;
    end if;
    if r.state in ('EXPIRED','DENIED') then return r.last_result; end if;
    if p_sequence=r.sequence and p_action=r.last_action then
      -- A retry cannot extend authorization: current server time, unchanged expiry.
      if r.state='ACTIVE' then return r.last_result||jsonb_build_object('serverTime',t); end if;
      return r.last_result;
    end if;
    if r.state<>'ACTIVE' or p_action='START' or p_sequence<>r.sequence+1 then return jsonb_build_object('code','STALE'); end if;
    if p_action='CHECKPOINT' and t<w.starts_at+interval '10 seconds' and t<w.expires_at-interval '10 seconds' then
      return jsonb_build_object('code','TOO_EARLY','retryAt',w.starts_at+interval '10 seconds');
    end if;
    perform public.customer_usage_settle(p_user_id,p_run_id,r.sequence,t,p_action);
    if p_action='STOP' then
      result:=jsonb_build_object('code','CLOSED','sequence',p_sequence);
      update public.customer_usage_runs set state='CLOSED',sequence=p_sequence,last_action=p_action,last_result=result
        where user_id=p_user_id and run_id=p_run_id;
      return result;
    end if;
  else
    if p_action<>'START' or p_sequence<>0 then return jsonb_build_object('code','NOT_FOUND'); end if;
    if (select count(*) from public.customer_usage_runs where user_id=p_user_id and state='ACTIVE')>=32 then
      return jsonb_build_object('code','CAPACITY');
    end if;
    insert into public.customer_usage_runs(user_id,run_id,auth_session_id,state,sequence,last_action,last_result)
      values(p_user_id,p_run_id,p_session_id,'ACTIVE',0,'START','{}');
  end if;
  -- Recurring before packs; lifetime trial is the final fallback. Expired/paused/refunded
  -- allocations are ineligible. One bucket/window keeps settlement attribution exact.
  select * into g from public.customer_usage_grants
    where user_id=p_user_id and state='ACTIVE' and starts_at<=t
      and (expires_at is null or expires_at>=t+interval '1 millisecond')
      and granted_ms-spent_ms-reserved_ms>0
    order by case kind when 'RECURRING' then 0 when 'PACK' then 1 else 2 end,
      expires_at nulls last,starts_at,id limit 1;
  if not found then
    result:=jsonb_build_object('code','EXHAUSTED','sequence',p_sequence);
    update public.customer_usage_runs set state='EXHAUSTED',sequence=p_sequence,last_action=p_action,last_result=result
      where user_id=p_user_id and run_id=p_run_id;
    return result;
  end if;
  amount:=least(30000,g.granted_ms-g.spent_ms-g.reserved_ms,
    case when g.expires_at is null then 30000 else floor(extract(epoch from (g.expires_at-t))*1000)::bigint end)::integer;
  update public.customer_usage_grants set reserved_ms=reserved_ms+amount where id=g.id;
  insert into public.customer_usage_windows(user_id,run_id,sequence,grant_id,reserved_ms,starts_at,expires_at)
    values(p_user_id,p_run_id,p_sequence,g.id,amount,t,t+amount*interval '1 millisecond');
  result:=jsonb_build_object('code','ACTIVE','runId',p_run_id,'sequence',p_sequence,
    'serverTime',t,'expiresAt',t+amount*interval '1 millisecond','reservedMilliseconds',amount,'allocation',g.kind);
  update public.customer_usage_runs set state='ACTIVE',sequence=p_sequence,last_action=p_action,last_result=result
    where user_id=p_user_id and run_id=p_run_id;
  return result;
end $$;
revoke all on function public.customer_usage_command(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.customer_usage_command(uuid,uuid,uuid,integer,text) to service_role;

-- Dashboard reads never reserve/debit usage. Expired windows remain reserved until
-- the next usage command settles them; read-only reporting does not renew anything.
create function public.customer_usage_balance(p_user_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; t timestamptz:=clock_timestamp(); result jsonb;
begin
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  select jsonb_build_object('code','ACTIVE','spentMilliseconds',coalesce(sum(spent_ms),0),
    'reservedMilliseconds',coalesce(sum(reserved_ms),0),
    'availableMilliseconds',coalesce(sum(case when state='ACTIVE' and starts_at<=t and (expires_at is null or expires_at>t)
      then granted_ms-spent_ms-reserved_ms else 0 end),0)
      +case when exists(select 1 from public.customer_usage_grants where user_id=p_user_id and source_key='lifetime-trial') then 0 else 900000 end)
    into result from public.customer_usage_grants where user_id=p_user_id;
  return result;
end $$;
revoke all on function public.customer_usage_balance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_usage_balance(uuid,uuid) to service_role;

-- SOURCE supabase/migrations/20261004070733_sandbox_checkout_intents.sql SHA256 1c2e26897fcf53f8a9633b2f2ddd4ac4e6aff483969f62b296746d1c559c6e1f
-- Dedicated account staging only. Checkout ownership is not payment authority.
create table public.customer_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.customer_accounts(user_id),
  request_id uuid not null,
  offer_code text not null check (offer_code in ('pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly')),
  state text not null default 'CREATING' check (state in ('CREATING','BOUND','UNCERTAIN','REJECTED')),
  attempt_id uuid not null default gen_random_uuid(),
  transaction_id text unique check (transaction_id ~ '^txn_[a-z0-9]{26}$'),
  created_at timestamptz not null default now(),
  unique(user_id,request_id),
  check ((state='BOUND')=(transaction_id is not null))
);
create unique index customer_checkout_one_uncertain on public.customer_checkout_intents(user_id)
  where state in ('CREATING','UNCERTAIN');
create index customer_checkout_account_created on public.customer_checkout_intents(user_id,created_at);
alter table public.customer_checkout_intents enable row level security;
revoke all on public.customer_checkout_intents from public,anon,authenticated,service_role;

-- A replay never receives the create-attempt capability. No TTL automatically
-- releases CREATING: a crashed process may already have created a Paddle transaction.
create function public.customer_checkout_prepare(p_user_id uuid,p_session_id uuid,p_request_id uuid,p_offer_code text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare a jsonb; r public.customer_checkout_intents%rowtype;
begin
  if p_request_id is null or p_offer_code is null or p_offer_code not in
    ('pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly') then
    return jsonb_build_object('code','INVALID');
  end if;
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  perform 1 from public.customer_accounts where user_id=p_user_id for update;
  -- Verify again after acquiring the same account lock used by usage/financial writers.
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  select * into r from public.customer_checkout_intents where user_id=p_user_id and request_id=p_request_id;
  if found then
    if r.offer_code<>p_offer_code then return jsonb_build_object('code','CONFLICT'); end if;
    return jsonb_build_object('code',case when r.state='BOUND' then 'BOUND' when r.state='REJECTED' then 'REJECTED' else 'PENDING' end,
      'intentId',r.id,'transactionId',r.transaction_id);
  end if;
  if exists(select 1 from public.customer_checkout_intents where user_id=p_user_id and state in ('CREATING','UNCERTAIN')) then
    return jsonb_build_object('code','PENDING');
  end if;
  if (select count(*) from public.customer_checkout_intents where user_id=p_user_id and created_at>now()-interval '1 day')>=12 then
    return jsonb_build_object('code','RATE_LIMITED');
  end if;
  insert into public.customer_checkout_intents(user_id,request_id,offer_code)
    values(p_user_id,p_request_id,p_offer_code) returning * into r;
  return jsonb_build_object('code','CLAIMED','intentId',r.id,'attemptId',r.attempt_id);
end $$;
revoke all on function public.customer_checkout_prepare(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.customer_checkout_prepare(uuid,uuid,uuid,text) to service_role;

-- Only the original server caller may attach its returned Paddle transaction.
-- This does not mark it paid, store a customer, or allocate any minutes.
create function public.customer_checkout_complete(p_intent_id uuid,p_attempt_id uuid,p_transaction_id text,p_state text)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare r public.customer_checkout_intents%rowtype; owner_id uuid;
begin
  if p_state is null or p_state not in ('BOUND','UNCERTAIN','REJECTED') or p_attempt_id is null
    or (p_state='BOUND' and (p_transaction_id is null or p_transaction_id !~ '^txn_[a-z0-9]{26}$'))
    or (p_state<>'BOUND' and p_transaction_id is not null) then return 'INVALID'; end if;
  select user_id into owner_id from public.customer_checkout_intents where id=p_intent_id;
  if owner_id is null then return 'NOT_FOUND'; end if;
  perform 1 from public.customer_accounts where user_id=owner_id for update;
  select * into strict r from public.customer_checkout_intents where id=p_intent_id for update;
  if r.attempt_id<>p_attempt_id then return 'FORBIDDEN'; end if;
  if r.state='BOUND' then
    if p_state='BOUND' and r.transaction_id=p_transaction_id then return 'BOUND'; end if;
    return 'CONFLICT';
  end if;
  if r.state='REJECTED' then return 'REJECTED'; end if;
  -- UNCERTAIN -> BOUND is allowed only with the original create attempt's actual
  -- response; browsers/webhooks have no route to supply this private capability.
  if r.state='UNCERTAIN' and p_state='REJECTED' then return 'CONFLICT'; end if;
  if p_transaction_id is not null and exists(select 1 from public.customer_checkout_intents where transaction_id=p_transaction_id and id<>p_intent_id) then
    return 'CONFLICT';
  end if;
  update public.customer_checkout_intents set state=p_state,transaction_id=p_transaction_id where id=p_intent_id;
  return p_state;
end $$;
revoke all on function public.customer_checkout_complete(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.customer_checkout_complete(uuid,uuid,text,text) to service_role;

-- SOURCE supabase/migrations/20261004072754_sandbox_pack_allowances.sql SHA256 89b79a7a4480ee1affd23a3007dff5b0794111b8c45a4323bb00dddf45956a89
-- Account staging only. Internal financial primitive; no public payment endpoint.
-- Trusted reconciliation must verify Paddle resources before calling this RPC.
-- Simulator receipts live in a different table and can never authorize this path.
create table public.customer_paddle_bindings (
  customer_id text primary key check(customer_id ~ '^ctm_[a-z0-9]{26}$'),
  user_id uuid not null references public.customer_accounts(user_id),
  created_at timestamptz not null default now()
);
create index customer_paddle_bindings_user on public.customer_paddle_bindings(user_id);
create table public.customer_pack_purchases (
  transaction_id text primary key references public.customer_checkout_intents(transaction_id),
  intent_id uuid not null unique references public.customer_checkout_intents(id),
  user_id uuid not null references public.customer_accounts(user_id),
  customer_id text not null references public.customer_paddle_bindings(customer_id),
  state text not null check(state in ('ACTIVE','REFUNDED')),
  grant_id uuid,
  created_at timestamptz not null default now(),
  foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
  check(state<>'ACTIVE' or grant_id is not null)
);
create index customer_pack_purchases_user on public.customer_pack_purchases(user_id,grant_id);
create index customer_pack_purchases_customer on public.customer_pack_purchases(customer_id);
create table public.customer_pack_applications (
  event_id text primary key references public.paddle_sandbox_events(event_id),
  event_digest text not null check(event_digest ~ '^[a-f0-9]{64}$'),
  transaction_id text not null references public.customer_pack_purchases(transaction_id),
  action text not null check(action in ('GRANT','REFUND')),
  adjustment_id text check(adjustment_id ~ '^adj_[a-z0-9]{26}$'),
  removed_ms bigint not null check(removed_ms>=0),
  created_at timestamptz not null default now(),
  check((action='REFUND')=(adjustment_id is not null))
);
create index customer_pack_applications_transaction on public.customer_pack_applications(transaction_id);
alter table public.customer_paddle_bindings enable row level security;
alter table public.customer_pack_purchases enable row level security;
alter table public.customer_pack_applications enable row level security;
revoke all on public.customer_paddle_bindings,public.customer_pack_purchases,public.customer_pack_applications
  from public,anon,authenticated,service_role;

-- Same lock order as usage: account before grants/runs. No network under a lock.
-- event applications and usage settlements remain append-only through all RPCs.
create function public.customer_pack_reconcile(p_event_id text,p_intent_id uuid,p_transaction_id text,
  p_customer_id text,p_action text,p_adjustment_id text default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i public.customer_checkout_intents%rowtype; e public.paddle_sandbox_events%rowtype;
  p public.customer_pack_purchases%rowtype; a public.customer_pack_applications%rowtype;
  g public.customer_usage_grants%rowtype; owner_id uuid; t timestamptz; r record; removed bigint:=0;
begin
  if p_event_id is null or p_event_id !~ '^evt_[a-z0-9]{26}$' or p_intent_id is null
    or p_transaction_id is null or p_transaction_id !~ '^txn_[a-z0-9]{26}$'
    or p_customer_id is null or p_customer_id !~ '^ctm_[a-z0-9]{26}$'
    or p_action is null or p_action not in ('GRANT','REFUND')
    or (p_action='GRANT' and p_adjustment_id is not null)
    or (p_action='REFUND' and (p_adjustment_id is null or p_adjustment_id !~ '^adj_[a-z0-9]{26}$')) then
    return jsonb_build_object('code','INVALID');
  end if;
  select * into i from public.customer_checkout_intents where id=p_intent_id;
  if not found or i.state<>'BOUND' or i.transaction_id<>p_transaction_id or i.offer_code<>'pro_3_hours' then
    return jsonb_build_object('code','UNBOUND');
  end if;
  perform 1 from public.customer_accounts where user_id=i.user_id for update;
  t:=date_trunc('milliseconds',clock_timestamp());
  select * into e from public.paddle_sandbox_events where event_id=p_event_id for update;
  if not found or e.state<>'PENDING' then return jsonb_build_object('code','UNVERIFIED_EVENT'); end if;
  if (p_action='GRANT' and (e.event_type<>'transaction.completed' or e.resource_id<>p_transaction_id))
    or (p_action='REFUND' and (e.event_type not in ('adjustment.created','adjustment.updated') or e.resource_id<>p_adjustment_id)) then
    return jsonb_build_object('code','UNVERIFIED_EVENT');
  end if;
  select * into p from public.customer_pack_purchases where transaction_id=p_transaction_id;
  if found and (p.user_id<>i.user_id or p.intent_id<>i.id or p.customer_id<>p_customer_id) then
    return jsonb_build_object('code','CONFLICT');
  end if;
  select * into a from public.customer_pack_applications where event_id=p_event_id;
  if found then
    if a.event_digest<>e.event_digest or a.transaction_id<>p_transaction_id or a.action<>p_action
      or a.adjustment_id is distinct from p_adjustment_id then return jsonb_build_object('code','CONFLICT'); end if;
    return jsonb_build_object('code','DUPLICATE');
  end if;
  insert into public.customer_paddle_bindings(customer_id,user_id) values(p_customer_id,i.user_id) on conflict do nothing;
  select user_id into owner_id from public.customer_paddle_bindings where customer_id=p_customer_id;
  if owner_id<>i.user_id then return jsonb_build_object('code','CONFLICT'); end if;
  if p.transaction_id is null then
    if p_action='GRANT' then
      insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at)
        values(i.user_id,'paddle-sandbox:'||p_transaction_id,'PACK',10800000,t) returning * into g;
    end if;
    insert into public.customer_pack_purchases(transaction_id,intent_id,user_id,customer_id,state,grant_id)
      values(p_transaction_id,i.id,i.user_id,p_customer_id,case when p_action='REFUND' then 'REFUNDED' else 'ACTIVE' end,g.id)
      returning * into p;
  end if;
  if p_action='REFUND' and p.state='ACTIVE' then
    -- Settle every authorization funded by this grant before revocation. Account
    -- lock serializes against START/CHECKPOINT/STOP; historical spend is retained.
    for r in select x.run_id,x.sequence from public.customer_usage_runs x
      join public.customer_usage_windows w on (w.user_id,w.run_id,w.sequence)=(x.user_id,x.run_id,x.sequence)
      where x.user_id=i.user_id and x.state='ACTIVE' and w.grant_id=p.grant_id
    loop
      perform public.customer_usage_settle(i.user_id,r.run_id,r.sequence,t,'DENIED');
      update public.customer_usage_runs set state='DENIED',last_result=jsonb_build_object('code','DENIED')
        where user_id=i.user_id and run_id=r.run_id;
    end loop;
    select * into strict g from public.customer_usage_grants where id=p.grant_id;
    if g.reserved_ms<>0 then raise exception using errcode='23514',message='Unsettled refund reservation'; end if;
    removed:=g.granted_ms-g.spent_ms;
    update public.customer_usage_grants set state='REVOKED' where id=p.grant_id;
    update public.customer_pack_purchases set state='REFUNDED' where transaction_id=p_transaction_id;
    p.state:='REFUNDED';
  end if;
  -- Refund before grant leaves a durable tombstone: delayed completion never
  -- resurrects the purchase. Distinct legitimate purchases still stack.
  insert into public.customer_pack_applications(event_id,event_digest,transaction_id,action,adjustment_id,removed_ms)
    values(e.event_id,e.event_digest,p_transaction_id,p_action,p_adjustment_id,removed);
  return jsonb_build_object('code',p.state);
end $$;
revoke all on function public.customer_pack_reconcile(text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.customer_pack_reconcile(text,uuid,text,text,text,text) to service_role;

-- SOURCE supabase/migrations/20261004081006_sandbox_billing_jobs.sql SHA256 91a238988c093dbed9894486342a05000322184855dc0ecc6544a712a6a9795b
-- Staging-only durable work. No scheduler/checkout is enabled by this migration.
-- Normal signed events only; simulation receipts never enter this queue.
create table public.customer_billing_jobs (
  event_id text primary key references public.paddle_sandbox_events(event_id),
  state text not null default 'READY' check(state in ('READY','RUNNING','DONE','REVIEW')),
  attempts integer not null default 0 check(attempts between 0 and 12),
  available_at timestamptz not null default now(),
  claim_id uuid,
  claimed_until timestamptz,
  result_code text check(result_code in ('APPLIED','IGNORED','RETRY','UNBOUND','UNSUPPORTED','CONFLICT','EXHAUSTED')),
  updated_at timestamptz not null default now(),
  check((state='RUNNING')=(claim_id is not null and claimed_until is not null))
);
create index customer_billing_jobs_due on public.customer_billing_jobs(available_at,event_id)
  where state in ('READY','RUNNING');
alter table public.customer_billing_jobs enable row level security;
revoke all on public.customer_billing_jobs from public,anon,authenticated,service_role;

create function public.customer_billing_enqueue() returns trigger language plpgsql set search_path='' as $$
begin
  if new.state='PENDING' then
    insert into public.customer_billing_jobs(event_id) values(new.event_id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.customer_billing_enqueue() from public,anon,authenticated,service_role;
create trigger customer_billing_event_insert after insert on public.paddle_sandbox_events
  for each row execute function public.customer_billing_enqueue();
insert into public.customer_billing_jobs(event_id)
  select event_id from public.paddle_sandbox_events where state='PENDING' on conflict do nothing;

-- Short transaction, indexed SKIP LOCKED selection. Network work happens AFTER commit.
-- A crash loses at most a 90-second lease; the next claim gets a new fencing token.
create function public.customer_billing_claim(p_event_id text default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare j public.customer_billing_jobs%rowtype; e public.paddle_sandbox_events%rowtype;
  t timestamptz:=clock_timestamp(); token uuid:=gen_random_uuid();
begin
  select * into j from public.customer_billing_jobs
    where state in ('READY','RUNNING') and available_at<=t and (p_event_id is null or event_id=p_event_id)
    order by available_at,event_id for update skip locked limit 1;
  if not found then return jsonb_build_object('code','EMPTY'); end if;
  select * into strict e from public.paddle_sandbox_events where event_id=j.event_id;
  if e.state<>'PENDING' or j.attempts>=12 then
    update public.customer_billing_jobs set state='REVIEW',claim_id=null,claimed_until=null,
      result_code=case when e.state<>'PENDING' then 'CONFLICT' else 'EXHAUSTED' end,updated_at=t where event_id=j.event_id;
    return jsonb_build_object('code','REVIEW');
  end if;
  update public.customer_billing_jobs set state='RUNNING',attempts=attempts+1,claim_id=token,
    claimed_until=t+interval '90 seconds',available_at=t+interval '90 seconds',updated_at=t where event_id=j.event_id;
  return jsonb_build_object('code','CLAIMED','eventId',e.event_id,'eventType',e.event_type,
    'resourceId',e.resource_id,'eventDigest',e.event_digest,'claimId',token);
end $$;
revoke all on function public.customer_billing_claim(text) from public,anon,authenticated;
grant execute on function public.customer_billing_claim(text) to service_role;

create function public.customer_billing_finish(p_event_id text,p_claim_id uuid,p_result text)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare j public.customer_billing_jobs%rowtype; t timestamptz:=clock_timestamp(); conflicted boolean;
begin
  if p_result is null or p_result not in ('APPLIED','IGNORED','RETRY','UNBOUND','UNSUPPORTED','CONFLICT') then return 'INVALID'; end if;
  select * into j from public.customer_billing_jobs where event_id=p_event_id for update;
  if not found or j.state<>'RUNNING' or j.claim_id is distinct from p_claim_id or j.claimed_until<=clock_timestamp() then return 'STALE'; end if;
  select state<>'PENDING' into conflicted from public.paddle_sandbox_events where event_id=p_event_id;
  if conflicted then p_result:='CONFLICT'; end if;
  update public.customer_billing_jobs set
    state=case when p_result in ('APPLIED','IGNORED') then 'DONE'
      when p_result in ('UNSUPPORTED','CONFLICT') or attempts>=12 then 'REVIEW' else 'READY' end,
    result_code=p_result,claim_id=null,claimed_until=null,
    available_at=t+least(3600,15*power(2,least(attempts-1,8))) * interval '1 second',updated_at=t
    where event_id=p_event_id;
  return 'SAVED';
end $$;
revoke all on function public.customer_billing_finish(text,uuid,text) from public,anon,authenticated;
grant execute on function public.customer_billing_finish(text,uuid,text) to service_role;

-- Only the immutable server-created BOUND transaction chooses the Sigma account.
-- An event's email, customer custom_data, or client-supplied account ID is not used.
create function public.customer_billing_bound_intent(p_transaction_id text)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('intentId',id,'userId',user_id,'transactionId',transaction_id,'offerCode',offer_code)
  from public.customer_checkout_intents where transaction_id=p_transaction_id and state='BOUND'
$$;
revoke all on function public.customer_billing_bound_intent(text) from public,anon,authenticated;
grant execute on function public.customer_billing_bound_intent(text) to service_role;

-- Fence the financial write AND completion in one transaction. Lock order:
-- account -> event -> job -> grant/run. A stale worker cannot apply after reclaim.
create function public.customer_billing_apply_pack(p_event_id text,p_claim_id uuid,p_event_digest text,
  p_intent_id uuid,p_transaction_id text,p_customer_id text,p_action text,p_adjustment_id text default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare uid uuid; e public.paddle_sandbox_events%rowtype; j public.customer_billing_jobs%rowtype; result jsonb;
begin
  select user_id into uid from public.customer_checkout_intents where id=p_intent_id and state='BOUND' and transaction_id=p_transaction_id;
  if uid is null then return jsonb_build_object('code','UNBOUND'); end if;
  perform 1 from public.customer_accounts where user_id=uid for update;
  select * into e from public.paddle_sandbox_events where event_id=p_event_id for update;
  select * into j from public.customer_billing_jobs where event_id=p_event_id for update;
  if j.state is distinct from 'RUNNING' or j.claim_id is distinct from p_claim_id or j.claimed_until<=clock_timestamp()
    or e.state is distinct from 'PENDING' or e.event_digest is distinct from p_event_digest then
    return jsonb_build_object('code','STALE');
  end if;
  result:=public.customer_pack_reconcile(p_event_id,p_intent_id,p_transaction_id,p_customer_id,p_action,p_adjustment_id);
  if result->>'code' in ('ACTIVE','REFUNDED','DUPLICATE') then
    update public.customer_billing_jobs set state='DONE',result_code='APPLIED',claim_id=null,claimed_until=null,
      updated_at=clock_timestamp() where event_id=p_event_id;
  end if;
  return result;
end $$;
revoke all on function public.customer_billing_apply_pack(text,uuid,text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.customer_billing_apply_pack(text,uuid,text,uuid,text,text,text,text) to service_role;
-- Retire the unfenced service entry point; internal definer calls retain access.
revoke execute on function public.customer_pack_reconcile(text,uuid,text,text,text,text) from service_role;

-- Durable desired actions; enqueue is INTERNAL, for the future transactional
-- subscription writer. No browser/service direct inserts and no arbitrary URLs.
create table public.customer_billing_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.customer_accounts(user_id),
  subscription_id text not null check(subscription_id ~ '^sub_[a-z0-9]{26}$'),
  action_key text not null unique check(length(action_key) between 1 and 160),
  action text not null check(action in ('CANCEL_FUTURE','RESCHEDULE')),
  effective_at timestamptz,
  state text not null default 'READY' check(state in ('READY','RUNNING','DONE','REVIEW')),
  attempts integer not null default 0 check(attempts between 0 and 12),
  available_at timestamptz not null default now(),claim_id uuid,claimed_until timestamptz,
  result_code text check(result_code in ('CONFIRMED','RETRY','CONFLICT','EXHAUSTED')),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  check((action='RESCHEDULE')=(effective_at is not null)),
  check(effective_at is null or isfinite(effective_at)),
  check((state='RUNNING')=(claim_id is not null and claimed_until is not null))
);
create index customer_billing_outbox_due on public.customer_billing_outbox(available_at,id) where state in ('READY','RUNNING');
create index customer_billing_outbox_account on public.customer_billing_outbox(user_id,subscription_id);
create index customer_billing_outbox_subscription on public.customer_billing_outbox(subscription_id,created_at,id) where state in ('READY','RUNNING','REVIEW');
alter table public.customer_billing_outbox enable row level security;
revoke all on public.customer_billing_outbox from public,anon,authenticated,service_role;

create function public.customer_billing_action_claim()
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare j public.customer_billing_outbox%rowtype; t timestamptz:=clock_timestamp(); token uuid:=gen_random_uuid();
begin
  -- Process a subscription's actions strictly in order, including retry waits.
  select * into j from public.customer_billing_outbox x
    where x.state in ('READY','RUNNING') and x.available_at<=t and not exists(
      select 1 from public.customer_billing_outbox y where y.subscription_id=x.subscription_id
        and y.state in ('READY','RUNNING','REVIEW') and (y.created_at,y.id)<(x.created_at,x.id))
    order by x.available_at,x.id for update skip locked limit 1;
  if not found then return jsonb_build_object('code','EMPTY'); end if;
  if j.attempts>=12 then
    update public.customer_billing_outbox set state='REVIEW',claim_id=null,claimed_until=null,result_code='EXHAUSTED',updated_at=t where id=j.id;
    return jsonb_build_object('code','REVIEW');
  end if;
  update public.customer_billing_outbox set state='RUNNING',attempts=attempts+1,claim_id=token,
    claimed_until=t+interval '90 seconds',available_at=t+interval '90 seconds',updated_at=t where id=j.id;
  return jsonb_build_object('code','CLAIMED','actionId',j.id,'claimId',token,'userId',j.user_id,
    'subscriptionId',j.subscription_id,'action',j.action,'effectiveAt',j.effective_at);
end $$;
revoke all on function public.customer_billing_action_claim() from public,anon,authenticated;
grant execute on function public.customer_billing_action_claim() to service_role;

create function public.customer_billing_action_finish(p_id uuid,p_claim_id uuid,p_result text)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare j public.customer_billing_outbox%rowtype;
begin
  if p_result is null or p_result not in ('CONFIRMED','RETRY','CONFLICT') then return 'INVALID'; end if;
  select * into j from public.customer_billing_outbox where id=p_id for update;
  if not found or j.state<>'RUNNING' or j.claim_id is distinct from p_claim_id or j.claimed_until<=clock_timestamp() then return 'STALE'; end if;
  update public.customer_billing_outbox set state=case when p_result='CONFIRMED' then 'DONE'
    when p_result='CONFLICT' or attempts>=12 then 'REVIEW' else 'READY' end,
    result_code=p_result,claim_id=null,claimed_until=null,updated_at=clock_timestamp(),
    available_at=clock_timestamp()+least(3600,15*power(2,least(attempts-1,8)))*interval '1 second' where id=p_id;
  return 'SAVED';
end $$;
revoke all on function public.customer_billing_action_finish(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.customer_billing_action_finish(uuid,uuid,text) to service_role;

-- Check immediately before the external mutation. Reserve enough lease time for
-- the fixed 10-second HTTP deadline plus readback; expired workers never start it.
create function public.customer_billing_action_authorize(p_id uuid,p_claim_id uuid)
returns boolean language sql security definer set search_path='' as $$
  select exists(select 1 from public.customer_billing_outbox where id=p_id and state='RUNNING'
    and claim_id=p_claim_id and claimed_until>clock_timestamp()+interval '30 seconds')
$$;
revoke all on function public.customer_billing_action_authorize(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_billing_action_authorize(uuid,uuid) to service_role;

-- SOURCE supabase/migrations/20261004081025_sandbox_recurring_lifecycle.sql SHA256 22aa46dc906a34c0dcb0b3cc28639963e2185146f033bcbaed3814e0d71b21a7
-- Account staging only. Authoritative Paddle reads happen before these bounded,
-- account-serialized transactions. No checkout or Paddle mutation is enabled here.
create table public.customer_recurring_subscriptions (
  subscription_id text primary key check(subscription_id ~ '^sub_[a-z0-9]{26}$'),
  user_id uuid not null references public.customer_accounts(user_id),
  customer_id text not null references public.customer_paddle_bindings(customer_id),
  offer_code text not null check(offer_code in ('pro_40_hours','enterprise_weekly','enterprise_monthly')),
  tier text not null check(tier in ('PRO','ENTERPRISE')),
  state text not null check(state in ('ACTIVE','PAST_DUE','CANCELED','PAUSED')),
  observed_at timestamptz not null,
  paid_through timestamptz not null,
  grace_until timestamptz,
  cancel_future boolean not null default false,
  unique(user_id,subscription_id),
  check(isfinite(observed_at) and isfinite(paid_through)),
  check(grace_until is null or isfinite(grace_until)),
  check((offer_code='pro_40_hours')=(tier='PRO'))
);
create index customer_recurring_subscriptions_user on public.customer_recurring_subscriptions(user_id,subscription_id);
create index customer_recurring_subscriptions_customer on public.customer_recurring_subscriptions(customer_id);
create table public.customer_recurring_terms (
  transaction_id text primary key check(transaction_id ~ '^txn_[a-z0-9]{26}$'),
  user_id uuid not null,
  subscription_id text not null,
  grant_id uuid,
  state text not null check(state in ('ACTIVE','QUEUED','PAUSED','ENDED','REFUNDED')),
  period_start timestamptz not null,period_end timestamptz not null,
  starts_at timestamptz,ends_at timestamptz,remaining_ms bigint,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(user_id,subscription_id) references public.customer_recurring_subscriptions(user_id,subscription_id),
  foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
  unique(subscription_id,period_start),
  check(isfinite(period_start) and isfinite(period_end) and period_end>period_start),
  check(state<>'ACTIVE' or (grant_id is not null and starts_at is not null and ends_at>starts_at)),
  check(remaining_ms is null or remaining_ms>0),
  check(state not in ('QUEUED','PAUSED') or remaining_ms is not null)
);
create unique index customer_recurring_one_active on public.customer_recurring_terms(user_id) where state='ACTIVE';
create index customer_recurring_pending on public.customer_recurring_terms(user_id,state,created_at,transaction_id) where state in ('ACTIVE','QUEUED','PAUSED');
create index customer_recurring_terms_subscription on public.customer_recurring_terms(subscription_id,period_end);
create index customer_recurring_terms_grant on public.customer_recurring_terms(user_id,grant_id);
create table public.customer_recurring_applications (
  event_id text primary key references public.paddle_sandbox_events(event_id),
  user_id uuid not null references public.customer_accounts(user_id),
  subscription_id text not null references public.customer_recurring_subscriptions(subscription_id),
  transaction_id text references public.customer_recurring_terms(transaction_id),
  action text not null check(action in ('GRANT','STATUS','REFUND')),
  removed_ms bigint not null default 0 check(removed_ms>=0),
  created_at timestamptz not null default clock_timestamp()
);
create index customer_recurring_applications_user on public.customer_recurring_applications(user_id,created_at);
create index customer_recurring_applications_subscription on public.customer_recurring_applications(subscription_id);
create index customer_recurring_applications_transaction on public.customer_recurring_applications(transaction_id);
alter table public.customer_recurring_subscriptions enable row level security;
alter table public.customer_recurring_terms enable row level security;
alter table public.customer_recurring_applications enable row level security;
revoke all on public.customer_recurring_subscriptions,public.customer_recurring_terms,public.customer_recurring_applications
  from public,anon,authenticated,service_role;

-- INTERNAL helpers always called while owning the account lock.
create function public.customer_recurring_stop_grant(p_user uuid,p_grant uuid,p_at timestamptz)
returns void language plpgsql set search_path='' as $$
declare r record;
begin
  for r in select x.run_id,x.sequence from public.customer_usage_runs x join public.customer_usage_windows w
    on (w.user_id,w.run_id,w.sequence)=(x.user_id,x.run_id,x.sequence)
    where x.user_id=p_user and x.state='ACTIVE' and w.grant_id=p_grant
  loop
    perform public.customer_usage_settle(p_user,r.run_id,r.sequence,p_at,'DENIED');
    update public.customer_usage_runs set state='DENIED',last_result=jsonb_build_object('code','DENIED') where user_id=p_user and run_id=r.run_id;
  end loop;
end $$;
revoke all on function public.customer_recurring_stop_grant(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function public.customer_recurring_action(p_user uuid,p_sub text,p_action text,p_at timestamptz)
returns void language plpgsql set search_path='' as $$
begin
  insert into public.customer_billing_outbox(user_id,subscription_id,action_key,action,effective_at)
    values(p_user,p_sub,p_sub||':'||p_action||':'||coalesce(extract(epoch from p_at)::text,'end'),p_action,p_at)
    on conflict(action_key) do nothing;
end $$;
revoke all on function public.customer_recurring_action(uuid,text,text,timestamptz) from public,anon,authenticated,service_role;

create function public.customer_recurring_refresh(p_user uuid,p_at timestamptz)
returns void language plpgsql set search_path='' as $$
declare a public.customer_recurring_terms%rowtype; s public.customer_recurring_subscriptions%rowtype;
  next_term public.customer_recurring_terms%rowtype; cursor_at timestamptz:=p_at; count_steps integer:=0;
begin
  loop
    count_steps:=count_steps+1;
    if count_steps>128 then raise exception using errcode='54000',message='Billing schedule requires review'; end if;
    select * into a from public.customer_recurring_terms where user_id=p_user and state='ACTIVE';
    if found then
      select * into strict s from public.customer_recurring_subscriptions where subscription_id=a.subscription_id;
      if a.ends_at>p_at then return; end if;
      -- A confirmed payment failure gets ONE day, with leftover minutes only.
      -- Repeated failures never reset this deadline. A renewal gets a NEW grant.
      if s.state='PAST_DUE' and not s.cancel_future and s.grace_until>a.ends_at then
        update public.customer_recurring_terms set ends_at=s.grace_until where transaction_id=a.transaction_id;
        update public.customer_usage_grants set expires_at=s.grace_until where id=a.grant_id;
        a.ends_at:=s.grace_until;
        if a.ends_at>p_at then return; end if;
      end if;
      cursor_at:=a.ends_at;
      perform public.customer_recurring_stop_grant(p_user,a.grant_id,least(p_at,a.ends_at));
      update public.customer_usage_grants set state='REVOKED' where id=a.grant_id;
      update public.customer_recurring_terms set state='ENDED' where transaction_id=a.transaction_id;
    end if;
    -- Do not resume preserved Pro based on a missing/late renewal event. An
    -- authoritative canceled/failed state or paid queued term resolves this hold.
    select t.* into next_term from public.customer_recurring_terms t
      join public.customer_recurring_subscriptions x using(subscription_id)
      where t.user_id=p_user and t.state in ('QUEUED','PAUSED')
      order by case x.tier when 'ENTERPRISE' then 0 else 1 end,
        case t.state when 'PAUSED' then 0 else 1 end,t.created_at,t.transaction_id limit 1;
    if not found then return; end if;
    if exists(select 1 from public.customer_recurring_subscriptions x where x.user_id=p_user
      and x.tier='ENTERPRISE' and not x.cancel_future and
      (x.state='ACTIVE' or (x.state='PAST_DUE' and x.grace_until>p_at))
      and not exists(select 1 from public.customer_recurring_terms f where f.subscription_id=x.subscription_id
        and f.state='REFUNDED' and f.period_end=x.paid_through))
      and (select tier from public.customer_recurring_subscriptions where subscription_id=next_term.subscription_id)='PRO' then return; end if;
    -- When no active term remains, use the last known paid/grace boundary for
    -- delayed reads, not a fresh full period starting when the dashboard opens.
    if a.transaction_id is null then
      select greatest(coalesce(max(t.ends_at),p_at),coalesce(max(x.grace_until),'-infinity'::timestamptz)) into cursor_at
        from public.customer_recurring_terms t join public.customer_recurring_subscriptions x using(subscription_id)
        where t.user_id=p_user and t.state='ENDED';
      cursor_at:=least(cursor_at,p_at);
    end if;
    update public.customer_recurring_terms set state='ACTIVE',starts_at=cursor_at,
      ends_at=cursor_at+remaining_ms*interval '1 millisecond',remaining_ms=null where transaction_id=next_term.transaction_id;
    update public.customer_usage_grants set state='ACTIVE',starts_at=cursor_at,
      expires_at=cursor_at+next_term.remaining_ms*interval '1 millisecond' where id=next_term.grant_id;
  end loop;
end $$;
revoke all on function public.customer_recurring_refresh(uuid,timestamptz) from public,anon,authenticated,service_role;

-- Server reconciliation supplies a small validated evidence projection, not raw
-- Paddle payloads. Account mapping is independently enforced against BOUND intents
-- or an already-authorized subscription. No client amount/user ID is accepted.
create function public.customer_billing_apply_recurring(p_event_id text,p_claim_id uuid,p_event_digest text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare op text:=p_evidence->>'action'; sub_id text:=p_evidence->>'subscriptionId'; txn_id text:=p_evidence->>'transactionId';
  ctm text:=p_evidence->>'customerId'; offer text:=p_evidence->>'offerCode'; sub_state text:=p_evidence->>'state';
  observed timestamptz; ps timestamptz; pe timestamptz; cancelled boolean; uid uuid; owner_id uuid;
  e public.paddle_sandbox_events%rowtype; j public.customer_billing_jobs%rowtype;
  s public.customer_recurring_subscriptions%rowtype; term public.customer_recurring_terms%rowtype;
  active_term public.customer_recurring_terms%rowtype; initial public.customer_checkout_intents%rowtype;
  g public.customer_usage_grants%rowtype; n bigint; tier_name text; t timestamptz; target_end timestamptz; removed bigint:=0; r record;
begin
  if op is null or op not in ('GRANT','STATUS','REFUND') or sub_id is null or sub_id !~ '^sub_[a-z0-9]{26}$'
    or ctm is null or ctm !~ '^ctm_[a-z0-9]{26}$' or offer is null or offer not in ('pro_40_hours','enterprise_weekly','enterprise_monthly')
    or sub_state is null or sub_state not in ('ACTIVE','PAST_DUE','CANCELED','PAUSED')
    or (op<>'STATUS' and (txn_id is null or txn_id !~ '^txn_[a-z0-9]{26}$')) then return jsonb_build_object('code','INVALID'); end if;
  begin
    observed:=(p_evidence->>'observedAt')::timestamptz;ps:=(p_evidence->>'periodStart')::timestamptz;
    pe:=(p_evidence->>'periodEnd')::timestamptz;cancelled:=(p_evidence->>'cancelFuture')::boolean;
  exception when others then return jsonb_build_object('code','INVALID'); end;
  if observed is null or not isfinite(observed) or observed>clock_timestamp()+interval '5 minutes' or cancelled is null
    or (op<>'STATUS' and (ps is null or pe is null or not isfinite(ps) or not isfinite(pe)
      or ps>clock_timestamp()+interval '5 minutes' or pe-ps not between
        (case when offer='enterprise_weekly' then interval '7 days' else interval '28 days' end)-interval '1 second'
        and (case when offer='enterprise_weekly' then interval '7 days' else interval '31 days' end)+interval '1 second')) then
    return jsonb_build_object('code','INVALID'); end if;
  select * into s from public.customer_recurring_subscriptions where subscription_id=sub_id;
  if found then uid:=s.user_id; else
    select * into initial from public.customer_checkout_intents where transaction_id=txn_id and state='BOUND' and offer_code=offer;
    uid:=initial.user_id;
  end if;
  if uid is null then return jsonb_build_object('code','UNBOUND'); end if;
  perform 1 from public.customer_accounts where user_id=uid for update;
  t:=date_trunc('milliseconds',clock_timestamp());
  select * into e from public.paddle_sandbox_events where event_id=p_event_id for update;
  select * into j from public.customer_billing_jobs where event_id=p_event_id for update;
  if j.state is distinct from 'RUNNING' or j.claim_id is distinct from p_claim_id or j.claimed_until<=clock_timestamp()
    or e.state is distinct from 'PENDING' or e.event_digest is distinct from p_event_digest then return jsonb_build_object('code','STALE'); end if;
  if (op='GRANT' and (e.event_type<>'transaction.completed' or e.resource_id<>txn_id))
    or (op='STATUS' and (split_part(e.event_type,'.',1)<>'subscription' or e.resource_id<>sub_id))
    or (op='REFUND' and (e.event_type not in ('adjustment.created','adjustment.updated') or e.resource_id is distinct from p_evidence->>'adjustmentId')) then
    return jsonb_build_object('code','CONFLICT'); end if;
  select * into s from public.customer_recurring_subscriptions where subscription_id=sub_id;
  if s.subscription_id is not null and (s.user_id<>uid or s.customer_id<>ctm or s.offer_code<>offer) then return jsonb_build_object('code','CONFLICT'); end if;
  select * into term from public.customer_recurring_terms where transaction_id=txn_id;
  if term.transaction_id is not null and (term.user_id<>uid or term.subscription_id<>sub_id or term.period_start<>ps or term.period_end<>pe) then
    return jsonb_build_object('code','CONFLICT'); end if;
  if exists(select 1 from public.customer_recurring_applications where event_id=p_event_id) then
    update public.customer_billing_jobs set state='DONE',result_code='APPLIED',claim_id=null,claimed_until=null where event_id=p_event_id;
    return jsonb_build_object('code','DUPLICATE'); end if;
  if op='STATUS' and s.subscription_id is null then return jsonb_build_object('code','UNBOUND'); end if;
  if op='GRANT' and term.transaction_id is null and s.subscription_id is not null then
    -- Renewal gaps/overlaps are not guessed; preceding transaction must reconcile.
    if ps<>s.paid_through or s.cancel_future then return jsonb_build_object('code','RETRY'); end if;
  end if;
  insert into public.customer_paddle_bindings(customer_id,user_id) values(ctm,uid) on conflict do nothing;
  select user_id into owner_id from public.customer_paddle_bindings where customer_id=ctm;
  if owner_id<>uid then return jsonb_build_object('code','CONFLICT'); end if;
  tier_name:=case when offer='pro_40_hours' then 'PRO' else 'ENTERPRISE' end;
  n:=case offer when 'pro_40_hours' then 144000000 when 'enterprise_weekly' then 108000000 else 720000000 end;
  if s.subscription_id is null then
    insert into public.customer_recurring_subscriptions(subscription_id,user_id,customer_id,offer_code,tier,state,observed_at,paid_through,cancel_future,grace_until)
      values(sub_id,uid,ctm,offer,tier_name,sub_state,observed,pe,cancelled or sub_state='CANCELED',
        case when sub_state='PAST_DUE' and not cancelled then pe+interval '1 day' else null end);
  elsif observed>s.observed_at then
    update public.customer_recurring_subscriptions set state=sub_state,observed_at=observed,
      cancel_future=cancel_future or cancelled or sub_state='CANCELED',
      grace_until=case when sub_state='PAST_DUE' and not cancel_future and not cancelled then coalesce(grace_until,paid_through+interval '1 day') else null end
      where subscription_id=sub_id;
  end if;
  if op='GRANT' and term.transaction_id is null then
    if s.subscription_id is not null then
      -- Renew before refresh: delayed Enterprise renewal must not resume Pro.
      for r in select * from public.customer_recurring_terms where subscription_id=sub_id and state='ACTIVE'
      loop
        perform public.customer_recurring_stop_grant(uid,r.grant_id,least(t,r.ends_at));
        update public.customer_usage_grants set state='REVOKED' where id=r.grant_id;
        update public.customer_recurring_terms set state='ENDED' where transaction_id=r.transaction_id;
      end loop;
      update public.customer_recurring_subscriptions set paid_through=pe,grace_until=null where subscription_id=sub_id;
    else
      perform public.customer_recurring_refresh(uid,t);
    end if;
    select * into active_term from public.customer_recurring_terms where user_id=uid and state='ACTIVE';
    insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at,state)
      values(uid,'paddle-sandbox:'||txn_id,'RECURRING',n,ps,pe,'PAUSED') returning * into g;
    if active_term.transaction_id is not null and tier_name='ENTERPRISE'
      and (select tier from public.customer_recurring_subscriptions where subscription_id=active_term.subscription_id)='PRO' then
      perform public.customer_recurring_stop_grant(uid,active_term.grant_id,t);
      select least(active_term.ends_at,paid_through) into target_end from public.customer_recurring_subscriptions
        where subscription_id=active_term.subscription_id;
      if target_end>t then
        update public.customer_recurring_terms set state='PAUSED',remaining_ms=floor(extract(epoch from target_end-t)*1000)::bigint,
          starts_at=null,ends_at=null where transaction_id=active_term.transaction_id;
        update public.customer_usage_grants set state='PAUSED' where id=active_term.grant_id;
      else
        -- Failed-payment grace is not prepaid Pro time and must not be saved as
        -- a new paid entitlement when upgrading to Enterprise.
        update public.customer_recurring_terms set state='ENDED' where transaction_id=active_term.transaction_id;
        update public.customer_usage_grants set state='REVOKED' where id=active_term.grant_id;
      end if;
      for r in select subscription_id from public.customer_recurring_subscriptions where user_id=uid and tier='PRO'
      loop
        update public.customer_recurring_subscriptions set cancel_future=true,grace_until=null where subscription_id=r.subscription_id;
        perform public.customer_recurring_action(uid,r.subscription_id,'CANCEL_FUTURE',null);
      end loop;
      active_term.transaction_id:=null;
    end if;
    if active_term.transaction_id is not null or (tier_name='PRO' and exists(select 1 from public.customer_recurring_subscriptions
      where user_id=uid and tier='ENTERPRISE' and not cancel_future and state in ('ACTIVE','PAST_DUE'))) then
      insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,grant_id,state,period_start,period_end,remaining_ms)
        values(txn_id,uid,sub_id,g.id,'QUEUED',ps,pe,floor(extract(epoch from pe-ps)*1000)::bigint);
      if tier_name='PRO' and (active_term.transaction_id is null or
        (select tier from public.customer_recurring_subscriptions where subscription_id=active_term.subscription_id)='ENTERPRISE') then
        update public.customer_recurring_subscriptions set cancel_future=true where subscription_id=sub_id;
        perform public.customer_recurring_action(uid,sub_id,'CANCEL_FUTURE',null);
      else
        select active_term.ends_at+sum(x.remaining_ms)*interval '1 millisecond' into target_end
          from public.customer_recurring_terms x join public.customer_recurring_subscriptions y using(subscription_id)
          where x.user_id=uid and x.state='QUEUED' and y.tier=tier_name;
        for r in select subscription_id from public.customer_recurring_subscriptions where user_id=uid and tier=tier_name and subscription_id<>sub_id
        loop
          update public.customer_recurring_subscriptions set cancel_future=true where subscription_id=r.subscription_id;
          perform public.customer_recurring_action(uid,r.subscription_id,'CANCEL_FUTURE',null);
        end loop;
        update public.customer_recurring_subscriptions set paid_through=target_end where subscription_id=sub_id;
        perform public.customer_recurring_action(uid,sub_id,'RESCHEDULE',target_end);
      end if;
    else
      insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,grant_id,state,period_start,period_end,starts_at,ends_at)
        values(txn_id,uid,sub_id,g.id,'ACTIVE',ps,pe,ps,pe);
      update public.customer_usage_grants set state='ACTIVE' where id=g.id;
    end if;
  elsif op='REFUND' then
    if term.transaction_id is null then
      insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,state,period_start,period_end)
        values(txn_id,uid,sub_id,'REFUNDED',ps,pe);
    elsif term.state<>'REFUNDED' then
      perform public.customer_recurring_stop_grant(uid,term.grant_id,t);
      select granted_ms-spent_ms into removed from public.customer_usage_grants where id=term.grant_id;
      update public.customer_usage_grants set state='REVOKED' where id=term.grant_id;
      update public.customer_recurring_terms set state='REFUNDED',remaining_ms=null where transaction_id=txn_id;
    end if;
    -- Refund is not cancellation of future Paddle billing, but this paid term no
    -- longer holds a preserved Pro remainder. Future renewals require new payment.
    update public.customer_recurring_subscriptions set grace_until=null where subscription_id=sub_id;
  end if;
  if op='STATUS' then
    -- A delayed failure notification may arrive after the old term was marked
    -- ended. Reuse its remaining minutes during the original fixed grace only;
    -- never create a new grant or disturb an already-active replacement term.
    select * into s from public.customer_recurring_subscriptions where subscription_id=sub_id;
    if s.state='PAST_DUE' and not s.cancel_future and s.grace_until>t
      and not exists(select 1 from public.customer_recurring_terms where user_id=uid and state='ACTIVE') then
      select * into term from public.customer_recurring_terms where subscription_id=sub_id and state='ENDED' and period_end=s.paid_through;
      if found then
        update public.customer_recurring_terms set state='ACTIVE',ends_at=s.grace_until where transaction_id=term.transaction_id;
        update public.customer_usage_grants set state='ACTIVE',expires_at=s.grace_until where id=term.grant_id;
      end if;
    end if;
  end if;
  perform public.customer_recurring_refresh(uid,t);
  insert into public.customer_recurring_applications(event_id,user_id,subscription_id,transaction_id,action,removed_ms)
    values(p_event_id,uid,sub_id,case when op='STATUS' then null else txn_id end,op,removed);
  update public.customer_billing_jobs set state='DONE',result_code='APPLIED',claim_id=null,claimed_until=null,updated_at=t where event_id=p_event_id;
  return jsonb_build_object('code','APPLIED');
end $$;
revoke all on function public.customer_billing_apply_recurring(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.customer_billing_apply_recurring(text,uuid,text,jsonb) to service_role;

create function public.customer_billing_subscription(p_subscription_id text)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('userId',user_id,'subscriptionId',subscription_id,'customerId',customer_id,'offerCode',offer_code)
    from public.customer_recurring_subscriptions where subscription_id=p_subscription_id
$$;
revoke all on function public.customer_billing_subscription(text) from public,anon,authenticated;
grant execute on function public.customer_billing_subscription(text) to service_role;

-- Preserve the tested usage protocol while advancing entitlement under the SAME
-- account lock before allocation. No desktop or legacy licensing route changes.
alter function public.customer_usage_command(uuid,uuid,uuid,integer,text) rename to customer_usage_command_base;
revoke all on function public.customer_usage_command_base(uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role;
create function public.customer_usage_command(p_user_id uuid,p_session_id uuid,p_run_id uuid,p_sequence integer,p_action text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;
begin
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  perform 1 from public.customer_accounts where user_id=p_user_id for update;
  perform public.customer_recurring_refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
  return public.customer_usage_command_base(p_user_id,p_session_id,p_run_id,p_sequence,p_action);
end $$;
revoke all on function public.customer_usage_command(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.customer_usage_command(uuid,uuid,uuid,integer,text) to service_role;

alter function public.customer_usage_balance(uuid,uuid) rename to customer_usage_balance_base;
revoke all on function public.customer_usage_balance_base(uuid,uuid) from public,anon,authenticated,service_role;
create function public.customer_usage_balance(p_user_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;
begin
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  perform 1 from public.customer_accounts where user_id=p_user_id for update;
  -- Only actual schedule transitions write; no per-second accrual or new debit.
  perform public.customer_recurring_refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
  return public.customer_usage_balance_base(p_user_id,p_session_id);
end $$;
revoke all on function public.customer_usage_balance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_usage_balance(uuid,uuid) to service_role;

-- SOURCE supabase/migrations/20261004081416_sandbox_refund_schedule_boundaries.sql SHA256 8aa2020c179fc49bc597ae036c959ef1e3cda622197b25c5cb5d0ae92083790b
-- Additive correction: retain historical migrations, reschedule shortened queued
-- terms, and anchor early refunds at server refund time rather than an old term.
create or replace function public.customer_recurring_refresh(p_user uuid,p_at timestamptz)
returns void language plpgsql set search_path='' as $$
declare a public.customer_recurring_terms%rowtype; s public.customer_recurring_subscriptions%rowtype;
  next_term public.customer_recurring_terms%rowtype; cursor_at timestamptz:=p_at; count_steps integer:=0;
begin
  loop
    count_steps:=count_steps+1;
    if count_steps>128 then raise exception using errcode='54000',message='Billing schedule requires review'; end if;
    select * into a from public.customer_recurring_terms where user_id=p_user and state='ACTIVE';
    if found then
      select * into strict s from public.customer_recurring_subscriptions where subscription_id=a.subscription_id;
      if a.ends_at>p_at then return; end if;
      -- A confirmed payment failure gets ONE day, with leftover minutes only.
      -- Repeated failures never reset this deadline. A renewal gets a NEW grant.
      if s.state='PAST_DUE' and not s.cancel_future and s.grace_until>a.ends_at then
        update public.customer_recurring_terms set ends_at=s.grace_until where transaction_id=a.transaction_id;
        update public.customer_usage_grants set expires_at=s.grace_until where id=a.grant_id;
        a.ends_at:=s.grace_until;
        if a.ends_at>p_at then return; end if;
      end if;
      cursor_at:=a.ends_at;
      perform public.customer_recurring_stop_grant(p_user,a.grant_id,least(p_at,a.ends_at));
      update public.customer_usage_grants set state='REVOKED' where id=a.grant_id;
      update public.customer_recurring_terms set state='ENDED' where transaction_id=a.transaction_id;
    end if;
    -- Do not resume preserved Pro based on a missing/late renewal event. An
    -- authoritative canceled/failed state or paid queued term resolves this hold.
    select t.* into next_term from public.customer_recurring_terms t
      join public.customer_recurring_subscriptions x using(subscription_id)
      where t.user_id=p_user and t.state in ('QUEUED','PAUSED')
      order by case x.tier when 'ENTERPRISE' then 0 else 1 end,
        case t.state when 'PAUSED' then 0 else 1 end,t.created_at,t.transaction_id limit 1;
    if not found then return; end if;
    if exists(select 1 from public.customer_recurring_subscriptions x where x.user_id=p_user
      and x.tier='ENTERPRISE' and not x.cancel_future and
      (x.state='ACTIVE' or (x.state='PAST_DUE' and x.grace_until>p_at))
      and not exists(select 1 from public.customer_recurring_terms f where f.subscription_id=x.subscription_id
        and f.state='REFUNDED' and f.period_start=(select max(v.period_start) from public.customer_recurring_terms v where v.subscription_id=x.subscription_id)))
      and (select tier from public.customer_recurring_subscriptions where subscription_id=next_term.subscription_id)='PRO' then return; end if;
    -- When no active term remains, use the last known paid/grace boundary for
    -- delayed reads, not a fresh full period starting when the dashboard opens.
    if a.transaction_id is null then
      select greatest(coalesce(max(t.ends_at),p_at),coalesce(max(x.grace_until),'-infinity'::timestamptz)) into cursor_at
        from public.customer_recurring_terms t join public.customer_recurring_subscriptions x using(subscription_id)
        where t.user_id=p_user and t.state in ('ENDED','REFUNDED');
      cursor_at:=least(cursor_at,p_at);
    end if;
    update public.customer_recurring_terms set state='ACTIVE',starts_at=cursor_at,
      ends_at=cursor_at+remaining_ms*interval '1 millisecond',remaining_ms=null where transaction_id=next_term.transaction_id;
    update public.customer_usage_grants set state='ACTIVE',starts_at=cursor_at,
      expires_at=cursor_at+next_term.remaining_ms*interval '1 millisecond' where id=next_term.grant_id;
    if next_term.state='QUEUED' and exists(select 1 from public.customer_recurring_subscriptions
      where subscription_id=next_term.subscription_id and not cancel_future) then
      update public.customer_recurring_subscriptions set paid_through=cursor_at+next_term.remaining_ms*interval '1 millisecond'
        where subscription_id=next_term.subscription_id;
      perform public.customer_recurring_action(p_user,next_term.subscription_id,'RESCHEDULE',
        cursor_at+next_term.remaining_ms*interval '1 millisecond');
    end if;
  end loop;
end $$;

create or replace function public.customer_billing_apply_recurring(p_event_id text,p_claim_id uuid,p_event_digest text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare op text:=p_evidence->>'action'; sub_id text:=p_evidence->>'subscriptionId'; txn_id text:=p_evidence->>'transactionId';
  ctm text:=p_evidence->>'customerId'; offer text:=p_evidence->>'offerCode'; sub_state text:=p_evidence->>'state';
  observed timestamptz; ps timestamptz; pe timestamptz; cancelled boolean; uid uuid; owner_id uuid;
  e public.paddle_sandbox_events%rowtype; j public.customer_billing_jobs%rowtype;
  s public.customer_recurring_subscriptions%rowtype; term public.customer_recurring_terms%rowtype;
  active_term public.customer_recurring_terms%rowtype; initial public.customer_checkout_intents%rowtype;
  g public.customer_usage_grants%rowtype; n bigint; tier_name text; t timestamptz; target_end timestamptz; removed bigint:=0; r record;
begin
  if op is null or op not in ('GRANT','STATUS','REFUND') or sub_id is null or sub_id !~ '^sub_[a-z0-9]{26}$'
    or ctm is null or ctm !~ '^ctm_[a-z0-9]{26}$' or offer is null or offer not in ('pro_40_hours','enterprise_weekly','enterprise_monthly')
    or sub_state is null or sub_state not in ('ACTIVE','PAST_DUE','CANCELED','PAUSED')
    or (op<>'STATUS' and (txn_id is null or txn_id !~ '^txn_[a-z0-9]{26}$')) then return jsonb_build_object('code','INVALID'); end if;
  begin
    observed:=(p_evidence->>'observedAt')::timestamptz;ps:=(p_evidence->>'periodStart')::timestamptz;
    pe:=(p_evidence->>'periodEnd')::timestamptz;cancelled:=(p_evidence->>'cancelFuture')::boolean;
  exception when others then return jsonb_build_object('code','INVALID'); end;
  if observed is null or not isfinite(observed) or observed>clock_timestamp()+interval '5 minutes' or cancelled is null
    or (op<>'STATUS' and (ps is null or pe is null or not isfinite(ps) or not isfinite(pe)
      or ps>clock_timestamp()+interval '5 minutes' or pe-ps not between
        (case when offer='enterprise_weekly' then interval '7 days' else interval '28 days' end)-interval '1 second'
        and (case when offer='enterprise_weekly' then interval '7 days' else interval '31 days' end)+interval '1 second')) then
    return jsonb_build_object('code','INVALID'); end if;
  select * into s from public.customer_recurring_subscriptions where subscription_id=sub_id;
  if found then uid:=s.user_id; else
    select * into initial from public.customer_checkout_intents where transaction_id=txn_id and state='BOUND' and offer_code=offer;
    uid:=initial.user_id;
  end if;
  if uid is null then return jsonb_build_object('code','UNBOUND'); end if;
  perform 1 from public.customer_accounts where user_id=uid for update;
  t:=date_trunc('milliseconds',clock_timestamp());
  select * into e from public.paddle_sandbox_events where event_id=p_event_id for update;
  select * into j from public.customer_billing_jobs where event_id=p_event_id for update;
  if j.state is distinct from 'RUNNING' or j.claim_id is distinct from p_claim_id or j.claimed_until<=clock_timestamp()
    or e.state is distinct from 'PENDING' or e.event_digest is distinct from p_event_digest then return jsonb_build_object('code','STALE'); end if;
  if (op='GRANT' and (e.event_type<>'transaction.completed' or e.resource_id<>txn_id))
    or (op='STATUS' and (split_part(e.event_type,'.',1)<>'subscription' or e.resource_id<>sub_id))
    or (op='REFUND' and (e.event_type not in ('adjustment.created','adjustment.updated') or e.resource_id is distinct from p_evidence->>'adjustmentId')) then
    return jsonb_build_object('code','CONFLICT'); end if;
  select * into s from public.customer_recurring_subscriptions where subscription_id=sub_id;
  if s.subscription_id is not null and (s.user_id<>uid or s.customer_id<>ctm or s.offer_code<>offer) then return jsonb_build_object('code','CONFLICT'); end if;
  select * into term from public.customer_recurring_terms where transaction_id=txn_id;
  if term.transaction_id is not null and (term.user_id<>uid or term.subscription_id<>sub_id or term.period_start<>ps or term.period_end<>pe) then
    return jsonb_build_object('code','CONFLICT'); end if;
  if exists(select 1 from public.customer_recurring_applications where event_id=p_event_id) then
    update public.customer_billing_jobs set state='DONE',result_code='APPLIED',claim_id=null,claimed_until=null where event_id=p_event_id;
    return jsonb_build_object('code','DUPLICATE'); end if;
  if op='STATUS' and s.subscription_id is null then return jsonb_build_object('code','UNBOUND'); end if;
  if op='GRANT' and term.transaction_id is null and s.subscription_id is not null then
    -- Renewal gaps/overlaps are not guessed; preceding transaction must reconcile.
    if ps<>s.paid_through or s.cancel_future then return jsonb_build_object('code','RETRY'); end if;
  end if;
  insert into public.customer_paddle_bindings(customer_id,user_id) values(ctm,uid) on conflict do nothing;
  select user_id into owner_id from public.customer_paddle_bindings where customer_id=ctm;
  if owner_id<>uid then return jsonb_build_object('code','CONFLICT'); end if;
  tier_name:=case when offer='pro_40_hours' then 'PRO' else 'ENTERPRISE' end;
  n:=case offer when 'pro_40_hours' then 144000000 when 'enterprise_weekly' then 108000000 else 720000000 end;
  if s.subscription_id is null then
    insert into public.customer_recurring_subscriptions(subscription_id,user_id,customer_id,offer_code,tier,state,observed_at,paid_through,cancel_future,grace_until)
      values(sub_id,uid,ctm,offer,tier_name,sub_state,observed,pe,cancelled or sub_state='CANCELED',
        case when sub_state='PAST_DUE' and not cancelled then pe+interval '1 day' else null end);
  elsif observed>s.observed_at then
    update public.customer_recurring_subscriptions set state=sub_state,observed_at=observed,
      cancel_future=cancel_future or cancelled or sub_state='CANCELED',
      grace_until=case when sub_state='PAST_DUE' and not cancel_future and not cancelled then coalesce(grace_until,paid_through+interval '1 day') else null end
      where subscription_id=sub_id;
  end if;
  if op='GRANT' and term.transaction_id is null then
    if s.subscription_id is not null then
      -- Renew before refresh: delayed Enterprise renewal must not resume Pro.
      for r in select * from public.customer_recurring_terms where subscription_id=sub_id and state='ACTIVE'
      loop
        perform public.customer_recurring_stop_grant(uid,r.grant_id,least(t,r.ends_at));
        update public.customer_usage_grants set state='REVOKED' where id=r.grant_id;
        update public.customer_recurring_terms set state='ENDED' where transaction_id=r.transaction_id;
      end loop;
      update public.customer_recurring_subscriptions set paid_through=pe,grace_until=null where subscription_id=sub_id;
    else
      perform public.customer_recurring_refresh(uid,t);
    end if;
    select * into active_term from public.customer_recurring_terms where user_id=uid and state='ACTIVE';
    insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at,state)
      values(uid,'paddle-sandbox:'||txn_id,'RECURRING',n,ps,pe,'PAUSED') returning * into g;
    if active_term.transaction_id is not null and tier_name='ENTERPRISE'
      and (select tier from public.customer_recurring_subscriptions where subscription_id=active_term.subscription_id)='PRO' then
      perform public.customer_recurring_stop_grant(uid,active_term.grant_id,t);
      select least(active_term.ends_at,paid_through) into target_end from public.customer_recurring_subscriptions
        where subscription_id=active_term.subscription_id;
      if target_end>t then
        update public.customer_recurring_terms set state='PAUSED',remaining_ms=floor(extract(epoch from target_end-t)*1000)::bigint,
          starts_at=null,ends_at=null where transaction_id=active_term.transaction_id;
        update public.customer_usage_grants set state='PAUSED' where id=active_term.grant_id;
      else
        -- Failed-payment grace is not prepaid Pro time and must not be saved as
        -- a new paid entitlement when upgrading to Enterprise.
        update public.customer_recurring_terms set state='ENDED' where transaction_id=active_term.transaction_id;
        update public.customer_usage_grants set state='REVOKED' where id=active_term.grant_id;
      end if;
      for r in select subscription_id from public.customer_recurring_subscriptions where user_id=uid and tier='PRO'
      loop
        update public.customer_recurring_subscriptions set cancel_future=true,grace_until=null where subscription_id=r.subscription_id;
        perform public.customer_recurring_action(uid,r.subscription_id,'CANCEL_FUTURE',null);
      end loop;
      active_term.transaction_id:=null;
    end if;
    if active_term.transaction_id is not null or (tier_name='PRO' and exists(select 1 from public.customer_recurring_subscriptions
      where user_id=uid and tier='ENTERPRISE' and not cancel_future and state in ('ACTIVE','PAST_DUE'))) then
      insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,grant_id,state,period_start,period_end,remaining_ms)
        values(txn_id,uid,sub_id,g.id,'QUEUED',ps,pe,floor(extract(epoch from pe-ps)*1000)::bigint);
      if tier_name='PRO' and (active_term.transaction_id is null or
        (select tier from public.customer_recurring_subscriptions where subscription_id=active_term.subscription_id)='ENTERPRISE') then
        update public.customer_recurring_subscriptions set cancel_future=true where subscription_id=sub_id;
        perform public.customer_recurring_action(uid,sub_id,'CANCEL_FUTURE',null);
      else
        select active_term.ends_at+sum(x.remaining_ms)*interval '1 millisecond' into target_end
          from public.customer_recurring_terms x join public.customer_recurring_subscriptions y using(subscription_id)
          where x.user_id=uid and x.state='QUEUED' and y.tier=tier_name;
        for r in select subscription_id from public.customer_recurring_subscriptions where user_id=uid and tier=tier_name and subscription_id<>sub_id
        loop
          update public.customer_recurring_subscriptions set cancel_future=true where subscription_id=r.subscription_id;
          perform public.customer_recurring_action(uid,r.subscription_id,'CANCEL_FUTURE',null);
        end loop;
        update public.customer_recurring_subscriptions set paid_through=target_end where subscription_id=sub_id;
        perform public.customer_recurring_action(uid,sub_id,'RESCHEDULE',target_end);
      end if;
    else
      insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,grant_id,state,period_start,period_end,starts_at,ends_at)
        values(txn_id,uid,sub_id,g.id,'ACTIVE',ps,pe,ps,pe);
      update public.customer_usage_grants set state='ACTIVE' where id=g.id;
    end if;
  elsif op='REFUND' then
    if term.transaction_id is null then
      insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,state,period_start,period_end)
        values(txn_id,uid,sub_id,'REFUNDED',ps,pe);
    elsif term.state<>'REFUNDED' then
      perform public.customer_recurring_stop_grant(uid,term.grant_id,t);
      select granted_ms-spent_ms into removed from public.customer_usage_grants where id=term.grant_id;
      update public.customer_usage_grants set state='REVOKED' where id=term.grant_id;
      update public.customer_recurring_terms set state='REFUNDED',remaining_ms=null,
        ends_at=case when state='ACTIVE' then t else ends_at end where transaction_id=txn_id;
    end if;
    -- Refund is not cancellation of future Paddle billing, but this paid term no
    -- longer holds a preserved Pro remainder. Future renewals require new payment.
    update public.customer_recurring_subscriptions set grace_until=null where subscription_id=sub_id;
  end if;
  if op='STATUS' then
    -- A delayed failure notification may arrive after the old term was marked
    -- ended. Reuse its remaining minutes during the original fixed grace only;
    -- never create a new grant or disturb an already-active replacement term.
    select * into s from public.customer_recurring_subscriptions where subscription_id=sub_id;
    if s.state='PAST_DUE' and not s.cancel_future and s.grace_until>t
      and not exists(select 1 from public.customer_recurring_terms where user_id=uid and state='ACTIVE') then
      select * into term from public.customer_recurring_terms where subscription_id=sub_id and state='ENDED' and period_end=s.paid_through;
      if found then
        update public.customer_recurring_terms set state='ACTIVE',ends_at=s.grace_until where transaction_id=term.transaction_id;
        update public.customer_usage_grants set state='ACTIVE',expires_at=s.grace_until where id=term.grant_id;
      end if;
    end if;
  end if;
  perform public.customer_recurring_refresh(uid,t);
  insert into public.customer_recurring_applications(event_id,user_id,subscription_id,transaction_id,action,removed_ms)
    values(p_event_id,uid,sub_id,case when op='STATUS' then null else txn_id end,op,removed);
  update public.customer_billing_jobs set state='DONE',result_code='APPLIED',claim_id=null,claimed_until=null,updated_at=t where event_id=p_event_id;
  return jsonb_build_object('code','APPLIED');
end $$;

-- SOURCE supabase/migrations/20261004093908_checkout_recovery_audit.sql SHA256 1e11028a578e2592e43348c4f4108d2afbc26f8bf0a9ea2ddd273414d725248b
-- Private owner-operated recovery evidence. No application RPC or payment writer.
-- Filename aligned with the connected staging migration history after application.
create table billing_private.checkout_recovery_audit (
  intent_id uuid primary key references public.customer_checkout_intents(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  operator_role text not null default current_user,
  reason text not null check (length(btrim(reason)) between 20 and 1000),
  authorization_reason text not null check (length(btrim(authorization_reason)) between 20 and 1000),
  evidence jsonb not null check (jsonb_typeof(evidence)='object'),
  before_row jsonb not null check (jsonb_typeof(before_row)='object'),
  after_row jsonb not null check (jsonb_typeof(after_row)='object'),
  check (before_row->>'id' is not distinct from intent_id::text),
  check (after_row->>'id' is not distinct from intent_id::text),
  check (before_row->>'state' is not distinct from 'UNCERTAIN'),
  check (after_row->>'state' is not distinct from 'REJECTED'),
  check ((before_row-'state')=(after_row-'state'))
);
alter table billing_private.checkout_recovery_audit enable row level security;
revoke all on billing_private.checkout_recovery_audit from public,anon,authenticated,service_role;
create function billing_private.reject_checkout_audit_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  raise exception 'Checkout recovery audit is append-only' using errcode='55000';
end $$;
revoke all on function billing_private.reject_checkout_audit_mutation() from public,anon,authenticated,service_role;
create trigger checkout_recovery_audit_immutable
before update or delete or truncate on billing_private.checkout_recovery_audit
for each statement execute function billing_private.reject_checkout_audit_mutation();
alter table billing_private.checkout_recovery_audit enable always trigger checkout_recovery_audit_immutable;

-- SOURCE supabase/migrations/20261004141346_account_workspace_controls.sql SHA256 4aae79ad3696657c562026fd384b73416f3cd41095090730db5937d6e93c1dee
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
 values('gemini-3.5-flash','Gemini 3.5 Flash','gemini',false,false,array['text','image']),
       ('flux-general-en','Live transcription','deepgram',false,false,array['audio']);

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

-- SOURCE supabase/migrations/20261008100006_account_admin_catalog_controls.sql SHA256 bca2bc0ab8ed20f8477c2b4886a7db7952c62c8ad1bb6addcfe28e5c841c126d
-- Account-only admin operations. Never represent adjustments as Paddle purchases.
-- A fully removed grant must remain zero through queued/paused plan resumption.
-- Keep the original amount in immutable adjustment audit; trial remains exactly 900000.
alter table public.customer_usage_grants drop constraint customer_usage_grants_granted_ms_check;
alter table public.customer_usage_grants add constraint customer_usage_grants_granted_ms_check check(granted_ms>=0);
create table public.account_catalog_policy (
 offer_code text primary key check(offer_code in ('pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly')),
 display_name text not null check(length(trim(display_name)) between 2 and 80),
 enabled boolean not null default false,
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

-- SOURCE supabase/migrations/20261008100014_account_context_sync.sql SHA256 0e28465f587866dd9db1a862bda75439589f837f7605d02f79eb0e9732cb8fb0
-- Account-only context synchronization; original files are never uploaded.
-- Service callers must supply the verified live user/session, never browser IDs.
create table public.customer_context_operations (
  user_id uuid not null references public.customer_accounts(user_id),
  operation_id uuid not null,
  input_hash text not null,
  created_at timestamptz not null default now(),
  primary key(user_id,operation_id)
);
alter table public.customer_context_operations enable row level security;
revoke all on public.customer_context_operations from public,anon,authenticated,service_role;

create function public.customer_context_command(p_user uuid,p_session uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb; action text:=p_input->>'action'; ident uuid; operation uuid;
 prior text; fingerprint text; documents jsonb; ids uuid[]; result jsonb;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or action is null or action not in ('LIST','READ','SAVE','DELETE') then
  return jsonb_build_object('code','INVALID'); end if;
 -- Consistent with all account usage/workspace writers: one account lock.
 perform 1 from public.customer_accounts where user_id=p_user for update;
 if (select state from public.customer_accounts where user_id=p_user) is distinct from 'ACTIVE' then return jsonb_build_object('code','SUSPENDED'); end if;
 if action in ('SAVE','DELETE') then
  if (p_input->>'id') is null or (p_input->>'operationId') is null then return jsonb_build_object('code','INVALID'); end if;
  ident:=(p_input->>'id')::uuid;operation:=(p_input->>'operationId')::uuid;
  -- Hash is replay identity only, not authentication. No context body in journal.
  fingerprint:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
  select input_hash into prior from public.customer_context_operations where user_id=p_user and operation_id=operation;
  if found then
   if prior<>fingerprint then return jsonb_build_object('code','CONFLICT'); end if;
   -- Never replay the write: a retry after later deletion must not resurrect it.
  else
   if exists(select 1 from public.customer_context_documents where id=ident and user_id<>p_user) then return jsonb_build_object('code','FORBIDDEN'); end if;
   if action='SAVE' then
    if p_input->>'kind' is null or p_input->>'kind' not in ('RESUME','JOB_DESCRIPTION','SUPPORTING','INSTRUCTIONS')
      or jsonb_typeof(p_input->'name') is distinct from 'string' or length(trim(p_input->>'name')) not between 1 and 120
      or jsonb_typeof(p_input->'body') is distinct from 'string' or octet_length(p_input->>'body') not between 1 and 120000 then
     return jsonb_build_object('code','INVALID'); end if;
    if (select count(*) from public.customer_context_documents where user_id=p_user and id<>ident)>=20 then return jsonb_build_object('code','CAPACITY'); end if;
    insert into public.customer_context_documents(id,user_id,kind,name,body) values(ident,p_user,p_input->>'kind',trim(p_input->>'name'),p_input->>'body')
     on conflict(id) do update set kind=excluded.kind,name=excluded.name,body=excluded.body,updated_at=clock_timestamp()
      where customer_context_documents.user_id=p_user;
   else
    delete from public.customer_context_documents where user_id=p_user and id=ident;
   end if;
   insert into public.customer_context_operations(user_id,operation_id,input_hash) values(p_user,operation,fingerprint);
  end if;
 elsif action='READ' then
  if jsonb_typeof(p_input->'ids') is distinct from 'array' or jsonb_array_length(p_input->'ids')>8 then return jsonb_build_object('code','INVALID'); end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_input->'ids');
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'name',name,'bytes',octet_length(body),'updatedAt',updated_at)
   ||case when action='READ' then jsonb_build_object('body',body) else '{}'::jsonb end order by updated_at desc,id),'[]')
 into documents from public.customer_context_documents where user_id=p_user and (action<>'READ' or id=any(ids));
 return jsonb_build_object('code','ACTIVE','documents',documents);
exception when invalid_text_representation then return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.customer_context_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.customer_context_command(uuid,uuid,jsonb) to service_role;

-- SOURCE supabase/migrations/20261009012641_account_release_distribution.sql SHA256 4f4ae13e371db40ddefff7dca845512f7fe7d9ff97d66279721d4377a1396ab4
-- Separate account TEST product only. No legacy release/financial tables changed.
create table public.account_releases (
 id uuid primary key,
 version text not null unique,
 payload jsonb not null,
 state text not null default 'DRAFT' check(state in ('DRAFT','PUBLISHED','WITHDRAWN')),
 created_at timestamptz not null default clock_timestamp(),
 published_at timestamptz,
 check(jsonb_typeof(payload)='object'),
 check(state='DRAFT' or published_at is not null)
);
create index account_releases_latest on public.account_releases(published_at desc,id) where state='PUBLISHED';
alter table public.account_releases enable row level security;
revoke all on public.account_releases from public,anon,authenticated,service_role;

create function public.account_release_latest() returns jsonb
language sql security definer set search_path='' as $$
 select payload || jsonb_build_object('id',id,'state',state,'publishedAt',published_at)
 from public.account_releases where state='PUBLISHED' order by published_at desc,id limit 1;
$$;
revoke all on function public.account_release_latest() from public,anon,authenticated;
grant execute on function public.account_release_latest() to service_role;

create function public.account_release_admin(p_actor uuid,p_session uuid,p_action text,
 p_operation uuid default null,p_reason text default null,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit; r public.account_releases; latest public.account_releases;
 ident uuid; v text; minv text; result jsonb; detail jsonb;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_action='LIST' then
  return jsonb_build_object('code','ACTIVE','releases',coalesce((select jsonb_agg(x.data) from (
   select payload||jsonb_build_object('id',id,'state',state,'publishedAt',published_at) data
   from public.account_releases order by created_at desc,id limit 50) x),'[]'::jsonb));
 end if;
 if p_action not in ('DRAFT','PUBLISH','WITHDRAW') or p_operation is null or p_reason is null
  or length(trim(p_reason)) not between 10 and 500 or jsonb_typeof(p_input) is distinct from 'object'
 then return jsonb_build_object('code','INVALID'); end if;
 -- One product-wide lock serializes approvals across administrators and versions.
 perform pg_advisory_xact_lock(1936879982,1094927188);
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
  if prior.actor_id=p_actor and prior.action='RELEASE_'||p_action and prior.reason=trim(p_reason)
    and prior.detail->'input'=p_input then return jsonb_build_object('code','APPLIED','releaseId',prior.detail->'releaseId'); end if;
  return jsonb_build_object('code','CONFLICT');
 end if;
 if p_action='DRAFT' then
  if (p_input-array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])<>'{}'::jsonb
   or not(p_input ?& array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])
   then return jsonb_build_object('code','INVALID'); end if;
  v:=p_input->>'version'; minv:=p_input->>'minimumSupportedVersion';
  if v !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
   or minv !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
   or string_to_array(minv,'.')::bigint[]>string_to_array(v,'.')::bigint[]
   or p_input->>'sha256' !~ '^[a-f0-9]{64}$' or p_input->>'updateType' not in ('OPTIONAL','RECOMMENDED','REQUIRED')
   or jsonb_typeof(p_input->'fileSizeBytes')<>'number' or (p_input->>'fileSizeBytes')::bigint not between 1 and 536870912
   or jsonb_typeof(p_input->'releaseNotes')<>'string' or length(p_input->>'releaseNotes')>2000
   or p_input->>'downloadUrl' !~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/SigmaRoundAccountTestSetup-[0-9.]+\.exe$'
   or right(p_input->>'downloadUrl',length('/SigmaRoundAccountTestSetup-'||v||'.exe'))<>'/SigmaRoundAccountTestSetup-'||v||'.exe'
   or exists(select 1 from jsonb_each(p_input) e where e.value='null'::jsonb)
  then return jsonb_build_object('code','INVALID'); end if;
  if exists(select 1 from public.account_releases where version=v) then return jsonb_build_object('code','CONFLICT'); end if;
  ident:=p_operation;
  insert into public.account_releases(id,version,payload) values(ident,v,p_input);
 else
  ident:=(p_input->>'id')::uuid;
  select * into r from public.account_releases where id=ident for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if p_action='PUBLISH' then
   if (p_input-array['id','verifiedHostedSha256','verifiedFileSizeBytes','confirmedAccountInstaller'])<>'{}'::jsonb
    or p_input->>'verifiedHostedSha256' is distinct from r.payload->>'sha256'
    or p_input->'verifiedFileSizeBytes' is distinct from r.payload->'fileSizeBytes'
    or p_input->'confirmedAccountInstaller' is distinct from 'true'::jsonb or r.state<>'DRAFT'
   then return jsonb_build_object('code','INVALID'); end if;
   -- Never downgrade a previously published account version, even after withdrawal.
   select * into latest from public.account_releases where published_at is not null
    order by string_to_array(version,'.')::bigint[] desc limit 1;
   if found and string_to_array(r.version,'.')::bigint[]<=string_to_array(latest.version,'.')::bigint[]
    then return jsonb_build_object('code','CONFLICT'); end if;
   update public.account_releases set state='PUBLISHED',published_at=clock_timestamp() where id=ident;
  else
   if p_input- 'id'<>'{}'::jsonb or r.state<>'PUBLISHED' then return jsonb_build_object('code','INVALID'); end if;
   update public.account_releases set state='WITHDRAWN' where id=ident;
  end if;
 end if;
 detail:=jsonb_build_object('input',p_input,'releaseId',ident);
 insert into public.account_admin_audit(operation_id,actor_id,action,reason,detail)
  values(p_operation,p_actor,'RELEASE_'||p_action,trim(p_reason),detail);
 return jsonb_build_object('code','APPLIED','releaseId',ident);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then
 return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.account_release_admin(uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_release_admin(uuid,uuid,text,uuid,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20261009050304_account_release_validation_fix.sql SHA256 02a0a5e2a00ddcf0aa5bcd34bc8e9e0bb7ba293c17deaf38aca3e23080af3e4b
-- Additive repair of the deployed account RPC's double-escaped dot patterns.
-- [.] is a literal dot independent of SQL/JSON backslash transport. No rows,
-- legacy functions, authorization rules, locks or approval policy are changed.
create or replace function public.account_release_admin(p_actor uuid,p_session uuid,p_action text,
 p_operation uuid default null,p_reason text default null,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit; r public.account_releases; latest public.account_releases;
 ident uuid; v text; minv text; result jsonb; detail jsonb;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_action='LIST' then
  return jsonb_build_object('code','ACTIVE','releases',coalesce((select jsonb_agg(x.data) from (
   select payload||jsonb_build_object('id',id,'state',state,'publishedAt',published_at) data
   from public.account_releases order by created_at desc,id limit 50) x),'[]'::jsonb));
 end if;
 if p_action not in ('DRAFT','PUBLISH','WITHDRAW') or p_operation is null or p_reason is null
  or length(trim(p_reason)) not between 10 and 500 or jsonb_typeof(p_input) is distinct from 'object'
 then return jsonb_build_object('code','INVALID'); end if;
 perform pg_advisory_xact_lock(1936879982,1094927188);
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
  if prior.actor_id=p_actor and prior.action='RELEASE_'||p_action and prior.reason=trim(p_reason)
    and prior.detail->'input'=p_input then return jsonb_build_object('code','APPLIED','releaseId',prior.detail->'releaseId'); end if;
  return jsonb_build_object('code','CONFLICT');
 end if;
 if p_action='DRAFT' then
  if (p_input-array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])<>'{}'::jsonb
   or not(p_input ?& array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])
   then return jsonb_build_object('code','INVALID'); end if;
  v:=p_input->>'version'; minv:=p_input->>'minimumSupportedVersion';
  if v !~ '^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})$'
   or minv !~ '^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})$'
   or string_to_array(minv,'.')::bigint[]>string_to_array(v,'.')::bigint[]
   or p_input->>'sha256' !~ '^[a-f0-9]{64}$' or p_input->>'updateType' not in ('OPTIONAL','RECOMMENDED','REQUIRED')
   or jsonb_typeof(p_input->'fileSizeBytes')<>'number' or (p_input->>'fileSizeBytes')::bigint not between 1 and 536870912
   or jsonb_typeof(p_input->'releaseNotes')<>'string' or length(p_input->>'releaseNotes')>2000
   or p_input->>'downloadUrl' !~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/SigmaRoundAccountTestSetup-[0-9.]+[.]exe$'
   or right(p_input->>'downloadUrl',length('/SigmaRoundAccountTestSetup-'||v||'.exe'))<>'/SigmaRoundAccountTestSetup-'||v||'.exe'
   or exists(select 1 from jsonb_each(p_input) e where e.value='null'::jsonb)
  then return jsonb_build_object('code','INVALID'); end if;
  if exists(select 1 from public.account_releases where version=v) then return jsonb_build_object('code','CONFLICT'); end if;
  ident:=p_operation;
  insert into public.account_releases(id,version,payload) values(ident,v,p_input);
 else
  ident:=(p_input->>'id')::uuid;
  select * into r from public.account_releases where id=ident for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if p_action='PUBLISH' then
   if (p_input-array['id','verifiedHostedSha256','verifiedFileSizeBytes','confirmedAccountInstaller'])<>'{}'::jsonb
    or p_input->>'verifiedHostedSha256' is distinct from r.payload->>'sha256'
    or p_input->'verifiedFileSizeBytes' is distinct from r.payload->'fileSizeBytes'
    or p_input->'confirmedAccountInstaller' is distinct from 'true'::jsonb or r.state<>'DRAFT'
   then return jsonb_build_object('code','INVALID'); end if;
   select * into latest from public.account_releases where published_at is not null
    order by string_to_array(version,'.')::bigint[] desc limit 1;
   if found and string_to_array(r.version,'.')::bigint[]<=string_to_array(latest.version,'.')::bigint[]
    then return jsonb_build_object('code','CONFLICT'); end if;
   update public.account_releases set state='PUBLISHED',published_at=clock_timestamp() where id=ident;
  else
   if p_input- 'id'<>'{}'::jsonb or r.state<>'PUBLISHED' then return jsonb_build_object('code','INVALID'); end if;
   update public.account_releases set state='WITHDRAWN' where id=ident;
  end if;
 end if;
 detail:=jsonb_build_object('input',p_input,'releaseId',ident);
 insert into public.account_admin_audit(operation_id,actor_id,action,reason,detail)
  values(p_operation,p_actor,'RELEASE_'||p_action,trim(p_reason),detail);
 return jsonb_build_object('code','APPLIED','releaseId',ident);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then
 return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.account_release_admin(uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_release_admin(uuid,uuid,text,uuid,text,jsonb) to service_role;

-- SOURCE supabase/migrations/20261009120157_account_credits_snapshot.sql SHA256 b1de86c3f24e53bd3615828c050fb490209d4294cc20ca02237e3aee29f6fdeb
-- Account reporting only. Reuse the authoritative balance/schedule machinery;
-- never START, CHECKPOINT, STOP, grant, clear checkout or contact Paddle here.
create index customer_recurring_terms_account_recent on public.customer_recurring_terms(user_id,created_at desc,transaction_id);
create function public.customer_credits_read(p_user uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path=''
set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; b jsonb; t timestamptz; buckets jsonb; plans jsonb; payments jsonb;
begin
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 b:=public.customer_usage_balance(p_user,p_session);
 if b->>'code'<>'ACTIVE' then return jsonb_build_object('code',b->>'code'); end if;
 t:=clock_timestamp();
 -- Only currently eligible allowances enter the percentage denominator. Old
 -- recurring cycles, refunds, paused/future grants are excluded; lifetime used
 -- remains the separate authoritative total. Administrative time is not a pack.
 select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'grantedMilliseconds',granted,
  'spentMilliseconds',spent,'reservedMilliseconds',reserved,'availableMilliseconds',granted-spent-reserved) order by kind),'[]')
 into buckets from (
  select kind,sum(granted_ms) granted,sum(spent_ms) spent,sum(reserved_ms) reserved from (
   select case when source_key like 'admin-test:%' then 'TEST' when source_key like 'admin-%' then 'MANUAL' else kind end kind,
    granted_ms,spent_ms,reserved_ms from public.customer_usage_grants
   where user_id=p_user and state='ACTIVE' and starts_at<=t and (expires_at is null or expires_at>t)
   union all select 'TRIAL',900000,0,0 where not exists(
    select 1 from public.customer_usage_grants where user_id=p_user and source_key='lifetime-trial')
  ) eligible group by kind
 ) totals;
 select coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'state',r.state,'paymentState',s.state,
  'endsAt',r.ends_at,'cancelFuture',s.cancel_future)),'[]') into plans
 from (select * from public.customer_recurring_terms where user_id=p_user order by created_at desc,transaction_id limit 30) r
 join public.customer_recurring_subscriptions s on s.subscription_id=r.subscription_id;
 select coalesce(jsonb_agg(jsonb_build_object('offerCode',i.offer_code,'state',
  case when exists(select 1 from public.customer_pack_purchases p where p.transaction_id=i.transaction_id and p.state='REFUNDED')
    or exists(select 1 from public.customer_recurring_terms p where p.transaction_id=i.transaction_id and p.state='REFUNDED') then 'REFUNDED'
   when exists(select 1 from public.customer_pack_purchases p where p.transaction_id=i.transaction_id and p.state='ACTIVE')
    or exists(select 1 from public.customer_recurring_terms p where p.transaction_id=i.transaction_id and p.user_id=p_user) then 'VERIFIED'
   else i.state end,'createdAt',i.created_at) order by i.created_at desc),'[]') into payments
 from (select * from public.customer_checkout_intents where user_id=p_user order by created_at desc,id limit 10) i;
 return jsonb_build_object('userId',p_user,'serverTime',t,'displayName',coalesce((select display_name from public.customer_workspace_profiles where user_id=p_user),''),
  'availableMilliseconds',b->'availableMilliseconds','reservedMilliseconds',b->'reservedMilliseconds','spentMilliseconds',b->'spentMilliseconds',
  'buckets',buckets,'plans',plans,'payments',payments);
end $$;
revoke all on function public.customer_credits_read(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_credits_read(uuid,uuid) to service_role;

-- SOURCE supabase/migrations/20261011014422_account_checkout_unresolved_bound_guard.sql SHA256 a522b98c79389571d182995343905e0f66deddd5b9e46fdac525376aa593d428
-- Dedicated Account staging: align the account-locked create guard with the
-- server credit snapshot. REJECTED history is retained and never locks a new
-- request. An unpaid BOUND transaction remains unresolved; only same-owner
-- authoritative pack/recurring attribution releases that guard.
-- Do not put BOUND into the partial unique index: legitimate paid histories
-- retain that immutable transaction binding and repeat packs must still stack.
-- No existing intent, audit, payment, grant or user row is changed here.
create or replace function public.customer_checkout_prepare_core(p_user_id uuid,p_session_id uuid,p_request_id uuid,p_offer_code text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; r public.customer_checkout_intents%rowtype;
begin
  if p_request_id is null or p_offer_code is null or p_offer_code not in
    ('pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly') then
    return jsonb_build_object('code','INVALID');
  end if;
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  perform 1 from public.customer_accounts where user_id=p_user_id for update;
  -- Account lock is shared with authoritative billing and usage writers.
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  select * into r from public.customer_checkout_intents where user_id=p_user_id and request_id=p_request_id;
  if found then
    if r.offer_code<>p_offer_code then return jsonb_build_object('code','CONFLICT'); end if;
    return jsonb_build_object('code',case when r.state='BOUND' then 'BOUND' when r.state='REJECTED' then 'REJECTED' else 'PENDING' end,
      'intentId',r.id,'transactionId',r.transaction_id);
  end if;
  if exists(select 1 from public.customer_checkout_intents i where i.user_id=p_user_id and
    (i.state in ('CREATING','UNCERTAIN') or (i.state='BOUND'
      and not exists(select 1 from public.customer_pack_purchases p
        where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=p_user_id and p.state in ('ACTIVE','REFUNDED'))
      and not exists(select 1 from public.customer_recurring_terms t
        where t.transaction_id=i.transaction_id and t.user_id=p_user_id)))) then
    return jsonb_build_object('code','PENDING');
  end if;
  if (select count(*) from public.customer_checkout_intents where user_id=p_user_id and created_at>now()-interval '1 day')>=12 then
    return jsonb_build_object('code','RATE_LIMITED');
  end if;
  insert into public.customer_checkout_intents(user_id,request_id,offer_code)
    values(p_user_id,p_request_id,p_offer_code) returning * into r;
  return jsonb_build_object('code','CLAIMED','intentId',r.id,'attemptId',r.attempt_id);
end $$;
-- Remain internal to the existing catalog-gated service-only wrapper.
revoke all on function public.customer_checkout_prepare_core(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

-- Safe read capability for the verified current owner only. This does not
-- create/retry a transaction, contact Paddle, grant usage or resolve a lock.
-- The application must independently verify the returned bound transaction
-- before offering an explicit customer action to reopen Paddle Checkout.
create function public.customer_checkout_resume_read(p_user_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; pending_count integer; bound_intent public.customer_checkout_intents%rowtype;
begin
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  perform 1 from public.customer_accounts where user_id=p_user_id for update;
  a:=public.customer_authorize(p_user_id,p_session_id);
  if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
  select count(*) into pending_count from (select 1 from public.customer_checkout_intents i where i.user_id=p_user_id and
    (i.state in ('CREATING','UNCERTAIN') or (i.state='BOUND'
      and not exists(select 1 from public.customer_pack_purchases p
        where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=p_user_id and p.state in ('ACTIVE','REFUNDED'))
      and not exists(select 1 from public.customer_recurring_terms t
        where t.transaction_id=i.transaction_id and t.user_id=p_user_id))) limit 2) unresolved;
  if pending_count=0 then return jsonb_build_object('code','NOT_FOUND'); end if;
  if pending_count<>1 then return jsonb_build_object('code','PENDING'); end if;
  select * into bound_intent from public.customer_checkout_intents i where i.user_id=p_user_id and i.state='BOUND'
    and not exists(select 1 from public.customer_pack_purchases p
      where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=p_user_id and p.state in ('ACTIVE','REFUNDED'))
    and not exists(select 1 from public.customer_recurring_terms t
      where t.transaction_id=i.transaction_id and t.user_id=p_user_id);
  if not found then return jsonb_build_object('code','PENDING'); end if;
  -- Reopening payment is an explicit current action. Disabled/absent account
  -- offers retain the unresolved lock without exposing a resume capability;
  -- existing immutable replay and authoritative reconciliation stay intact.
  -- No extra catalog lock: the application rechecks this read after provider
  -- validation, preserving the existing catalog-before-account writer order.
  if not exists(select 1 from public.account_catalog_policy where offer_code=bound_intent.offer_code and enabled=true) then
    return jsonb_build_object('code','PENDING');
  end if;
  return jsonb_build_object('code','BOUND','intentId',bound_intent.id,'offerCode',bound_intent.offer_code,'transactionId',bound_intent.transaction_id);
end $$;
revoke all on function public.customer_checkout_resume_read(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_checkout_resume_read(uuid,uuid) to service_role;

-- Keep the shipped Credits & Usage DTO unchanged. Tighten derived payment
-- history to exact-owned attribution, matching the internal checkout guard.
create or replace function public.customer_credits_read(p_user uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path=''
set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; b jsonb; t timestamptz; buckets jsonb; plans jsonb; payments jsonb;
begin
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 b:=public.customer_usage_balance(p_user,p_session);
 if b->>'code'<>'ACTIVE' then return jsonb_build_object('code',b->>'code'); end if;
 t:=clock_timestamp();
 select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'grantedMilliseconds',granted,
  'spentMilliseconds',spent,'reservedMilliseconds',reserved,'availableMilliseconds',granted-spent-reserved) order by kind),'[]')
 into buckets from (
  select kind,sum(granted_ms) granted,sum(spent_ms) spent,sum(reserved_ms) reserved from (
   select case when source_key like 'admin-test:%' then 'TEST' when source_key like 'admin-%' then 'MANUAL' else kind end kind,
    granted_ms,spent_ms,reserved_ms from public.customer_usage_grants
   where user_id=p_user and state='ACTIVE' and starts_at<=t and (expires_at is null or expires_at>t)
   union all select 'TRIAL',900000,0,0 where not exists(
    select 1 from public.customer_usage_grants where user_id=p_user and source_key='lifetime-trial')
  ) eligible group by kind
 ) totals;
 select coalesce(jsonb_agg(jsonb_build_object('tier',s.tier,'state',r.state,'paymentState',s.state,
  'endsAt',r.ends_at,'cancelFuture',s.cancel_future)),'[]') into plans
 from (select * from public.customer_recurring_terms where user_id=p_user order by created_at desc,transaction_id limit 30) r
 join public.customer_recurring_subscriptions s on s.subscription_id=r.subscription_id;
 select coalesce(jsonb_agg(jsonb_build_object('offerCode',i.offer_code,'state',
  case when exists(select 1 from public.customer_pack_purchases p where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=p_user and p.state='REFUNDED')
    or exists(select 1 from public.customer_recurring_terms p where p.transaction_id=i.transaction_id and p.user_id=p_user and p.state='REFUNDED') then 'REFUNDED'
   when exists(select 1 from public.customer_pack_purchases p where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=p_user and p.state='ACTIVE')
    or exists(select 1 from public.customer_recurring_terms p where p.transaction_id=i.transaction_id and p.user_id=p_user) then 'VERIFIED'
   else i.state end,'createdAt',i.created_at) order by i.created_at desc),'[]') into payments
 from (select * from public.customer_checkout_intents where user_id=p_user order by created_at desc,id limit 10) i;
 return jsonb_build_object('userId',p_user,'serverTime',t,'displayName',coalesce((select display_name from public.customer_workspace_profiles where user_id=p_user),''),
  'availableMilliseconds',b->'availableMilliseconds','reservedMilliseconds',b->'reservedMilliseconds','spentMilliseconds',b->'spentMilliseconds',
  'buckets',buckets,'plans',plans,'payments',payments);
end $$;
revoke all on function public.customer_credits_read(uuid,uuid) from public,anon,authenticated;
grant execute on function public.customer_credits_read(uuid,uuid) to service_role;

-- SOURCE supabase/migrations/20261012013828_account_gateway_test_pack.sql SHA256 4cbc4a2d80db31390c00ab85a5a73c149efd7b95268df44f6184376608a283ba
-- Additive Account staging only. No Paddle row/audit is rewritten or removed.
-- Provider identities stay separate; all paid time uses the EXISTING shared ledger.
create table billing_private.payment_intents (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.customer_accounts(user_id),
 provider text not null check(provider in ('razorpay','stripe','paddle')), environment text not null check(environment='test'),
 account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'), request_id uuid not null, attempt_id uuid not null default gen_random_uuid(),
 offer_code text not null check(offer_code='pro_3_hours'), amount integer not null default 54900 check(amount=54900),
 currency text not null default 'INR' check(currency='INR'),
 state text not null check(state in ('CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED')),
 order_id text check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'), payment_id text check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),
 grant_id uuid, created_at timestamptz not null default clock_timestamp(),
 unique(provider,environment,user_id,request_id), unique(provider,environment,order_id), unique(provider,environment,payment_id),
 foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
 check(state not in ('BOUND','VERIFIED','REFUNDED') or order_id is not null),
 check(state<>'VERIFIED' or (payment_id is not null and grant_id is not null))
);
create unique index payment_one_unresolved on billing_private.payment_intents(user_id)
 where state in ('CREATING','BOUND','UNCERTAIN');
create index payment_intents_owner on billing_private.payment_intents(user_id,created_at desc,id);
create table billing_private.payment_events (
 provider text not null check(provider='razorpay'), environment text not null check(environment='test'),
 event_id text not null check(event_id ~ '^[A-Za-z0-9_-]{8,128}$'), account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),
 event_type text not null check(event_type in ('payment.captured','order.paid','refund.processed')),
 resource_id text not null, payment_id text not null check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),
 order_id text check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'), digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz not null check(isfinite(occurred_at)), received_at timestamptz not null default clock_timestamp(),
 state text not null default 'PENDING' check(state in ('PENDING','PROCESSED','QUARANTINED')),
 claim_id uuid, lease_until timestamptz, retry_at timestamptz not null default clock_timestamp(), attempts integer not null default 0,
 primary key(provider,environment,event_id)
);
create index payment_events_due on billing_private.payment_events(retry_at,received_at) where state='PENDING';
create table billing_private.payment_applications (
 provider text not null, environment text not null, event_id text not null,
 intent_id uuid not null references billing_private.payment_intents(id), action text not null check(action in ('GRANT','REFUND')),
 payment_id text not null, refund_id text, removed_ms bigint not null default 0 check(removed_ms>=0),
 evidence jsonb not null, before_row jsonb not null, after_row jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
 primary key(provider,environment,event_id),
 foreign key(provider,environment,event_id) references billing_private.payment_events(provider,environment,event_id)
);
create index payment_applications_intent on billing_private.payment_applications(intent_id,recorded_at);
create table billing_private.payment_diagnostics (
 id uuid primary key default gen_random_uuid(),intent_id uuid not null references billing_private.payment_intents(id),
 stage text not null check(stage in ('provider_request','binding','identity')),http_status integer check(http_status between 100 and 599),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table billing_private.payment_intents enable row level security;
alter table billing_private.payment_events enable row level security;
alter table billing_private.payment_applications enable row level security;
alter table billing_private.payment_diagnostics enable row level security;
revoke all on billing_private.payment_intents,billing_private.payment_events,billing_private.payment_applications from public,anon,authenticated,service_role;
revoke all on billing_private.payment_diagnostics from public,anon,authenticated,service_role;
create trigger payment_applications_immutable before update or delete or truncate on billing_private.payment_applications
 for each statement execute function billing_private.reject_checkout_audit_mutation();
alter table billing_private.payment_applications enable always trigger payment_applications_immutable;
create trigger payment_diagnostics_immutable before update or delete or truncate on billing_private.payment_diagnostics
 for each statement execute function billing_private.reject_checkout_audit_mutation();
alter table billing_private.payment_diagnostics enable always trigger payment_diagnostics_immutable;

create function public.account_payment_status(p_user uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; pending jsonb; history jsonb; resolved jsonb;
begin
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 select jsonb_build_object('id',id,'state',state,'offerCode',offer_code,'orderId',order_id) into pending
 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN') limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('offerCode',offer_code,'state',state,'createdAt',created_at) order by created_at desc),'[]') into history
 from (select * from billing_private.payment_intents where user_id=p_user order by created_at desc,id limit 10) h;
 select coalesce(jsonb_agg(order_id),'[]') into resolved from (select order_id from billing_private.payment_intents
  where user_id=p_user and state in ('VERIFIED','REFUNDED') order by created_at desc,id limit 50) r;
 return jsonb_build_object('code',case when pending is null then 'AVAILABLE' else 'PENDING' end,'userId',p_user,'pending',pending,'history',history,'resolvedOrderIds',resolved);
end $$;

create function public.account_payment_prepare(p_user uuid,p_session uuid,p_request uuid,p_account_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; i billing_private.payment_intents%rowtype;
begin
 if p_request is null or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('code','INVALID'); end if;
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 select * into i from billing_private.payment_intents where provider='razorpay' and environment='test' and user_id=p_user and request_id=p_request;
 if found then
  if i.account_digest<>p_account_digest then return jsonb_build_object('code','PENDING'); end if;
  return jsonb_build_object('code',i.state,'intentId',i.id,'orderId',i.order_id);
 end if;
 -- Old Paddle draft is quarantined by the disabled adapter, not deleted/recovered.
 -- A different gateway cannot bypass ANY unresolved new service operation.
 if exists(select 1 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN')) then return jsonb_build_object('code','PENDING'); end if;
 if not exists(select 1 from public.account_catalog_policy where offer_code='pro_3_hours' and enabled) then return jsonb_build_object('code','DISABLED'); end if;
 if (select count(*) from billing_private.payment_intents where user_id=p_user and created_at>clock_timestamp()-interval '1 hour')>=5 then return jsonb_build_object('code','RATE_LIMITED'); end if;
 insert into billing_private.payment_intents(user_id,provider,environment,account_digest,request_id,offer_code,state)
 values(p_user,'razorpay','test',p_account_digest,p_request,'pro_3_hours','CREATING') returning * into i;
 return jsonb_build_object('code','CLAIMED','intentId',i.id,'attemptId',i.attempt_id);
end $$;

create function public.account_payment_bind(p_intent uuid,p_attempt uuid,p_account_digest text,p_order text,p_diagnostic jsonb default '{}')
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i billing_private.payment_intents%rowtype; owner_id uuid;
begin
 select user_id into owner_id from billing_private.payment_intents where id=p_intent;
 if not found then return 'UNBOUND'; end if;
 perform 1 from public.customer_accounts where user_id=owner_id for update;
 select * into i from billing_private.payment_intents where id=p_intent for update;
 if i.attempt_id is distinct from p_attempt or i.account_digest is distinct from p_account_digest or i.provider<>'razorpay' then return 'CONFLICT'; end if;
 if p_diagnostic<>'{}'::jsonb then
  if jsonb_typeof(p_diagnostic)<>'object' or (p_diagnostic-array['stage','httpStatus'])<>'{}'::jsonb
   or p_diagnostic->>'stage' is null or p_diagnostic->>'stage' not in ('provider_request','binding','identity')
   or (p_diagnostic ? 'httpStatus' and (p_diagnostic->>'httpStatus')::integer not between 100 and 599) then return 'INVALID'; end if;
  insert into billing_private.payment_diagnostics(intent_id,stage,http_status)
  values(i.id,p_diagnostic->>'stage',(p_diagnostic->>'httpStatus')::integer);
 end if;
 if i.state<>'CREATING' then return i.state; end if;
 if p_order is null then
  update billing_private.payment_intents set state='UNCERTAIN' where id=i.id; return 'UNCERTAIN';
 end if;
 if p_order !~ '^order_[A-Za-z0-9]{8,64}$' then return 'INVALID'; end if;
 update billing_private.payment_intents set state='BOUND',order_id=p_order where id=i.id;
 return 'BOUND';
end $$;

create function public.account_payment_binding(p_order text,p_account_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i billing_private.payment_intents%rowtype;
begin
 select * into i from billing_private.payment_intents where provider='razorpay' and environment='test' and order_id=p_order and account_digest=p_account_digest;
 if not found then return jsonb_build_object('code','UNBOUND'); end if;
 return jsonb_build_object('code',i.state,'intentId',i.id,'userId',i.user_id,'orderId',i.order_id,'offerCode',i.offer_code);
end $$;

create function public.account_payment_receive(p_event jsonb,p_account_digest text)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e billing_private.payment_events%rowtype;
begin
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_event)<>'object' then return 'INVALID'; end if;
 insert into billing_private.payment_events(provider,environment,event_id,account_digest,event_type,resource_id,payment_id,order_id,digest,occurred_at)
 values('razorpay','test',p_event->>'eventId',p_account_digest,p_event->>'eventType',p_event->>'resourceId',p_event->>'paymentId',p_event->>'orderId',p_event->>'digest',(p_event->>'occurredAt')::timestamptz)
 on conflict do nothing;
 if found then return 'STORED'; end if;
 select * into strict e from billing_private.payment_events where provider='razorpay' and environment='test' and event_id=p_event->>'eventId' for update;
 if e.digest is distinct from p_event->>'digest' or e.account_digest<>p_account_digest
 or e.event_type is distinct from p_event->>'eventType' or e.resource_id is distinct from p_event->>'resourceId'
 or e.payment_id is distinct from p_event->>'paymentId' or e.order_id is distinct from p_event->>'orderId'
 or e.occurred_at is distinct from (p_event->>'occurredAt')::timestamptz then
  update billing_private.payment_events set state='QUARANTINED' where provider=e.provider and environment=e.environment and event_id=e.event_id;
  return 'CONFLICT';
 end if;
 return case when e.state='QUARANTINED' then 'CONFLICT' else 'DUPLICATE' end;
end $$;

create function public.account_payment_claim(p_account_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e billing_private.payment_events%rowtype; claim uuid:=gen_random_uuid();
begin
 select * into e from billing_private.payment_events where account_digest=p_account_digest and state='PENDING'
 and retry_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp()) and attempts<20
 order by received_at,event_id limit 1 for update skip locked;
 if not found then return jsonb_build_object('code','EMPTY'); end if;
 update billing_private.payment_events set claim_id=claim,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1
 where provider=e.provider and environment=e.environment and event_id=e.event_id;
 return jsonb_build_object('code','CLAIMED','eventId',e.event_id,'eventType',e.event_type,'resourceId',e.resource_id,
 'paymentId',e.payment_id,'orderId',e.order_id,'digest',e.digest,'claimId',claim);
end $$;

create function public.account_payment_retry(p_event text,p_claim uuid)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
begin
 update billing_private.payment_events set claim_id=null,lease_until=null,retry_at=clock_timestamp()+interval '1 minute'
 where event_id=p_event and claim_id=p_claim and state='PENDING';
 return case when found then 'PENDING' else 'CONFLICT' end;
end $$;

create function public.account_payment_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i billing_private.payment_intents%rowtype; e billing_private.payment_events%rowtype;
 before_value jsonb; grant_value uuid; removed bigint:=0; t timestamptz:=date_trunc('milliseconds',clock_timestamp()); action_value text:=p_evidence->>'action';
begin
 if jsonb_typeof(p_evidence) is distinct from 'object'
 or (p_evidence-array['action','intentId','orderId','paymentId','amount','currency','observedAt','refundId'])<>'{}'::jsonb
 or p_event is null or p_claim is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
 or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$'
 or p_evidence->>'observedAt' is null or p_evidence->>'paymentId' is null
 or action_value is null or action_value not in ('GRANT','REFUND') or p_evidence->>'amount' is distinct from '54900'
 or p_evidence->>'currency' is distinct from 'INR' or p_evidence->>'paymentId' !~ '^pay_[A-Za-z0-9]{8,64}$'
 or (p_evidence->>'observedAt')::timestamptz<t-interval '2 minutes' or (p_evidence->>'observedAt')::timestamptz>t+interval '5 seconds' then return jsonb_build_object('code','INVALID'); end if;
 select * into i from billing_private.payment_intents where id=(p_evidence->>'intentId')::uuid and provider='razorpay' and environment='test';
 if not found then return jsonb_build_object('code','UNBOUND'); end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into strict i from billing_private.payment_intents where id=i.id for update;
 select * into e from billing_private.payment_events where provider='razorpay' and environment='test' and event_id=p_event for update;
 if not found or e.state<>'PENDING' or e.claim_id is null or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=t or e.digest<>p_digest
 or e.account_digest<>p_account_digest or i.account_digest<>p_account_digest or i.order_id is distinct from p_evidence->>'orderId'
 or e.payment_id is distinct from p_evidence->>'paymentId' or (e.order_id is not null and e.order_id<>i.order_id)
 or i.state not in ('BOUND','VERIFIED','REFUNDED')
 or (i.payment_id is not null and i.payment_id<>p_evidence->>'paymentId') then return jsonb_build_object('code','CONFLICT'); end if;
 if action_value='GRANT' and (e.event_type not in ('payment.captured','order.paid') or p_evidence->>'refundId' is not null)
 or action_value='REFUND' and (e.event_type<>'refund.processed' or e.resource_id is distinct from p_evidence->>'refundId') then return jsonb_build_object('code','INVALID'); end if;
 before_value:=to_jsonb(i);
 if action_value='GRANT' and i.state='BOUND' then
  if not exists(select 1 from public.customer_accounts a join auth.users u on u.id=a.user_id
   where a.user_id=i.user_id and a.state='ACTIVE' and u.email is not null and u.email_confirmed_at is not null) then return jsonb_build_object('code','PENDING'); end if;
  insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at)
  values(i.user_id,'razorpay-test:'||i.order_id,'PACK',10800000,t) returning id into grant_value;
  update billing_private.payment_intents set state='VERIFIED',grant_id=grant_value,payment_id=p_evidence->>'paymentId' where id=i.id;
 elsif action_value='REFUND' and i.state<>'REFUNDED' then
  if i.grant_id is not null then
   perform public.customer_recurring_stop_grant(i.user_id,i.grant_id,t);
   if exists(select 1 from public.customer_usage_grants where id=i.grant_id and reserved_ms<>0) then raise exception 'Refund settlement incomplete'; end if;
   select granted_ms-spent_ms into removed from public.customer_usage_grants where id=i.grant_id;
   update public.customer_usage_grants set state='REVOKED' where id=i.grant_id;
  end if;
  -- Full refund before completion is a tombstone; late captures cannot resurrect it.
  update billing_private.payment_intents set state='REFUNDED',payment_id=p_evidence->>'paymentId' where id=i.id;
 end if;
 insert into billing_private.payment_applications(provider,environment,event_id,intent_id,action,payment_id,refund_id,removed_ms,evidence,before_row,after_row)
 select 'razorpay','test',e.event_id,i.id,action_value,p_evidence->>'paymentId',p_evidence->>'refundId',removed,p_evidence,before_value,to_jsonb(x)
 from billing_private.payment_intents x where x.id=i.id;
 update billing_private.payment_events set state='PROCESSED',claim_id=null,lease_until=null where provider=e.provider and environment=e.environment and event_id=e.event_id;
 return jsonb_build_object('code',(select state from billing_private.payment_intents where id=i.id));
end $$;

-- Preserve the strict desktop contract; old histories remain, new gateway rows
-- join only the ten-row reporting projection. Balance already reads shared grants.
alter function public.customer_credits_read(uuid,uuid) rename to customer_credits_read_paddle_base;
revoke all on function public.customer_credits_read_paddle_base(uuid,uuid) from public,anon,authenticated,service_role;
create function public.customer_credits_read(p_user uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare base jsonb; history jsonb;
begin
 base:=public.customer_credits_read_paddle_base(p_user,p_session);
 if base->>'userId' is distinct from p_user::text then return base; end if;
 select coalesce(jsonb_agg(value order by created desc),'[]') into history from (
  select value,(value->>'createdAt')::timestamptz created from jsonb_array_elements(base->'payments')
  union all select jsonb_build_object('offerCode',offer_code,'state',state,'createdAt',created_at),created_at
  from billing_private.payment_intents where user_id=p_user
  order by created desc limit 10
 ) h;
 return jsonb_set(base,'{payments}',history);
end $$;

revoke all on function public.account_payment_status(uuid,uuid),public.account_payment_prepare(uuid,uuid,uuid,text),
 public.account_payment_bind(uuid,uuid,text,text,jsonb),public.account_payment_binding(text,text),public.account_payment_receive(jsonb,text),
 public.account_payment_claim(text),public.account_payment_retry(text,uuid),public.account_payment_apply(text,uuid,text,text,jsonb),
 public.customer_credits_read(uuid,uuid) from public,anon,authenticated;
grant execute on function public.account_payment_status(uuid,uuid),public.account_payment_prepare(uuid,uuid,uuid,text),
 public.account_payment_bind(uuid,uuid,text,text,jsonb),public.account_payment_binding(text,text),public.account_payment_receive(jsonb,text),
 public.account_payment_claim(text),public.account_payment_retry(text,uuid),public.account_payment_apply(text,uuid,text,text,jsonb),
 public.customer_credits_read(uuid,uuid) to service_role;

-- SOURCE supabase/migrations/20261013021137_cluera_release_distribution.sql SHA256 9ff672ca099578ffdbc7135be15b382d0981b5da4bce94b9e1c011b99a9abc3e
-- Cluera-only release registry. Existing Account releases, users, balances and financial tables are not rewritten.
-- Separate account TEST product only. No legacy release/financial tables changed.
create table public.cluera_releases (
 id uuid primary key,
 version text not null unique,
 payload jsonb not null,
 state text not null default 'DRAFT' check(state in ('DRAFT','PUBLISHED','WITHDRAWN')),
 created_at timestamptz not null default clock_timestamp(),
 published_at timestamptz,
 check(jsonb_typeof(payload)='object'),
 check(state='DRAFT' or published_at is not null)
);
create index cluera_releases_latest on public.cluera_releases(published_at desc,id) where state='PUBLISHED';
alter table public.cluera_releases enable row level security;
revoke all on public.cluera_releases from public,anon,authenticated,service_role;

create function public.cluera_release_latest() returns jsonb
language sql security definer set search_path='' as $$
 select payload || jsonb_build_object('id',id,'state',state,'publishedAt',published_at)
 from public.cluera_releases where state='PUBLISHED' order by published_at desc,id limit 1;
$$;
revoke all on function public.cluera_release_latest() from public,anon,authenticated;
grant execute on function public.cluera_release_latest() to service_role;

create function public.cluera_release_admin(p_actor uuid,p_session uuid,p_action text,
 p_operation uuid default null,p_reason text default null,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit; r public.cluera_releases; latest public.cluera_releases;
 ident uuid; v text; minv text; result jsonb; detail jsonb;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_action='LIST' then
  return jsonb_build_object('code','ACTIVE','releases',coalesce((select jsonb_agg(x.data) from (
   select payload||jsonb_build_object('id',id,'state',state,'publishedAt',published_at) data
   from public.cluera_releases order by created_at desc,id limit 50) x),'[]'::jsonb));
 end if;
 if p_action not in ('DRAFT','PUBLISH','WITHDRAW') or p_operation is null or p_reason is null
  or length(trim(p_reason)) not between 10 and 500 or jsonb_typeof(p_input) is distinct from 'object'
 then return jsonb_build_object('code','INVALID'); end if;
 perform pg_advisory_xact_lock(1936879982,1129076037);
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
  if prior.actor_id=p_actor and prior.action='CLUERA_RELEASE_'||p_action and prior.reason=trim(p_reason)
    and prior.detail->'input'=p_input then return jsonb_build_object('code','APPLIED','releaseId',prior.detail->'releaseId'); end if;
  return jsonb_build_object('code','CONFLICT');
 end if;
 if p_action='DRAFT' then
  if (p_input-array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])<>'{}'::jsonb
   or not(p_input ?& array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])
   then return jsonb_build_object('code','INVALID'); end if;
  v:=p_input->>'version'; minv:=p_input->>'minimumSupportedVersion';
  if v !~ '^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})$'
   or minv !~ '^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})$'
   or string_to_array(minv,'.')::bigint[]>string_to_array(v,'.')::bigint[]
   or p_input->>'sha256' !~ '^[a-f0-9]{64}$' or p_input->>'updateType' not in ('OPTIONAL','RECOMMENDED','REQUIRED')
   or jsonb_typeof(p_input->'fileSizeBytes')<>'number' or (p_input->>'fileSizeBytes')::bigint not between 1 and 536870912
   or jsonb_typeof(p_input->'releaseNotes')<>'string' or length(p_input->>'releaseNotes')>2000
   or p_input->>'downloadUrl' !~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/ClueraAITestSetup-[0-9.]+[.]exe$'
   or right(p_input->>'downloadUrl',length('/ClueraAITestSetup-'||v||'.exe'))<>'/ClueraAITestSetup-'||v||'.exe'
   or exists(select 1 from jsonb_each(p_input) e where e.value='null'::jsonb)
  then return jsonb_build_object('code','INVALID'); end if;
  if exists(select 1 from public.cluera_releases where version=v) then return jsonb_build_object('code','CONFLICT'); end if;
  ident:=p_operation;
  insert into public.cluera_releases(id,version,payload) values(ident,v,p_input);
 else
  ident:=(p_input->>'id')::uuid;
  select * into r from public.cluera_releases where id=ident for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if p_action='PUBLISH' then
   if (p_input-array['id','verifiedHostedSha256','verifiedFileSizeBytes','confirmedAccountInstaller'])<>'{}'::jsonb
    or p_input->>'verifiedHostedSha256' is distinct from r.payload->>'sha256'
    or p_input->'verifiedFileSizeBytes' is distinct from r.payload->'fileSizeBytes'
    or p_input->'confirmedAccountInstaller' is distinct from 'true'::jsonb or r.state<>'DRAFT'
   then return jsonb_build_object('code','INVALID'); end if;
   select * into latest from public.cluera_releases where published_at is not null
    order by string_to_array(version,'.')::bigint[] desc limit 1;
   if found and string_to_array(r.version,'.')::bigint[]<=string_to_array(latest.version,'.')::bigint[]
    then return jsonb_build_object('code','CONFLICT'); end if;
   update public.cluera_releases set state='PUBLISHED',published_at=clock_timestamp() where id=ident;
  else
   if p_input- 'id'<>'{}'::jsonb or r.state<>'PUBLISHED' then return jsonb_build_object('code','INVALID'); end if;
   update public.cluera_releases set state='WITHDRAWN' where id=ident;
  end if;
 end if;
 detail:=jsonb_build_object('input',p_input,'releaseId',ident);
 insert into public.account_admin_audit(operation_id,actor_id,action,reason,detail)
  values(p_operation,p_actor,'CLUERA_RELEASE_'||p_action,trim(p_reason),detail);
 return jsonb_build_object('code','APPLIED','releaseId',ident);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then
 return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.cluera_release_admin(uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.cluera_release_admin(uuid,uuid,text,uuid,text,jsonb) to service_role;

-- SOURCE docs/proposals/cluera-billing.sql SHA256 473a81c727faf3448b682e70d95956fd67de4e01bd2af7914539fec7fb56e50d
-- Independent local standby owner only; this is NOT a cross-project financial handoff.
-- UNAPPLIED REVIEW PROPOSAL. Do not execute against the retained database without
-- separate schema approval. This file does NOT switch scheduler/webhook URLs,
-- import secrets, activate checkout, change a historical financial row or grant.
-- New recurring purchases conservatively reject competing old/new recurring
-- entitlements; automatic cross-provider pause/queue/cancel is NOT implemented.
create schema cluera_billing_private;
revoke all on schema cluera_billing_private from public,anon,authenticated,service_role;

create table cluera_billing_private.catalog_revisions (
 id uuid primary key default gen_random_uuid(), offer_code text not null check(offer_code in
 ('cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2')),
 version integer not null check(version>0), name text not null check(length(trim(name)) between 2 and 80),
 amount_paise integer not null check(amount_paise between 100 and 10000000), currency text not null default 'INR' check(currency='INR'),
 allowance_seconds integer not null check(allowance_seconds between 60 and 3600000),
 kind text not null check(kind in ('PACK','RECURRING')), interval_name text check(interval_name='MONTH'),
 razorpay_plan_id text check(razorpay_plan_id ~ '^plan_[A-Za-z0-9]{8,64}$'),total_count integer check(total_count between 1 and 120),created_at timestamptz not null default clock_timestamp(),
 unique(offer_code,version),unique(offer_code,id),
 check((kind='PACK' and interval_name is null and razorpay_plan_id is null and total_count is null and offer_code='cluera_pack_3h_v2')
 or(kind='RECURRING' and interval_name='MONTH' and total_count is not null and offer_code<>'cluera_pack_3h_v2'))
);
create table cluera_billing_private.catalog_heads (
 offer_code text primary key, revision_id uuid not null, enabled boolean not null default false,
 foreign key(offer_code,revision_id) references cluera_billing_private.catalog_revisions(offer_code,id)
);
insert into cluera_billing_private.catalog_revisions(offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,total_count) values
 ('cluera_pack_3h_v2',1,'Cluera 3 Hours',54900,10800,'PACK',null,null),
 ('cluera_monthly_40h_v2',1,'Cluera Pro 40 Hours Monthly',549900,144000,'RECURRING','MONTH',120),
 ('cluera_monthly_100h_v2',1,'Cluera Pro 100 Hours Monthly',959900,360000,'RECURRING','MONTH',120),
 ('cluera_monthly_200h_v2',1,'Cluera Enterprise 200 Hours Monthly',1954900,720000,'RECURRING','MONTH',120);
insert into cluera_billing_private.catalog_heads(offer_code,revision_id) select offer_code,id from cluera_billing_private.catalog_revisions;
create table cluera_billing_private.plan_verifications (
 revision_id uuid not null references cluera_billing_private.catalog_revisions(id),account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),
 evidence jsonb not null,observed_at timestamptz not null,primary key(revision_id,account_digest)
);
create table cluera_billing_private.admin_audit (
 operation_id uuid primary key,actor_id uuid not null references public.account_admin_profiles(user_id),session_id uuid not null,
 action text not null,reason text not null check(length(trim(reason)) between 10 and 500),input jsonb not null,before_row jsonb not null,after_row jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.processing_owner (
 singleton boolean primary key default true check(singleton),owner text not null check(owner in ('account','cluera')),
 epoch bigint not null check(epoch>0),account_digest text check(account_digest ~ '^[a-f0-9]{64}$'),
 changed_at timestamptz not null default clock_timestamp()
);
-- Policy only: old handlers continue unchanged until a separately approved CAS.
insert into cluera_billing_private.processing_owner(singleton,owner,epoch) values(true,'cluera',1);
create table cluera_billing_private.cutover_audit (
 operation_id uuid primary key,reason text not null check(length(trim(reason)) between 10 and 500),
 before_row jsonb not null,after_row jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.worker_nonces (
 nonce uuid primary key,epoch bigint not null,issued_at timestamptz not null,consumed_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.intents (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.customer_accounts(user_id),request_id uuid not null,
 attempt_id uuid not null default gen_random_uuid(),revision_id uuid not null references cluera_billing_private.catalog_revisions(id),
 account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),epoch bigint not null,
 state text not null check(state in ('CREATING','BOUND','UNCERTAIN','VERIFIED','REFUNDED')),
 order_id text unique check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'),subscription_id text unique check(subscription_id ~ '^sub_[A-Za-z0-9]{8,64}$'),
 created_at timestamptz not null default clock_timestamp(),unique(user_id,request_id),unique(user_id,id),
 check(state not in ('BOUND','VERIFIED','REFUNDED') or order_id is not null or subscription_id is not null)
);
create unique index cluera_one_unresolved_intent on cluera_billing_private.intents(user_id) where state in ('CREATING','BOUND','UNCERTAIN');
create index cluera_intents_owner on cluera_billing_private.intents(user_id,created_at desc,id);
create table cluera_billing_private.events (
 event_id text primary key check(event_id ~ '^[A-Za-z0-9_-]{8,128}$'),account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),
 event_type text not null check(event_type in ('payment.captured','order.paid','refund.processed','subscription.charged','subscription.activated',
 'subscription.pending','subscription.halted','subscription.cancelled','subscription.paused','subscription.resumed','subscription.completed','subscription.authenticated','subscription.updated')),
 resource_id text not null, payment_id text check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),order_id text check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'),
 subscription_id text check(subscription_id ~ '^sub_[A-Za-z0-9]{8,64}$'),invoice_id text check(invoice_id ~ '^inv_[A-Za-z0-9]{8,64}$'),
 digest text not null check(digest ~ '^[a-f0-9]{64}$'),occurred_at timestamptz not null check(isfinite(occurred_at)),
 received_at timestamptz not null default clock_timestamp(),state text not null default 'PENDING' check(state in ('PENDING','PROCESSED','QUARANTINED')),
 claim_id uuid,lease_until timestamptz,retry_at timestamptz not null default clock_timestamp(),attempts integer not null default 0
);
create index cluera_events_due on cluera_billing_private.events(retry_at,received_at,event_id) where state='PENDING';
create table cluera_billing_private.subscriptions (
 subscription_id text primary key,user_id uuid not null references public.customer_accounts(user_id),intent_id uuid not null references cluera_billing_private.intents(id),
 revision_id uuid not null references cluera_billing_private.catalog_revisions(id),account_digest text not null,
 state text not null check(state in ('ACTIVE','PAST_DUE','CANCELED','PAUSED')),observed_at timestamptz not null,
 paid_through timestamptz,grace_until timestamptz,cancel_future boolean not null default false,
 cancellation_at timestamptz check(cancellation_at is null or isfinite(cancellation_at)),unique(user_id,subscription_id)
);
create table cluera_billing_private.payments (
 payment_id text primary key check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),order_id text not null unique,
 intent_id uuid not null references cluera_billing_private.intents(id),user_id uuid not null references public.customer_accounts(user_id),
 invoice_id text unique check(invoice_id ~ '^inv_[A-Za-z0-9]{8,64}$'),subscription_id text references cluera_billing_private.subscriptions(subscription_id),
 amount_paise integer not null,revision_id uuid not null references cluera_billing_private.catalog_revisions(id),grant_id uuid,
 state text not null check(state in ('VERIFIED','REFUNDED')),period_start timestamptz,period_end timestamptz,
 paid_at timestamptz check(paid_at is null or isfinite(paid_at)),
 foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
 check((subscription_id is null and invoice_id is null and period_start is null and period_end is null and paid_at is null)
 or(subscription_id is not null and invoice_id is not null and period_end>period_start and paid_at is not null))
);
create table cluera_billing_private.terms (
 invoice_id text primary key references cluera_billing_private.payments(invoice_id),user_id uuid not null,
 subscription_id text not null,grant_id uuid,state text not null check(state in ('ACTIVE','QUEUED','PAUSED','ENDED','REFUNDED')),
 period_start timestamptz not null,period_end timestamptz not null,ends_at timestamptz not null,
 foreign key(user_id,subscription_id) references cluera_billing_private.subscriptions(user_id,subscription_id),
 foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),unique(subscription_id,period_start),
 check(period_end>period_start and isfinite(period_start) and isfinite(period_end))
);
create unique index cluera_one_active_term on cluera_billing_private.terms(user_id) where state in ('ACTIVE','PAUSED');
create index cluera_terms_due_queue on cluera_billing_private.terms(user_id,period_start,invoice_id) where state='QUEUED';
create table cluera_billing_private.applications (
 event_id text primary key references cluera_billing_private.events(event_id),intent_id uuid not null references cluera_billing_private.intents(id),
 action text not null check(action in ('GRANT','REFUND','STATUS')),evidence jsonb not null,before_row jsonb not null,after_row jsonb not null,
 removed_ms bigint not null default 0 check(removed_ms>=0),created_at timestamptz not null default clock_timestamp()
);

create function cluera_billing_private.immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='42501',message='Cluera billing record is immutable';end$$;
do $$declare t text;begin
 foreach t in array array['catalog_revisions','catalog_heads','plan_verifications','admin_audit','processing_owner','cutover_audit','worker_nonces','intents','events','subscriptions','payments','terms','applications'] loop
 execute format('alter table cluera_billing_private.%I enable row level security',t);
 execute format('revoke all on cluera_billing_private.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['catalog_revisions','plan_verifications','admin_audit','cutover_audit','worker_nonces','applications'] loop
 execute format('create trigger immutable before update or delete or truncate on cluera_billing_private.%I for each statement execute function cluera_billing_private.immutable()',t);
 execute format('alter table cluera_billing_private.%I enable always trigger immutable',t);
 end loop;
end$$;
create function public.cluera_billing_worker_nonce(p_nonce uuid,p_issued_at timestamptz,p_epoch bigint,p_account_digest text) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if p_nonce is null or p_epoch is null or p_issued_at is null or not isfinite(p_issued_at)
 or p_issued_at<clock_timestamp()-interval '60 seconds' or p_issued_at>clock_timestamp()+interval '5 seconds' then return 'INVALID';end if;
 if cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return 'UNAVAILABLE';end if;
 insert into cluera_billing_private.worker_nonces(nonce,epoch,issued_at) values(p_nonce,p_epoch,p_issued_at) on conflict do nothing;
 return case when found then 'CLAIMED' else 'REPLAY' end;
end$$;

create function public.cluera_billing_event_accept(p_event jsonb,p_account_digest text) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e cluera_billing_private.events;occurred timestamptz;begin
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_event) is distinct from 'object'
 or (p_event-array['eventId','eventType','resourceId','paymentId','orderId','subscriptionId','invoiceId','digest','occurredAt'])<>'{}'::jsonb
 or p_event->>'eventId' is null or p_event->>'digest' is null or p_event->>'resourceId' is null then return 'INVALID';end if;
 begin occurred:=(p_event->>'occurredAt')::timestamptz;exception when others then return 'INVALID';end;
 if occurred is null or not isfinite(occurred) then return 'INVALID';end if;
 -- The old canonical order keeps the SAME receipt, intent, unique grant key and
 -- immutable application audits. Never copy it into the new financial tables.
 if exists(select 1 from billing_private.payment_intents where order_id=p_event->>'orderId' and account_digest=p_account_digest)
 or exists(select 1 from billing_private.payment_events where event_id=p_event->>'eventId') then
 if p_event->>'eventType' not in ('payment.captured','order.paid','refund.processed') or p_event->>'paymentId' is null then return 'INVALID';end if;
 return public.account_payment_receive(p_event-array['subscriptionId','invoiceId'],p_account_digest);
 end if;
 insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,payment_id,order_id,subscription_id,invoice_id,digest,occurred_at)
 values(p_event->>'eventId',p_account_digest,p_event->>'eventType',p_event->>'resourceId',p_event->>'paymentId',p_event->>'orderId',p_event->>'subscriptionId',p_event->>'invoiceId',p_event->>'digest',occurred)
 on conflict do nothing;
 if found then return 'STORED';end if;
 select * into strict e from cluera_billing_private.events where event_id=p_event->>'eventId' for update;
 if e.account_digest<>p_account_digest or e.event_type is distinct from p_event->>'eventType' or e.resource_id is distinct from p_event->>'resourceId'
 or e.payment_id is distinct from p_event->>'paymentId' or e.order_id is distinct from p_event->>'orderId' or e.subscription_id is distinct from p_event->>'subscriptionId'
 or e.invoice_id is distinct from p_event->>'invoiceId' or e.digest is distinct from p_event->>'digest' or e.occurred_at is distinct from occurred then
 update cluera_billing_private.events set state='QUARANTINED' where event_id=e.event_id;return 'CONFLICT';end if;
 return case when e.state='QUARANTINED' then 'CONFLICT' else 'DUPLICATE' end;
end$$;
create function public.cluera_billing_event_claim(p_account_digest text,p_epoch bigint) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e cluera_billing_private.events;c uuid:=gen_random_uuid();legacy jsonb;oldest_new timestamptz;oldest_old timestamptz;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 select min(received_at) into oldest_new from cluera_billing_private.events where account_digest=p_account_digest and state='PENDING' and retry_at<=clock_timestamp()
 and (lease_until is null or lease_until<clock_timestamp()) and attempts<20;
 select min(received_at) into oldest_old from billing_private.payment_events where account_digest=p_account_digest and state='PENDING' and retry_at<=clock_timestamp()
 and (lease_until is null or lease_until<clock_timestamp()) and attempts<20;
 -- One chronological selection across both durable inboxes, not permanent
 -- priority for an old endpoint that could starve current Cluera receipts.
 if oldest_old is not null and (oldest_new is null or oldest_old<=oldest_new) then
 legacy:=public.account_payment_claim_account_base(p_account_digest);
 if legacy->>'code'='CLAIMED' then return legacy||jsonb_build_object('legacy',true,'subscriptionId',null,'invoiceId',null,
 'occurredAt',(select occurred_at from billing_private.payment_events where event_id=legacy->>'eventId'));end if;
 end if;
 select * into e from cluera_billing_private.events where account_digest=p_account_digest and state='PENDING' and retry_at<=clock_timestamp()
 and (lease_until is null or lease_until<clock_timestamp()) and attempts<20 order by received_at,event_id limit 1 for update skip locked;
 if not found then
 legacy:=public.account_payment_claim_account_base(p_account_digest);
 return case when legacy->>'code'='CLAIMED' then legacy||jsonb_build_object('legacy',true,'subscriptionId',null,'invoiceId',null,
 'occurredAt',(select occurred_at from billing_private.payment_events where event_id=legacy->>'eventId')) else jsonb_build_object('code','EMPTY') end;end if;
 update cluera_billing_private.events set claim_id=c,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 where event_id=e.event_id;
 return jsonb_build_object('code','CLAIMED','legacy',false,'eventId',e.event_id,'eventType',e.event_type,'resourceId',e.resource_id,
 'paymentId',e.payment_id,'orderId',e.order_id,'subscriptionId',e.subscription_id,'invoiceId',e.invoice_id,'digest',e.digest,'occurredAt',e.occurred_at,'claimId',c);
end$$;
create function public.cluera_billing_event_finish(p_event text,p_claim uuid,p_epoch bigint,p_retry boolean) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare d text;begin
 if p_claim is null or p_epoch is null or p_retry is distinct from true then return 'INVALID';end if;
 select account_digest into d from cluera_billing_private.events where event_id=p_event;
 if not found then select account_digest into d from billing_private.payment_events where event_id=p_event;end if;
 if cluera_billing_private.owns(d,'cluera',p_epoch) is not true then return 'UNAVAILABLE';end if;
 if exists(select 1 from billing_private.payment_events where event_id=p_event) then return public.account_payment_retry(p_event,p_claim);end if;
 update cluera_billing_private.events set claim_id=null,lease_until=null,retry_at=clock_timestamp()+interval '1 minute'
 where event_id=p_event and claim_id=p_claim and state='PENDING';return case when found then 'PENDING' else 'CONFLICT' end;
end$$;

-- Account lock first. Future paid invoices are funded but PAUSED until their
-- exact immutable billing start; accepting one never ends today's paid cycle.
create function cluera_billing_private.refresh(p_user uuid,p_at timestamptz) returns void
language plpgsql security invoker set search_path='' as $$declare t record;q record;s cluera_billing_private.subscriptions;target timestamptz;begin
 if p_at is null or not isfinite(p_at) then return;end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 for t in select * from cluera_billing_private.terms where user_id=p_user and state in ('ACTIVE','PAUSED') and ends_at<=p_at order by invoice_id for update loop
 select * into strict s from cluera_billing_private.subscriptions where subscription_id=t.subscription_id;
 target:=case when s.state='PAST_DUE' and not s.cancel_future and s.paid_through=t.period_end then s.grace_until else null end;
 if target is not null and target>p_at then
 update cluera_billing_private.terms set ends_at=target where invoice_id=t.invoice_id;
 update public.customer_usage_grants set expires_at=target where id=t.grant_id;
 else
 if t.grant_id is not null then perform public.customer_recurring_stop_grant(p_user,t.grant_id,least(p_at,t.ends_at));
 update public.customer_usage_grants set state='REVOKED' where id=t.grant_id;end if;
 update cluera_billing_private.terms set state='ENDED' where invoice_id=t.invoice_id;
 end if;
 end loop;
 for q in select * from cluera_billing_private.terms where user_id=p_user and state='QUEUED' and period_start<=p_at
 order by period_start,invoice_id for update loop
 select * into strict s from cluera_billing_private.subscriptions where subscription_id=q.subscription_id;
 target:=case when s.state='PAST_DUE' and not s.cancel_future and s.paid_through=q.period_end then s.grace_until else null end;
 if q.ends_at<=p_at and (target is null or target<=p_at) then
 update public.customer_usage_grants set state='REVOKED' where id=q.grant_id;
 update cluera_billing_private.terms set state='ENDED' where invoice_id=q.invoice_id;continue;
 end if;
 -- Do not activate behind a separately funded legacy/other subscription.
 -- The original paid invoice remains QUEUED for explicit conflict review.
 if exists(select 1 from public.customer_recurring_terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=p_user and subscription_id<>q.subscription_id
 and state in ('ACTIVE','PAUSED') and ends_at>p_at) then continue;end if;
 for t in select * from cluera_billing_private.terms where user_id=p_user and subscription_id=q.subscription_id
 and state in ('ACTIVE','PAUSED') order by period_start,invoice_id for update loop
 if t.grant_id is not null then
 perform public.customer_recurring_stop_grant(p_user,t.grant_id,least(q.period_start,t.ends_at));
 update public.customer_usage_grants set state='REVOKED' where id=t.grant_id;end if;
 update cluera_billing_private.terms set state='ENDED' where invoice_id=t.invoice_id;
 end loop;
 target:=greatest(q.ends_at,coalesce(target,q.ends_at));
 update public.customer_usage_grants set state=case when s.state='PAUSED' then 'PAUSED' else 'ACTIVE' end,
 expires_at=target where id=q.grant_id and state='PAUSED';
 update cluera_billing_private.terms set state=case when s.state='PAUSED' then 'PAUSED' else 'ACTIVE' end,
 ends_at=target where invoice_id=q.invoice_id;
 end loop;
end$$;
create function public.cluera_billing_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;e cluera_billing_private.events;s cluera_billing_private.subscriptions;
 paid cluera_billing_private.payments;observed timestamptz;ps timestamptz;pe timestamptz;paid_at_value timestamptz;cancel_at_value timestamptz;cutoff timestamptz;
 t timestamptz:=date_trunc('milliseconds',clock_timestamp());
 action_value text:=p_evidence->>'action';grant_value uuid;removed bigint:=0;before_value jsonb;state_value text;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 if jsonb_typeof(p_evidence) is distinct from 'object' or (p_evidence-array['action','intentId','orderId','paymentId','invoiceId','subscriptionId','amountPaise','currency','observedAt','periodStart','periodEnd','subscriptionState','refundId','paidAt','cancellationAt'])<>'{}'::jsonb
 or action_value is null or action_value not in ('GRANT','REFUND','STATUS') or p_event is null or p_claim is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('code','INVALID');end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;ps:=(p_evidence->>'periodStart')::timestamptz;pe:=(p_evidence->>'periodEnd')::timestamptz;
 paid_at_value:=(p_evidence->>'paidAt')::timestamptz;cancel_at_value:=(p_evidence->>'cancellationAt')::timestamptz;
 select * into i from cluera_billing_private.intents where id=(p_evidence->>'intentId')::uuid;
 exception when others then return jsonb_build_object('code','INVALID');end;
 if i.id is null then return jsonb_build_object('code','UNBOUND');end if;
 if observed is null or not isfinite(observed) or observed<t-interval '2 minutes' or observed>t+interval '5 seconds' then return jsonb_build_object('code','INVALID');end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into strict i from cluera_billing_private.intents where id=i.id for update;
 select * into strict r from cluera_billing_private.catalog_revisions where id=i.revision_id;
 -- Creation epoch is provenance; current worker epoch above fences fulfillment
 -- after approved rollback/re-cutover, with the same immutable unique sources.
 select * into e from cluera_billing_private.events where event_id=p_event for update;
 if not found or e.state<>'PENDING' or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=t
 or e.digest<>p_digest or e.account_digest<>p_account_digest or i.account_digest<>p_account_digest
 or i.state not in ('BOUND','VERIFIED','REFUNDED') then return jsonb_build_object('code','CONFLICT');end if;
 -- Captured/charged payloads may omit order/subscription/invoice links. Missing
 -- links are resolved only by independent provider GETs and canonical binding;
 -- any PRESENT signed link still has to match exactly.
 if (action_value<>'STATUS' and e.payment_id is not null and e.payment_id is distinct from p_evidence->>'paymentId')
 or (action_value<>'STATUS' and e.order_id is not null and e.order_id is distinct from p_evidence->>'orderId')
 or (e.subscription_id is not null and e.subscription_id is distinct from p_evidence->>'subscriptionId')
 or (action_value<>'STATUS' and e.invoice_id is not null and e.invoice_id is distinct from p_evidence->>'invoiceId') then return jsonb_build_object('code','CONFLICT');end if;
 if (e.event_type='payment.captured' and e.resource_id is distinct from p_evidence->>'paymentId')
 or (e.event_type='order.paid' and e.resource_id is distinct from p_evidence->>'orderId')
 or (e.event_type='subscription.charged' and e.resource_id is distinct from p_evidence->>'subscriptionId') then return jsonb_build_object('code','CONFLICT');end if;
 if action_value='GRANT' and e.event_type in ('payment.captured','subscription.charged') and e.payment_id is null then return jsonb_build_object('code','INVALID');end if;
 if r.kind='PACK' and (i.order_id is distinct from p_evidence->>'orderId' or p_evidence->>'subscriptionId' is not null or p_evidence->>'invoiceId' is not null or ps is not null or pe is not null or paid_at_value is not null or cancel_at_value is not null or action_value='STATUS')
 or r.kind='RECURRING' and (i.subscription_id is distinct from p_evidence->>'subscriptionId'
 or (p_evidence->>'subscriptionState' is null and not(action_value='STATUS' and e.event_type='subscription.authenticated'))
 or (p_evidence->>'subscriptionState' is not null and p_evidence->>'subscriptionState' not in ('ACTIVE','PAST_DUE','CANCELED','PAUSED'))
 or (p_evidence->>'subscriptionState'='CANCELED' and (cancel_at_value is null or not isfinite(cancel_at_value) or cancel_at_value>observed+interval '5 seconds'))
 or (p_evidence->>'subscriptionState' is distinct from 'CANCELED' and cancel_at_value is not null)) then return jsonb_build_object('code','INVALID');end if;
 if action_value<>'STATUS' and (p_evidence->>'currency' is distinct from 'INR' or p_evidence->>'amountPaise' is distinct from r.amount_paise::text
 or p_evidence->>'orderId' is null or p_evidence->>'orderId' !~ '^order_[A-Za-z0-9]{8,64}$'
 or p_evidence->>'paymentId' is null or p_evidence->>'paymentId' !~ '^pay_[A-Za-z0-9]{8,64}$'
 or (r.kind='RECURRING' and (p_evidence->>'invoiceId' is null or p_evidence->>'invoiceId' !~ '^inv_[A-Za-z0-9]{8,64}$'
 or ps is null or pe is null or not isfinite(ps) or not isfinite(pe) or ps>t+interval '32 days' or pe-ps not between interval '27 days' and interval '32 days'
 or paid_at_value is null or not isfinite(paid_at_value) or paid_at_value>observed+interval '5 seconds')))
 then return jsonb_build_object('code','INVALID');end if;
 if (action_value='GRANT' and (e.event_type not in ('payment.captured','order.paid','subscription.charged') or p_evidence->>'refundId' is not null))
 or (action_value='REFUND' and (e.event_type<>'refund.processed' or p_evidence->>'refundId' is null or p_evidence->>'refundId' !~ '^rfnd_[A-Za-z0-9]{8,64}$' or e.resource_id is distinct from p_evidence->>'refundId'))
 or (action_value='STATUS' and (e.event_type not like 'subscription.%' or e.event_type='subscription.charged' or e.resource_id is distinct from i.subscription_id
 or p_evidence->>'paymentId' is not null or p_evidence->>'orderId' is not null or p_evidence->>'invoiceId' is not null or ps is not null or pe is not null or paid_at_value is not null)) then return jsonb_build_object('code','INVALID');end if;
 -- Validate every rejection path BEFORE mutable subscription/term metadata.
 -- A CONFLICT/REVIEW/PENDING result is a no-op on all financial business rows;
 -- only the previously acquired receipt lease exists outside this transaction.
 if r.kind='RECURRING' then
 select * into s from cluera_billing_private.subscriptions where subscription_id=i.subscription_id for update;
 if s.subscription_id is not null and (s.user_id<>i.user_id or s.revision_id<>r.id or s.account_digest<>p_account_digest) then return jsonb_build_object('code','CONFLICT');end if;
 end if;
 if action_value<>'STATUS' then
 select * into paid from cluera_billing_private.payments where payment_id=p_evidence->>'paymentId' or order_id=p_evidence->>'orderId' or invoice_id=p_evidence->>'invoiceId' for update;
 if paid.payment_id is not null and (paid.payment_id is distinct from p_evidence->>'paymentId' or paid.order_id is distinct from p_evidence->>'orderId'
 or paid.intent_id<>i.id or paid.user_id<>i.user_id or paid.revision_id<>r.id or paid.amount_paise<>r.amount_paise or paid.invoice_id is distinct from p_evidence->>'invoiceId'
 or paid.subscription_id is distinct from p_evidence->>'subscriptionId' or paid.period_start is distinct from ps or paid.period_end is distinct from pe or paid.paid_at is distinct from paid_at_value) then return jsonb_build_object('code','CONFLICT');end if;
 if exists(select 1 from billing_private.payment_intents where order_id=p_evidence->>'orderId' or payment_id=p_evidence->>'paymentId')
 or (r.kind='RECURRING' and exists(select 1 from cluera_billing_private.terms where subscription_id=i.subscription_id and period_start=ps and invoice_id is distinct from p_evidence->>'invoiceId')) then return jsonb_build_object('code','CONFLICT');end if;
 if paid.payment_id is null and action_value='GRANT' then
 if i.state='REFUNDED' and r.kind='PACK' then return jsonb_build_object('code','CONFLICT');end if;
 if r.kind='RECURRING' and (exists(select 1 from public.customer_recurring_terms where user_id=i.user_id and state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=i.user_id and subscription_id<>i.subscription_id and state in ('ACTIVE','QUEUED','PAUSED') and ends_at>t)
 or (s.paid_through is not null and ps<>s.paid_through)
 or (select count(*) from cluera_billing_private.terms where subscription_id=i.subscription_id)>=r.total_count) then return jsonb_build_object('code','REVIEW');end if;
 if r.kind='RECURRING' then
 cutoff:=case when s.cancellation_at is null then cancel_at_value when cancel_at_value is null then s.cancellation_at else least(s.cancellation_at,cancel_at_value) end;
 -- Cancellation stops future billing, not time already funded before it.
 -- Unknown cutoff or a newly paid post-cancel invoice stays review-only.
 if (s.cancel_future and cutoff is null) or (cutoff is not null and paid_at_value>cutoff) then return jsonb_build_object('code','REVIEW');end if;
 end if;
 if not exists(select 1 from public.customer_accounts a join auth.users u on u.id=a.user_id where a.user_id=i.user_id and a.state='ACTIVE' and u.email_confirmed_at is not null)
 then return jsonb_build_object('code','PENDING');end if;
 end if;
 end if;
 before_value:=jsonb_build_object('intent',to_jsonb(i),
 'entitlements',(select coalesce(jsonb_agg(jsonb_build_object('term',to_jsonb(x),'grant',to_jsonb(g)) order by x.period_start),'[]') from cluera_billing_private.terms x left join public.customer_usage_grants g on g.id=x.grant_id where x.subscription_id=i.subscription_id),
 'subscription',(select to_jsonb(x) from cluera_billing_private.subscriptions x where x.subscription_id=i.subscription_id),
 'payment',(select to_jsonb(x) from cluera_billing_private.payments x where x.payment_id=p_evidence->>'paymentId'),
 'term',(select to_jsonb(x) from cluera_billing_private.terms x where x.invoice_id=p_evidence->>'invoiceId'),
 'grant',(select to_jsonb(g) from public.customer_usage_grants g join cluera_billing_private.payments x on x.grant_id=g.id where x.payment_id=p_evidence->>'paymentId'));
 state_value:=i.state;
 if action_value='STATUS' and e.event_type='subscription.authenticated' then
 -- Authentication/mandate is never paid state, including a late auth receipt
 -- received AFTER genuine invoice processing. Preserve current paid state.
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row)
 values(e.event_id,i.id,'STATUS',p_evidence,before_value,before_value);
 return jsonb_build_object('code','NO_GRANT');
 end if;
 if r.kind='RECURRING' then
 select * into s from cluera_billing_private.subscriptions where subscription_id=i.subscription_id for update;
 if not found then
 if action_value='STATUS' then
 -- Mandate/authentication/setup notifications never create subscriptions/grants.
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row) values(e.event_id,i.id,'STATUS',p_evidence,before_value,before_value);
 return jsonb_build_object('code','NO_GRANT');end if;
 insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at,cancel_future,cancellation_at)
 values(i.subscription_id,i.user_id,i.id,r.id,p_account_digest,p_evidence->>'subscriptionState',observed,p_evidence->>'subscriptionState'='CANCELED',cancel_at_value) returning * into s;
 elsif s.user_id<>i.user_id or s.revision_id<>r.id or s.account_digest<>p_account_digest then return jsonb_build_object('code','CONFLICT');end if;
 if observed>s.observed_at then
 update cluera_billing_private.subscriptions set state=p_evidence->>'subscriptionState',observed_at=observed,
 cancel_future=cancel_future or p_evidence->>'subscriptionState'='CANCELED',
 cancellation_at=case when cancellation_at is null then cancel_at_value when cancel_at_value is null then cancellation_at else least(cancellation_at,cancel_at_value) end,
 grace_until=case when p_evidence->>'subscriptionState'='PAST_DUE' and not cancel_future then coalesce(grace_until,paid_through+interval '1 day') else null end
 where subscription_id=s.subscription_id returning * into s;
 end if;
 if action_value='STATUS' and observed>=s.observed_at then
 if s.state='PAUSED' then
 perform public.customer_recurring_stop_grant(i.user_id,x.grant_id,t) from cluera_billing_private.terms x where x.subscription_id=s.subscription_id and x.state='ACTIVE';
 update public.customer_usage_grants g set state='PAUSED' from cluera_billing_private.terms x where x.subscription_id=s.subscription_id and x.state='ACTIVE' and g.id=x.grant_id;
 update cluera_billing_private.terms set state='PAUSED' where subscription_id=s.subscription_id and state='ACTIVE';
 elsif s.state='ACTIVE' then
 -- Resume comes only from verified provider state, never merchant mandate code.
 update public.customer_usage_grants g set state='ACTIVE' from cluera_billing_private.terms x where x.subscription_id=s.subscription_id and x.state='PAUSED' and x.ends_at>t and g.id=x.grant_id;
 update cluera_billing_private.terms set state='ACTIVE' where subscription_id=s.subscription_id and state='PAUSED' and ends_at>t;
 elsif s.state='PAST_DUE' and not s.cancel_future and s.grace_until>t then
 -- A delayed failure may reopen only this original paid cycle during its ONE
 -- fixed day, never a new grant/time or an already-refunded/competing cycle.
 if not exists(select 1 from public.customer_recurring_terms where user_id=i.user_id and state in ('ACTIVE','QUEUED','PAUSED'))
 and not exists(select 1 from cluera_billing_private.terms where user_id=i.user_id and subscription_id<>s.subscription_id and state in ('ACTIVE','PAUSED')) then
 update public.customer_usage_grants g set state='ACTIVE',expires_at=s.grace_until from cluera_billing_private.terms x
 where x.subscription_id=s.subscription_id and x.period_end=s.paid_through and x.state in ('ACTIVE','ENDED') and g.id=x.grant_id;
 update cluera_billing_private.terms set state='ACTIVE',ends_at=s.grace_until where subscription_id=s.subscription_id and period_end=s.paid_through and state in ('ACTIVE','ENDED');
 end if;
 end if;
 end if;
 end if;
 if action_value<>'STATUS' then
 if paid.payment_id is null then
 if action_value='GRANT' then
 if r.kind='RECURRING' then
 perform cluera_billing_private.refresh(i.user_id,t);
 if ps<=t then
 -- An accepted renewal replaces the old cycle: no rollover, no double-active.
 perform public.customer_recurring_stop_grant(i.user_id,x.grant_id,least(t,x.ends_at)) from cluera_billing_private.terms x where x.subscription_id=i.subscription_id and x.state in ('ACTIVE','PAUSED');
 update public.customer_usage_grants g set state='REVOKED' from cluera_billing_private.terms x where x.subscription_id=i.subscription_id and x.state in ('ACTIVE','PAUSED') and g.id=x.grant_id;
 update cluera_billing_private.terms set state='ENDED' where subscription_id=i.subscription_id and state in ('ACTIVE','PAUSED');
 end if;
 end if;
 insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at,state)
 values(i.user_id,case when r.kind='PACK' then 'razorpay-test:'||(p_evidence->>'orderId') else 'razorpay-test-invoice:'||(p_evidence->>'invoiceId') end,
 r.kind,r.allowance_seconds::bigint*1000,coalesce(ps,t),pe,case when pe is not null and pe<=t then 'REVOKED'
 when r.kind='RECURRING' and (ps>t or p_evidence->>'subscriptionState'='PAUSED') then 'PAUSED' else 'ACTIVE' end) returning id into grant_value;
 end if;
 insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,grant_id,state,period_start,period_end,paid_at)
 values(p_evidence->>'paymentId',p_evidence->>'orderId',i.id,i.user_id,p_evidence->>'invoiceId',i.subscription_id,r.amount_paise,r.id,grant_value,
 case when action_value='REFUND' then 'REFUNDED' else 'VERIFIED' end,ps,pe,paid_at_value) returning * into paid;
 if r.kind='RECURRING' then
 insert into cluera_billing_private.terms values(paid.invoice_id,i.user_id,i.subscription_id,grant_value,
 case when action_value='REFUND' then 'REFUNDED' when pe<=t then 'ENDED' when ps>t then 'QUEUED' when p_evidence->>'subscriptionState'='PAUSED' then 'PAUSED' else 'ACTIVE' end,ps,pe,pe);
 update cluera_billing_private.subscriptions set paid_through=greatest(coalesce(paid_through,pe),pe),grace_until=null where subscription_id=i.subscription_id;
 end if;
 elsif action_value='REFUND' and paid.state<>'REFUNDED' then
 if paid.grant_id is not null then
 perform public.customer_recurring_stop_grant(i.user_id,paid.grant_id,t);
 if exists(select 1 from public.customer_usage_grants where id=paid.grant_id and reserved_ms<>0) then raise exception 'Refund settlement incomplete';end if;
 select granted_ms-spent_ms into removed from public.customer_usage_grants where id=paid.grant_id;
 update public.customer_usage_grants set state='REVOKED' where id=paid.grant_id;
 end if;
 update cluera_billing_private.payments set state='REFUNDED' where payment_id=paid.payment_id;
 update cluera_billing_private.terms set state='REFUNDED' where invoice_id=paid.invoice_id;
 update cluera_billing_private.subscriptions set grace_until=null where subscription_id=i.subscription_id;
 end if;
 state_value:=case when r.kind='PACK' and (paid.state='REFUNDED' or action_value='REFUND') then 'REFUNDED' else 'VERIFIED' end;
 update cluera_billing_private.intents set state=state_value where id=i.id;
 end if;
 perform cluera_billing_private.refresh(i.user_id,t);
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row,removed_ms)
 select e.event_id,i.id,action_value,p_evidence,before_value,jsonb_build_object('intent',to_jsonb(x),
 'entitlements',(select coalesce(jsonb_agg(jsonb_build_object('term',to_jsonb(y),'grant',to_jsonb(g)) order by y.period_start),'[]') from cluera_billing_private.terms y left join public.customer_usage_grants g on g.id=y.grant_id where y.subscription_id=i.subscription_id),
 'subscription',(select to_jsonb(y) from cluera_billing_private.subscriptions y where y.subscription_id=i.subscription_id),
 'payment',(select to_jsonb(y) from cluera_billing_private.payments y where y.payment_id=p_evidence->>'paymentId'),
 'term',(select to_jsonb(y) from cluera_billing_private.terms y where y.invoice_id=p_evidence->>'invoiceId'),
 'grant',(select to_jsonb(g) from public.customer_usage_grants g join cluera_billing_private.payments y on y.grant_id=g.id where y.payment_id=p_evidence->>'paymentId')),removed
 from cluera_billing_private.intents x where x.id=i.id;
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 return jsonb_build_object('code',case when action_value='STATUS' then 'APPLIED' else state_value end);
end$$;

create function cluera_billing_private.owns(p_digest text,p_owner text,p_epoch bigint default null) returns boolean
language plpgsql security invoker set search_path='' as $$declare r cluera_billing_private.processing_owner;begin
 select * into strict r from cluera_billing_private.processing_owner where singleton for share;
 return p_digest is not null and p_digest ~ '^[a-f0-9]{64}$' and r.owner=p_owner
 and (r.account_digest is null or r.account_digest=p_digest) and (p_epoch is null or r.epoch=p_epoch);
end$$;
create function public.cluera_billing_owner(p_account_digest text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare r cluera_billing_private.processing_owner;begin
 select * into strict r from cluera_billing_private.processing_owner where singleton;
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or (r.account_digest is not null and r.account_digest<>p_account_digest) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','ACTIVE','owner',r.owner,'epoch',r.epoch);
end$$;
create function public.cluera_billing_cutover(p_operation uuid,p_expected_owner text,p_expected_epoch bigint,p_owner text,p_account_digest text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare r cluera_billing_private.processing_owner;prior cluera_billing_private.cutover_audit;before_value jsonb;begin
 if p_operation is null or p_owner is null or p_owner not in ('account','cluera') or p_expected_owner is null or p_expected_epoch is null
 or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or p_reason is null or length(trim(p_reason)) not between 10 and 500 then return jsonb_build_object('code','INVALID');end if;
 select * into strict r from cluera_billing_private.processing_owner where singleton for update;
 select * into prior from cluera_billing_private.cutover_audit where operation_id=p_operation;
 if found then
 if prior.before_row->>'owner' is distinct from p_expected_owner or (prior.before_row->>'epoch')::bigint is distinct from p_expected_epoch
 or prior.after_row->>'owner' is distinct from p_owner or prior.after_row->>'account_digest' is distinct from p_account_digest or prior.reason is distinct from trim(p_reason)
 then return jsonb_build_object('code','CONFLICT');end if;return jsonb_build_object('code','APPLIED','epoch',(prior.after_row->>'epoch')::bigint);end if;
 if r.owner<>p_expected_owner or r.epoch<>p_expected_epoch or r.owner=p_owner or (r.account_digest is not null and r.account_digest<>p_account_digest)
 then return jsonb_build_object('code','CONFLICT');end if;
 if exists(select 1 from billing_private.payment_events where state='PENDING' and lease_until>clock_timestamp())
 or exists(select 1 from cluera_billing_private.events where state='PENDING' and lease_until>clock_timestamp())
 then return jsonb_build_object('code','DRAIN_REQUIRED');end if;
 if p_owner='cluera' and (exists(select 1 from public.customer_billing_jobs where state in ('READY','RUNNING'))
 or exists(select 1 from public.customer_billing_outbox where state in ('READY','RUNNING'))
 or exists(select 1 from public.customer_recurring_terms where state in ('ACTIVE','QUEUED','PAUSED'))
 -- cancel_future is a local request, not independently confirmed provider
 -- termination; even a failed/REVIEW cancellation may still renew.
 or exists(select 1 from public.customer_recurring_subscriptions where state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from public.customer_checkout_intents i where i.state in ('CREATING','UNCERTAIN')
 or (i.state='BOUND'
 and not exists(select 1 from public.customer_pack_purchases p where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=i.user_id and p.state in ('ACTIVE','REFUNDED'))
 and not exists(select 1 from public.customer_recurring_terms t where t.transaction_id=i.transaction_id and t.user_id=i.user_id))))
 then return jsonb_build_object('code','PADDLE_DRAIN_REQUIRED');end if;
 -- Old Account bindings cannot resolve Cluera revisions or later refunds.
 -- Once any Cluera financial application exists, keep Cluera as owner and
 -- roll back only to another reviewed Cluera runtime, never to the old worker.
 if p_owner='account' and (exists(select 1 from cluera_billing_private.intents where state in ('CREATING','BOUND','UNCERTAIN'))
 or exists(select 1 from cluera_billing_private.events where state='PENDING')
 or exists(select 1 from cluera_billing_private.terms where state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.subscriptions where state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from cluera_billing_private.payments)
 or exists(select 1 from cluera_billing_private.applications))
 then return jsonb_build_object('code','CLUERA_DRAIN_REQUIRED');end if;
 if exists(select 1 from billing_private.payment_intents where account_digest<>p_account_digest)
 or exists(select 1 from cluera_billing_private.intents where account_digest<>p_account_digest) then return jsonb_build_object('code','CONFLICT');end if;
 before_value:=to_jsonb(r);
 update cluera_billing_private.processing_owner set owner=p_owner,epoch=epoch+1,account_digest=p_account_digest,changed_at=clock_timestamp() where singleton returning * into r;
 insert into cluera_billing_private.cutover_audit values(p_operation,trim(p_reason),before_value,to_jsonb(r),clock_timestamp());
 return jsonb_build_object('code','APPLIED','epoch',r.epoch);
end$$;

create function public.cluera_billing_catalog() returns jsonb language sql security definer set search_path='' set statement_timeout='5s' as $$
 select coalesce(jsonb_agg(jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,'currency',r.currency,
 'allowanceSeconds',r.allowance_seconds,'kind',r.kind,'interval',r.interval_name,'razorpayPlanId',r.razorpay_plan_id,'totalCount',r.total_count,
 'testPlanValidated',(r.kind='PACK' or exists(select 1 from cluera_billing_private.plan_verifications v join cluera_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id)),'enabled',h.enabled,'version',r.version)
 order by r.amount_paise),'[]') from cluera_billing_private.catalog_heads h join cluera_billing_private.catalog_revisions r on r.id=h.revision_id
$$;
create function public.cluera_billing_admin_read(p_actor uuid,p_session uuid,p_operation uuid default null) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$declare a cluera_billing_private.admin_audit;begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null then return jsonb_build_object('code','ACTIVE','catalog',public.cluera_billing_catalog());end if;
 select * into a from cluera_billing_private.admin_audit where operation_id=p_operation and actor_id=p_actor;
 return case when found then jsonb_build_object('code','APPLIED','revision',a.after_row) else jsonb_build_object('code','NOT_FOUND') end;
end$$;
create function public.cluera_billing_admin_mutate(p_actor uuid,p_session uuid,p_operation uuid,p_action text,p_offer text,p_expected_revision uuid,p_reauthenticated_at timestamptz,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare r cluera_billing_private.catalog_revisions;h cluera_billing_private.catalog_heads;a cluera_billing_private.admin_audit;before_value jsonb;after_value jsonb;begin
 if public.account_admin_check(p_actor,p_session,true) is not true or p_reauthenticated_at is null or not isfinite(p_reauthenticated_at)
 or p_reauthenticated_at<clock_timestamp()-interval '2 minutes' or p_reauthenticated_at>clock_timestamp()+interval '5 seconds' then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null or p_action is null or p_action not in ('CREATE_REVISION','SET_ENABLED') or p_expected_revision is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 or jsonb_typeof(p_input) is distinct from 'object' then return jsonb_build_object('code','INVALID');end if;
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation::text,862117));
 select * into a from cluera_billing_private.admin_audit where operation_id=p_operation;
 if found then
 if a.actor_id<>p_actor or a.session_id<>p_session or a.action<>p_action or a.reason is distinct from trim(p_reason) or a.input is distinct from jsonb_build_object('offer',p_offer,'expectedRevision',p_expected_revision,'input',p_input)
 then return jsonb_build_object('code','CONFLICT');end if;return jsonb_build_object('code','APPLIED','revision',a.after_row);end if;
 select * into h from cluera_billing_private.catalog_heads where offer_code=p_offer for update;
 if not found or h.revision_id<>p_expected_revision then return jsonb_build_object('code','CONFLICT');end if;
 select * into strict r from cluera_billing_private.catalog_revisions where id=h.revision_id;
 before_value:=to_jsonb(r)||jsonb_build_object('enabled',h.enabled);
 if p_action='CREATE_REVISION' then
 if (p_input-array['name','amountPaise','allowanceSeconds','razorpayPlanId','totalCount'])<>'{}'::jsonb
 or jsonb_typeof(p_input->'name') is distinct from 'string' or length(trim(p_input->>'name')) not between 2 and 80
 or coalesce(p_input->>'amountPaise','') !~ '^[0-9]{3,8}$' or coalesce(p_input->>'allowanceSeconds','') !~ '^[0-9]{2,7}$'
 or (p_input->>'amountPaise')::integer not between 100 and 10000000 or (p_input->>'allowanceSeconds')::integer not between 60 and 3600000
 or (r.kind='PACK' and p_input->>'razorpayPlanId' is not null)
 or (r.kind='PACK' and p_input->>'totalCount' is not null)
 or (r.kind='RECURRING' and (coalesce(p_input->>'totalCount','') !~ '^[0-9]{1,3}$' or (p_input->>'totalCount')::integer not between 1 and 120))
 or (r.kind='RECURRING' and p_input->>'razorpayPlanId' is not null and p_input->>'razorpayPlanId' !~ '^plan_[A-Za-z0-9]{8,64}$') then return jsonb_build_object('code','INVALID');end if;
 insert into cluera_billing_private.catalog_revisions(offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,razorpay_plan_id,total_count)
 values(r.offer_code,r.version+1,trim(p_input->>'name'),(p_input->>'amountPaise')::integer,(p_input->>'allowanceSeconds')::integer,r.kind,r.interval_name,p_input->>'razorpayPlanId',(p_input->>'totalCount')::integer) returning * into r;
 update cluera_billing_private.catalog_heads set revision_id=r.id,enabled=false where offer_code=p_offer;
 else
 if (p_input-array['enabled'])<>'{}'::jsonb or jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then return jsonb_build_object('code','INVALID');end if;
 if (p_input->>'enabled')::boolean and r.kind='RECURRING' and not exists(select 1 from cluera_billing_private.plan_verifications v
 join cluera_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id and r.razorpay_plan_id is not null)
 then return jsonb_build_object('code','PLAN_UNVERIFIED');end if;
 update cluera_billing_private.catalog_heads set enabled=(p_input->>'enabled')::boolean where offer_code=p_offer;
 end if;
 if public.account_admin_check(p_actor,p_session,true) is not true then raise exception 'Admin session changed';end if;
 select value into after_value from jsonb_array_elements(public.cluera_billing_catalog()) where value->>'revisionId'=r.id::text;
 insert into cluera_billing_private.admin_audit(operation_id,actor_id,session_id,action,reason,input,before_row,after_row)
 values(p_operation,p_actor,p_session,p_action,trim(p_reason),jsonb_build_object('offer',p_offer,'expectedRevision',p_expected_revision,'input',p_input),before_value,after_value);
 return jsonb_build_object('code','APPLIED','revision',after_value);
end$$;
create function public.cluera_billing_plan_verify(p_revision uuid,p_account_digest text,p_evidence jsonb) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare r cluera_billing_private.catalog_revisions;observed timestamptz;begin
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_evidence) is distinct from 'object'
 or (p_evidence-array['planId','period','interval','amountPaise','currency','observedAt'])<>'{}'::jsonb then return 'INVALID';end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;exception when others then return 'INVALID';end;
 if observed is null or not isfinite(observed) or observed<clock_timestamp()-interval '2 minutes' or observed>clock_timestamp()+interval '5 seconds' then return 'INVALID';end if;
 select * into r from cluera_billing_private.catalog_revisions where id=p_revision;
 if not found or r.kind<>'RECURRING' or r.razorpay_plan_id is null or p_evidence->>'planId' is distinct from r.razorpay_plan_id
 or p_evidence->>'period' is distinct from 'monthly' or p_evidence->>'interval' is distinct from '1'
 or p_evidence->>'amountPaise' is distinct from r.amount_paise::text or p_evidence->>'currency' is distinct from 'INR' then return 'INVALID';end if;
 insert into cluera_billing_private.plan_verifications values(r.id,p_account_digest,p_evidence,observed) on conflict do nothing;
 return 'VERIFIED';
end$$;

create function public.cluera_billing_status(p_user uuid,p_session uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare a jsonb;pending jsonb;resolved jsonb;subscriptions jsonb;begin
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select jsonb_build_object('intentId',i.id,'state',i.state,'kind',r.kind,'revisionId',r.id,'offerCode',r.offer_code,'orderId',i.order_id,'subscriptionId',i.subscription_id,'legacy',false) into pending
 from cluera_billing_private.intents i join cluera_billing_private.catalog_revisions r on r.id=i.revision_id where i.user_id=p_user and i.state in ('CREATING','BOUND','UNCERTAIN') limit 1;
 if pending is null then select jsonb_build_object('intentId',id,'state',state,'kind','PACK','revisionId',null,'offerCode',offer_code,'orderId',order_id,'subscriptionId',null,'legacy',true) into pending
 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN') limit 1;end if;
 select coalesce(jsonb_agg(resource order by created desc),'[]') into resolved from(select resource,max(created_at) created from(
 select order_id resource,created_at from cluera_billing_private.intents where user_id=p_user and state in ('VERIFIED','REFUNDED') and order_id is not null
 union all select order_id,created_at from billing_private.payment_intents where user_id=p_user and state in ('VERIFIED','REFUNDED') and order_id is not null) x
 group by resource order by created desc limit 50) q;
 select coalesce(jsonb_agg(subscription_id order by created_at desc),'[]') into subscriptions from(
 select subscription_id,created_at from cluera_billing_private.intents where user_id=p_user and state in ('VERIFIED','REFUNDED') and subscription_id is not null order by created_at desc limit 50) q;
 return jsonb_build_object('code',case when pending is null then 'AVAILABLE' else 'PENDING' end,'userId',p_user,'pending',pending,'resolvedOrderIds',resolved,'resolvedSubscriptionIds',subscriptions);
end$$;
create function public.cluera_billing_prepare(p_user uuid,p_session uuid,p_request uuid,p_revision uuid,p_account_digest text,p_epoch bigint) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;rev jsonb;begin
 if p_epoch is null or p_request is null or p_revision is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select * into i from cluera_billing_private.intents where user_id=p_user and request_id=p_request;
 if found then
 if i.revision_id<>p_revision or i.account_digest<>p_account_digest then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code',i.state,'intentId',i.id,'orderId',i.order_id,'subscriptionId',i.subscription_id);end if;
 -- Fence concurrent Admin revision/disable while taking the immutable checkout
 -- snapshot; no network request occurs under this short shared-head lock.
 perform 1 from cluera_billing_private.catalog_heads where revision_id=p_revision and enabled for share;
 if not found then return jsonb_build_object('code','DISABLED');end if;
 select * into strict r from cluera_billing_private.catalog_revisions where id=p_revision;
 if exists(select 1 from cluera_billing_private.intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN'))
 or exists(select 1 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN')) then return jsonb_build_object('code','PENDING');end if;
 if r.kind='RECURRING' and (exists(select 1 from public.customer_recurring_terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.subscriptions where user_id=p_user and not cancel_future and state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED') and ends_at>clock_timestamp())) then return jsonb_build_object('code','COMPETING_SUBSCRIPTION');end if;
 if r.kind='RECURRING' and not exists(select 1 from cluera_billing_private.plan_verifications where revision_id=r.id and account_digest=p_account_digest) then return jsonb_build_object('code','PLAN_UNVERIFIED');end if;
 if (select count(*) from cluera_billing_private.intents where user_id=p_user and created_at>clock_timestamp()-interval '1 hour')>=5 then return jsonb_build_object('code','RATE_LIMITED');end if;
 insert into cluera_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state) values(p_user,p_request,r.id,p_account_digest,p_epoch,'CREATING') returning * into i;
 select value into rev from jsonb_array_elements(public.cluera_billing_catalog()) where value->>'revisionId'=r.id::text;
 return jsonb_build_object('code','CLAIMED','intentId',i.id,'attemptId',i.attempt_id,'revision',rev);
end$$;
create function public.cluera_billing_bind(p_intent uuid,p_attempt uuid,p_account_digest text,p_epoch bigint,p_resource jsonb) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return 'UNAVAILABLE';end if;
 select * into i from cluera_billing_private.intents where id=p_intent;if not found then return 'UNBOUND';end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into strict i from cluera_billing_private.intents where id=i.id for update;
 if i.attempt_id is distinct from p_attempt or i.account_digest is distinct from p_account_digest or i.epoch<>p_epoch then return 'CONFLICT';end if;
 if i.state<>'CREATING' then return i.state;end if;
 if p_resource is null then update cluera_billing_private.intents set state='UNCERTAIN' where id=i.id;return 'UNCERTAIN';end if;
 select * into strict r from cluera_billing_private.catalog_revisions where id=i.revision_id;
 if jsonb_typeof(p_resource) is distinct from 'object' or (p_resource-array['orderId','subscriptionId'])<>'{}'::jsonb
 or (r.kind='PACK' and (p_resource->>'orderId' is null or p_resource->>'orderId' !~ '^order_[A-Za-z0-9]{8,64}$' or p_resource->>'subscriptionId' is not null))
 or (r.kind='RECURRING' and (p_resource->>'subscriptionId' is null or p_resource->>'subscriptionId' !~ '^sub_[A-Za-z0-9]{8,64}$' or p_resource->>'orderId' is not null))
 or exists(select 1 from billing_private.payment_intents where order_id=p_resource->>'orderId') then return 'INVALID';end if;
 update cluera_billing_private.intents set state='BOUND',order_id=p_resource->>'orderId',subscription_id=p_resource->>'subscriptionId' where id=i.id;return 'BOUND';
end$$;
create function public.cluera_billing_binding(p_resource text,p_account_digest text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$declare i cluera_billing_private.intents;rev jsonb;begin
 select * into i from cluera_billing_private.intents where account_digest=p_account_digest and (order_id=p_resource or subscription_id=p_resource);
 if not found then return public.account_payment_binding(p_resource,p_account_digest)||jsonb_build_object('legacy',true);end if;
 select jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,'currency',r.currency,'allowanceSeconds',r.allowance_seconds,
 'kind',r.kind,'interval',r.interval_name,'razorpayPlanId',r.razorpay_plan_id,'totalCount',r.total_count,'version',r.version,
 'enabled',exists(select 1 from cluera_billing_private.catalog_heads h where h.revision_id=r.id and h.enabled),
 'testPlanValidated',exists(select 1 from cluera_billing_private.plan_verifications v where v.revision_id=r.id and v.account_digest=p_account_digest))
 into rev from cluera_billing_private.catalog_revisions r where id=i.revision_id;
 return jsonb_build_object('code',i.state,'legacy',false,'intentId',i.id,'userId',i.user_id,'orderId',i.order_id,'subscriptionId',i.subscription_id,'revision',rev);
end$$;

-- Legacy compatibility stays durable. These wrappers change authority only
-- after the approved owner CAS; original audited code and data stay in place.
alter function public.account_payment_claim(text) rename to account_payment_claim_account_base;
alter function public.account_payment_apply(text,uuid,text,text,jsonb) rename to account_payment_apply_account_base;
alter function public.account_payment_prepare(uuid,uuid,uuid,text) rename to account_payment_prepare_account_base;
revoke all on function public.account_payment_claim_account_base(text),public.account_payment_apply_account_base(text,uuid,text,text,jsonb),
 public.account_payment_prepare_account_base(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.account_payment_claim(p_account_digest text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if cluera_billing_private.owns(p_account_digest,'account') is not true then return jsonb_build_object('code','EMPTY');end if;
 return public.account_payment_claim_account_base(p_account_digest);
end$$;
create function public.account_payment_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if cluera_billing_private.owns(p_account_digest,'account') is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 return public.account_payment_apply_account_base(p_event,p_claim,p_digest,p_account_digest,p_evidence);
end$$;
create function public.account_payment_prepare(p_user uuid,p_session uuid,p_request uuid,p_account_digest text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if cluera_billing_private.owns(p_account_digest,'account') is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 return public.account_payment_prepare_account_base(p_user,p_session,p_request,p_account_digest);
end$$;
create function public.cluera_billing_legacy_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e cluera_billing_private.events;o billing_private.payment_events;i billing_private.payment_intents;result jsonb;received text;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 begin select * into i from billing_private.payment_intents where id=(p_evidence->>'intentId')::uuid and provider='razorpay' and environment='test';
 exception when others then return jsonb_build_object('code','INVALID');end;
 if i.id is null or i.order_id is distinct from p_evidence->>'orderId' or i.account_digest is distinct from p_account_digest then return jsonb_build_object('code','UNBOUND');end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into e from cluera_billing_private.events where event_id=p_event for update;
 if found then
 if e.account_digest<>p_account_digest or e.digest is distinct from p_digest or e.event_type not in ('payment.captured','order.paid','refund.processed')
 or e.payment_id is distinct from p_evidence->>'paymentId' or (e.order_id is not null and e.order_id is distinct from i.order_id)
 or e.subscription_id is not null or e.invoice_id is not null or e.state='QUARANTINED' then return jsonb_build_object('code','CONFLICT');end if;
 select * into o from billing_private.payment_events where event_id=p_event and provider='razorpay' and environment='test' for update;
 if not found then
 if e.state<>'PENDING' or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=clock_timestamp() then return jsonb_build_object('code','CONFLICT');end if;
 -- A raw refund has no order ID. Only fresh independent provider evidence may
 -- discover its OLD immutable binding. Transfer its already signed safe receipt
 -- into that same original inbox; do not synthesize or replay a provider event.
 received:=public.account_payment_receive(jsonb_build_object('eventId',e.event_id,'eventType',e.event_type,'resourceId',e.resource_id,
 'paymentId',e.payment_id,'orderId',e.order_id,'digest',e.digest,'occurredAt',e.occurred_at),p_account_digest);
 if received not in ('STORED','DUPLICATE') then return jsonb_build_object('code','CONFLICT');end if;
 update billing_private.payment_events set claim_id=p_claim,lease_until=e.lease_until,attempts=greatest(attempts,e.attempts)
 where provider='razorpay' and environment='test' and event_id=e.event_id and state='PENDING';
 elsif o.digest<>e.digest or o.account_digest<>e.account_digest or o.event_type<>e.event_type or o.resource_id<>e.resource_id
 or o.payment_id<>e.payment_id or o.order_id is distinct from e.order_id or o.occurred_at<>e.occurred_at then return jsonb_build_object('code','CONFLICT');
 elsif o.state='PROCESSED' and exists(select 1 from billing_private.payment_applications where event_id=p_event and intent_id=i.id) then
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 return jsonb_build_object('code',i.state);
 end if;
 end if;
 result:=public.account_payment_apply_account_base(p_event,p_claim,p_digest,p_account_digest,p_evidence);
 if result->>'code' in ('VERIFIED','REFUNDED') then update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=p_event;end if;
 return result;
end$$;

-- Old Paddle history/REVIEW jobs are untouched. No ready/running work or paid
-- term is permitted at the CAS boundary, and no new claim can race after it.
alter function public.customer_billing_claim(text) rename to customer_billing_claim_pre_cluera;
alter function public.customer_billing_action_claim() rename to customer_billing_action_claim_pre_cluera;
revoke all on function public.customer_billing_claim_pre_cluera(text),public.customer_billing_action_claim_pre_cluera() from public,anon,authenticated,service_role;
create function public.customer_billing_claim(p_event_id text default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare o text;begin
 select owner into strict o from cluera_billing_private.processing_owner where singleton for share;
 if o<>'account' then return jsonb_build_object('code','EMPTY');end if;
 return public.customer_billing_claim_pre_cluera(p_event_id);
end$$;
create function public.customer_billing_action_claim() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare o text;begin
 select owner into strict o from cluera_billing_private.processing_owner where singleton for share;
 if o<>'account' then return jsonb_build_object('code','EMPTY');end if;
 return public.customer_billing_action_claim_pre_cluera();
end$$;

-- Account-before-grant lock ordering and the shipped usage DTO remain intact.
alter function public.customer_usage_command(uuid,uuid,uuid,integer,text) rename to customer_usage_command_pre_cluera;
alter function public.customer_usage_balance(uuid,uuid) rename to customer_usage_balance_pre_cluera;
revoke all on function public.customer_usage_command_pre_cluera(uuid,uuid,uuid,integer,text),public.customer_usage_balance_pre_cluera(uuid,uuid) from public,anon,authenticated,service_role;
create function public.customer_usage_command(p_user_id uuid,p_session_id uuid,p_run_id uuid,p_sequence integer,p_action text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare a jsonb;begin
 a:=public.customer_authorize(p_user_id,p_session_id);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user_id for update;
 perform cluera_billing_private.refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
 return public.customer_usage_command_pre_cluera(p_user_id,p_session_id,p_run_id,p_sequence,p_action);
end$$;
create function public.customer_usage_balance(p_user_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare a jsonb;begin
 a:=public.customer_authorize(p_user_id,p_session_id);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user_id for update;
 perform cluera_billing_private.refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
 return public.customer_usage_balance_pre_cluera(p_user_id,p_session_id);
end$$;
-- Do not append new offer enums to old Account customers' strict report. Cluera
-- has a separate reader with identical field names and additive allowed enums.
create function public.cluera_credits_read(p_user uuid,p_session uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare base jsonb;history jsonb;plans jsonb;a jsonb;begin
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 perform cluera_billing_private.refresh(p_user,date_trunc('milliseconds',clock_timestamp()));
 base:=public.customer_credits_read(p_user,p_session);if base->>'userId' is distinct from p_user::text then return base;end if;
 select coalesce(jsonb_agg(value order by created desc),'[]') into history from(
 select value,(value->>'createdAt')::timestamptz created from jsonb_array_elements(base->'payments')
 union all select jsonb_build_object('offerCode',r.offer_code,'state',i.state,'createdAt',i.created_at),i.created_at
 from cluera_billing_private.intents i join cluera_billing_private.catalog_revisions r on r.id=i.revision_id where i.user_id=p_user
 order by created desc limit 10) q;
 select coalesce(jsonb_agg(value order by sort_at desc),'[]') into plans from(
 select value,coalesce((value->>'endsAt')::timestamptz,'-infinity'::timestamptz) sort_at from jsonb_array_elements(base->'plans')
 union all select jsonb_build_object('tier',case when r.offer_code in ('cluera_monthly_40h_v2','cluera_monthly_100h_v2') then 'PRO' else 'ENTERPRISE' end,'state',t.state,'paymentState',s.state,
 'endsAt',t.ends_at,'cancelFuture',s.cancel_future),t.period_start from cluera_billing_private.terms t join cluera_billing_private.subscriptions s using(subscription_id)
 join cluera_billing_private.catalog_revisions r on r.id=s.revision_id where t.user_id=p_user order by sort_at desc limit 30) q;
 return jsonb_set(jsonb_set(base,'{payments}',history),'{plans}',plans);
end$$;

-- Explicit only-this-proposal privilege boundary; never blanket-revoke old APIs.
revoke all on all functions in schema cluera_billing_private from public,anon,authenticated,service_role;
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like 'cluera_billing_%' or p.proname='cluera_credits_read'
 or p.proname in ('account_payment_claim','account_payment_apply','account_payment_prepare','customer_usage_command','customer_usage_balance','customer_billing_claim','customer_billing_action_claim')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;

-- Clean compatibility structures are EMPTY; legacy financial paths are not exposed.
revoke all on function public.paddle_sandbox_receive(text,text,timestamptz,text,text),
 public.paddle_sandbox_receive_simulation(text,text,timestamptz,text,text),
 public.customer_checkout_prepare(uuid,uuid,uuid,text),
 public.customer_checkout_complete(uuid,uuid,text,text),
 public.customer_checkout_resume_read(uuid,uuid),
 public.customer_pack_reconcile(text,uuid,text,text,text,text),
 public.customer_billing_claim(text),
 public.customer_billing_finish(text,uuid,text),
 public.customer_billing_bound_intent(text),
 public.customer_billing_apply_pack(text,uuid,text,uuid,text,text,text,text),
 public.customer_billing_apply_recurring(text,uuid,text,jsonb),
 public.customer_billing_subscription(text),
 public.customer_billing_action_claim(),
 public.customer_billing_action_finish(uuid,uuid,text),
 public.customer_billing_action_authorize(uuid,uuid),
 public.account_payment_status(uuid,uuid),
 public.account_payment_prepare(uuid,uuid,uuid,text),
 public.account_payment_bind(uuid,uuid,text,text,jsonb),
 public.account_payment_binding(text,text),
 public.account_payment_receive(jsonb,text),
 public.account_payment_claim(text),
 public.account_payment_retry(text,uuid),
 public.account_payment_apply(text,uuid,text,text,jsonb),
 public.cluera_billing_legacy_apply(text,uuid,text,text,bigint,jsonb) from public,anon,authenticated,service_role;

-- Passive preparation only. No cron extension/job, Vault credential, network
-- queue or outbound dispatch is installed. Later activation needs reviewed DDL.
create table billing_private.worker_config (
 singleton boolean primary key default true check(singleton),secret_id uuid,
 enabled boolean not null default false,last_sent_at timestamptz,last_request_id bigint,
 constraint clean_worker_stays_passive check(not enabled and secret_id is null)
);
alter table billing_private.worker_config enable row level security;
revoke all on billing_private.worker_config from public,anon,authenticated,service_role;
insert into billing_private.worker_config(singleton) values(true);
create function billing_private.wake_worker() returns void language plpgsql security invoker set search_path=''
 set lock_timeout='2s' set statement_timeout='5s' as $$begin return;end$$;
revoke all on function billing_private.wake_worker() from public,anon,authenticated,service_role;

-- The platform's existing event-trigger helper is not a browser API.
-- Retain the owner/event trigger; remove only browser/public EXECUTE grants.
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='rls_auto_enable' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
end$$;
