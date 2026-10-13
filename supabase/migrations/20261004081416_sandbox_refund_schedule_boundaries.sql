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
