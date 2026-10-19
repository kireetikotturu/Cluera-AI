-- UNAPPLIED preparation for the Cluera-native monthly schedule integration.
-- One service-only stable SELECT RPC; no entitlement refresh, writer, provider
-- command, queue relaxation, table/column change or activation is performed.
create function public.cluera_billing_recurring_snapshot(p_user uuid,p_session uuid,p_account_digest text,p_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set statement_timeout='5s' as $$
declare terms_value jsonb;subscriptions_value jsonb;schedule_value jsonb;term_count integer;subscription_count integer;
begin
 if p_user is null or p_session is null or not exists(
 select 1 from auth.users u join auth.sessions s on s.user_id=u.id
 where u.id=p_user and u.email_confirmed_at is not null and u.email is not null and u.deleted_at is null and u.is_anonymous is false
 and (u.banned_until is null or u.banned_until<=now()) and s.id=p_session and (s.not_after is null or s.not_after>now()))
 then return jsonb_build_object('code','UNAUTHENTICATED');end if;
 if not exists(select 1 from public.customer_accounts where user_id=p_user and state='ACTIVE') then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_epoch is null or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or not exists(
 select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera' and epoch=p_epoch and account_digest=p_account_digest)
 then return jsonb_build_object('code','UNAVAILABLE');end if;
 select count(*) into term_count from cluera_billing_private.terms where user_id=p_user;
 select count(*) into subscription_count from cluera_billing_private.subscriptions where user_id=p_user;
 if term_count>10000 or subscription_count>10000 then return jsonb_build_object('code','REVIEW');end if;

 with source as materialized(
 select t.*,p.payment_id,p.order_id,p.paid_at,r.id as revision_id,r.offer_code,r.amount_paise,r.allowance_seconds,
 g.starts_at as grant_starts_at,g.granted_ms,g.spent_ms,g.reserved_ms,
 (select max(a.created_at) from cluera_billing_private.applications a where a.intent_id=p.intent_id and a.action='REFUND'
 and a.evidence->>'invoiceId'=t.invoice_id) as refunded_at,
 row_number() over(order by t.period_start,t.invoice_id) as ordinal
 from cluera_billing_private.terms t join cluera_billing_private.payments p on p.invoice_id=t.invoice_id and p.user_id=t.user_id
 join cluera_billing_private.subscriptions s on s.subscription_id=t.subscription_id and s.user_id=t.user_id and s.account_digest=p_account_digest
 join cluera_billing_private.catalog_revisions r on r.id=p.revision_id and r.id=s.revision_id and r.kind='RECURRING'
 left join public.customer_usage_grants g on g.id=t.grant_id and g.user_id=t.user_id
 where t.user_id=p_user order by t.period_start,t.invoice_id limit 10001
 )
 select coalesce(jsonb_agg(jsonb_build_object('invoiceId',invoice_id,'paymentId',payment_id,'orderId',order_id,
 'subscriptionId',subscription_id,'revisionId',revision_id,'offerCode',offer_code,'amountPaise',amount_paise,
 'grantedMs',coalesce(granted_ms,allowance_seconds::bigint*1000),'spentMs',coalesce(spent_ms,0),'reservedMs',coalesce(reserved_ms,0),
 'periodStart',floor(extract(epoch from period_start)*1000)::bigint,'periodEnd',floor(extract(epoch from period_end)*1000)::bigint,
 'paidAt',floor(extract(epoch from paid_at)*1000)::bigint,
 'state',case when state='PAUSED' then 'SUSPENDED' else state end,
 'startsAt',case when state='QUEUED' then null else floor(extract(epoch from grant_starts_at)*1000)::bigint end,
 'endsAt',case when state='QUEUED' then null else floor(extract(epoch from ends_at)*1000)::bigint end,
 'remainingWallMs',case when state='QUEUED' then floor(extract(epoch from period_end-period_start)*1000)::bigint else null end,
 'closedAt',case when state='ENDED' then floor(extract(epoch from ends_at)*1000)::bigint when state='REFUNDED' then floor(extract(epoch from refunded_at)*1000)::bigint else null end,
 'sequence',ordinal) order by ordinal),'[]') into terms_value from source;

 select coalesce(jsonb_agg(jsonb_build_object('subscriptionId',s.subscription_id,'revisionId',s.revision_id,'offerCode',r.offer_code,
 'state',s.state,'observedAt',floor(extract(epoch from s.observed_at)*1000)::bigint,'paidThrough',floor(extract(epoch from s.paid_through)*1000)::bigint,
 'graceUntil',floor(extract(epoch from s.grace_until)*1000)::bigint,'cancellationAt',floor(extract(epoch from s.cancellation_at)*1000)::bigint,
 'stopRequestedAt',case when s.cancel_future then floor(extract(epoch from s.cancellation_at)*1000)::bigint else null end)
 order by s.subscription_id),'[]') into subscriptions_value
 from cluera_billing_private.subscriptions s join cluera_billing_private.catalog_revisions r on r.id=s.revision_id and r.kind='RECURRING'
 where s.user_id=p_user and s.account_digest=p_account_digest;
 -- Never make an incomplete/mismatched projection look like an empty schedule.
 if jsonb_array_length(terms_value)<>term_count or jsonb_array_length(subscriptions_value)<>subscription_count
 then return jsonb_build_object('code','REVIEW');end if;
 schedule_value:=jsonb_build_object('at',floor(extract(epoch from now())*1000)::bigint,'terms',terms_value,'subscriptions',subscriptions_value,'actions','[]'::jsonb);
 return jsonb_build_object('code','ACTIVE','userId',p_user,'schedule',schedule_value,
 'snapshotDigest',encode(sha256(convert_to((schedule_value-'at')::text,'UTF8')),'hex'));
end$$;
revoke all on function public.cluera_billing_recurring_snapshot(uuid,uuid,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.cluera_billing_recurring_snapshot(uuid,uuid,text,bigint) to service_role;
