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
