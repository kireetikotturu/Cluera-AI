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
