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
