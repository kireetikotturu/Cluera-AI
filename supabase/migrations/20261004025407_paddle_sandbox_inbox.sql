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
