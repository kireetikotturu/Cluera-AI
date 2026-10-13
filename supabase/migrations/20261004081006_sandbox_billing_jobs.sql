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
