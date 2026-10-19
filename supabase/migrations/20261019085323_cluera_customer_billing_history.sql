-- Tracked Cluera-only SELECT capability; source proposal retained below.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
-- Original reviewed additive Cluera customer-history proposal, clean project
-- yhnqlfcgrmckhyjdxegg ONLY. Not migration execution or payment activation.
-- SELECT-only: no trial/account bootstrap, provider read/write, event acceptance,
-- reconciliation, entitlement refresh, scheduler wake or financial mutation.
-- At most the newest50 payments and50 subscriptions; hasMore is NOT a total.
create index cluera_payments_history_owner on cluera_billing_private.payments(user_id,paid_at desc,payment_id desc);
create index cluera_subscriptions_history_owner on cluera_billing_private.subscriptions(user_id,observed_at desc,subscription_id desc);
create function public.cluera_billing_history(p_user uuid,p_session uuid) returns jsonb
language plpgsql stable security definer set search_path='' set timezone='UTC'
set lock_timeout='2s' set statement_timeout='5s' as $$
declare payments_value jsonb;subscriptions_value jsonb;payments_more boolean;subscriptions_more boolean;
begin
 if p_user is null or p_session is null or not exists(
   select 1 from auth.users u join auth.sessions s on s.user_id=u.id
   where u.id=p_user and u.email_confirmed_at is not null and u.email is not null
   and u.deleted_at is null and u.is_anonymous is false
   and (u.banned_until is null or u.banned_until<=now())
   and s.id=p_session and (s.not_after is null or s.not_after>now()))
 then return jsonb_build_object('code','UNAUTHENTICATED');end if;
 if not exists(select 1 from public.customer_accounts where user_id=p_user and state='ACTIVE')
 then return jsonb_build_object('code','FORBIDDEN');end if;

 with bounded as materialized(
   select p.payment_id,p.invoice_id,p.subscription_id,p.state,p.paid_at,p.period_start,p.period_end,
     i.created_at as intent_created_at,r.id as revision_id,r.offer_code,r.version,r.name,r.kind,
     r.amount_paise,r.currency,r.allowance_seconds,
     row_number() over(order by coalesce(p.paid_at,i.created_at) desc,p.payment_id desc) as ordinal
   from cluera_billing_private.payments p
   join cluera_billing_private.intents i on i.id=p.intent_id and i.user_id=p.user_id and i.revision_id=p.revision_id
   join cluera_billing_private.catalog_revisions r on r.id=p.revision_id
   where p.user_id=p_user
   order by coalesce(p.paid_at,i.created_at) desc,p.payment_id desc limit 51
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   'paymentId',payment_id,'invoiceId',invoice_id,'subscriptionId',subscription_id,'state',state,
   'intentCreatedAt',intent_created_at,'paidAt',paid_at,'periodStart',period_start,'periodEnd',period_end,
   'revision',jsonb_build_object('revisionId',revision_id,'offerCode',offer_code,'version',version,'name',name,
     'kind',kind,'amountPaise',amount_paise,'currency',currency,'allowanceSeconds',allowance_seconds)
   ) order by ordinal) filter(where ordinal<=50),'[]'),coalesce(max(ordinal)>50,false)
 into payments_value,payments_more from bounded;

 with bounded as materialized(
   select s.subscription_id,s.state,s.observed_at,s.paid_through,s.grace_until,s.cancel_future,s.cancellation_at,
     r.id as revision_id,r.offer_code,r.version,r.name,r.kind,r.amount_paise,r.currency,r.allowance_seconds,
     row_number() over(order by s.observed_at desc,s.subscription_id desc) as ordinal
   from cluera_billing_private.subscriptions s
   join cluera_billing_private.intents i on i.id=s.intent_id and i.user_id=s.user_id
     and i.revision_id=s.revision_id and i.subscription_id=s.subscription_id
   join cluera_billing_private.catalog_revisions r on r.id=s.revision_id
   where s.user_id=p_user and r.kind='RECURRING'
   order by s.observed_at desc,s.subscription_id desc limit 51
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   'subscriptionId',subscription_id,'state',state,'observedAt',observed_at,'paidThrough',paid_through,
   'graceUntil',grace_until,'cancelFuture',cancel_future,'cancellationAt',cancellation_at,
   'revision',jsonb_build_object('revisionId',revision_id,'offerCode',offer_code,'version',version,'name',name,
     'kind',kind,'amountPaise',amount_paise,'currency',currency,'allowanceSeconds',allowance_seconds)
   ) order by ordinal) filter(where ordinal<=50),'[]'),coalesce(max(ordinal)>50,false)
 into subscriptions_value,subscriptions_more from bounded;

 return jsonb_build_object('code','ACTIVE','userId',p_user,'payments',payments_value,
   'subscriptions',subscriptions_value,'hasMorePayments',payments_more,'hasMoreSubscriptions',subscriptions_more);
end$$;
revoke all on function public.cluera_billing_history(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.cluera_billing_history(uuid,uuid) to service_role;
commit;
