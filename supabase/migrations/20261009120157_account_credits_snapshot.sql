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
