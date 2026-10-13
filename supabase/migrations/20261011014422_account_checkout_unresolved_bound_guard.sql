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
