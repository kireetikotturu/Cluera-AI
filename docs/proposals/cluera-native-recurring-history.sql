-- UNAPPLIED SELECT-only customer presentation extension. Requires the exact
-- applied customer-history migration and BOTH native financial proposals to be
-- installed first. This file neither installs nor enables financial processing.
-- Runtime separately requires CLUERA_NATIVE_RECURRING_HISTORY_ENABLED=true.
begin;
create function public.cluera_billing_native_history(p_user uuid,p_session uuid,p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql stable security definer set search_path=''set timezone='UTC'set statement_timeout='5s'as $$
declare base jsonb;projection jsonb;more boolean;raw_count integer;projected_count integer;begin
 base:=public.cluera_billing_history(p_user,p_session);
 if base->>'code'is distinct from 'ACTIVE'or base->>'userId'is distinct from p_user::text then return base;end if;
 if p_account_digest is null or p_account_digest!~'^[a-f0-9]{64}$'or p_epoch is null
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'and account_digest=p_account_digest and epoch=p_epoch)
 then return jsonb_build_object('code','UNAVAILABLE');end if;
 -- Snapshot only. Do not call native_live/refresh, authorization bootstraps,
 -- usage settlement, command RPCs, provider reads or any financial writer.
 with raw as materialized(
 select t.value,row_number()over(order by(t.value->>'sequence')::bigint desc,t.value->>'invoiceId'desc)ordinal
 from cluera_billing_private.native_schedules ns,jsonb_array_elements(ns.schedule->'terms')t(value)
 where ns.user_id=p_user order by(t.value->>'sequence')::bigint desc,t.value->>'invoiceId'desc limit 51
 ),projected as materialized(
 select raw.ordinal,jsonb_build_object(
 'invoiceId',p.invoice_id,'subscriptionId',p.subscription_id,'state',raw.value->>'state',
 'startsAt',to_timestamp((raw.value->>'startsAt')::numeric/1000),'endsAt',to_timestamp((raw.value->>'endsAt')::numeric/1000),
 'savedWallMilliseconds',(raw.value->>'remainingWallMs')::bigint,
 'allowanceMilliseconds',r.allowance_seconds::bigint*1000,'spentMilliseconds',coalesce(g.spent_ms,0),'reservedMilliseconds',coalesce(g.reserved_ms,0),
 'remainingAllowanceMilliseconds',case when raw.value->>'state'in('ACTIVE','SUSPENDED','QUEUED','PRESERVED')then greatest(0,r.allowance_seconds::bigint*1000-coalesce(g.spent_ms,0)-coalesce(g.reserved_ms,0))else 0 end,
 'spendableMilliseconds',case when raw.value->>'state'='ACTIVE'and g.state='ACTIVE'and g.starts_at<=statement_timestamp()and g.expires_at>statement_timestamp()
 and to_timestamp((raw.value->>'startsAt')::numeric/1000)<=statement_timestamp()and to_timestamp((raw.value->>'endsAt')::numeric/1000)>statement_timestamp()
 then greatest(0,g.granted_ms-g.spent_ms-g.reserved_ms)else 0 end,
 'revision',jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'version',r.version,'name',r.name,'kind',r.kind,
 'amountPaise',r.amount_paise,'currency',r.currency,'allowanceSeconds',r.allowance_seconds))value
 from raw join cluera_billing_private.payments p on p.invoice_id=raw.value->>'invoiceId'and p.user_id=p_user
 and p.payment_id=raw.value->>'paymentId'and p.order_id=raw.value->>'orderId'and p.subscription_id=raw.value->>'subscriptionId'
 join cluera_billing_private.intents i on i.id=p.intent_id and i.user_id=p_user and i.subscription_id=p.subscription_id
 and i.account_digest=p_account_digest and i.epoch<=p_epoch and i.revision_id=p.revision_id
 join cluera_billing_private.subscriptions s on s.subscription_id=p.subscription_id and s.user_id=p_user and s.intent_id=i.id and s.account_digest=p_account_digest
 join cluera_billing_private.terms compatible on compatible.invoice_id=p.invoice_id and compatible.user_id=p_user and compatible.subscription_id=p.subscription_id
 and compatible.grant_id is not distinct from p.grant_id
 and compatible.state=case raw.value->>'state'when 'PRESERVED'then 'ENDED'when 'SUSPENDED'then 'PAUSED'else raw.value->>'state'end
 join cluera_billing_private.catalog_revisions r on r.id=p.revision_id and r.id::text=raw.value->>'revisionId'and r.kind='RECURRING'and r.offer_code=raw.value->>'offerCode'
 and r.amount_paise=p.amount_paise and r.allowance_seconds::bigint*1000=(raw.value->>'grantedMs')::bigint
 left join public.customer_usage_grants g on g.id=p.grant_id and g.user_id=p_user
 where(p.grant_id is not null and g.id is not null and g.kind='RECURRING'and g.granted_ms=r.allowance_seconds::bigint*1000
 and g.source_key='razorpay-test-invoice:'||p.invoice_id
 and p.state=case when raw.value->>'state'='REFUNDED'then 'REFUNDED'else 'VERIFIED'end
 and g.state=case raw.value->>'state'when 'ACTIVE'then 'ACTIVE'when 'ENDED'then 'REVOKED'when 'REFUNDED'then 'REVOKED'else 'PAUSED'end)
 or(p.grant_id is null and p.state='REFUNDED'and raw.value->>'state'='REFUNDED')
 )
 select(select count(*)from raw),count(*),coalesce(max(ordinal)>50,false),
 coalesce(jsonb_agg(value order by ordinal)filter(where ordinal<=50),'[]')into raw_count,projected_count,more,projection from projected;
 if raw_count<>projected_count then return jsonb_build_object('code','UNAVAILABLE');end if;
 return base||jsonb_build_object('nativeSchedule',jsonb_build_object('observedAt',statement_timestamp(),'terms',projection,'hasMoreTerms',more));
end$$;
revoke all on function public.cluera_billing_native_history(uuid,uuid,text,bigint)from public,anon,authenticated,service_role;
grant execute on function public.cluera_billing_native_history(uuid,uuid,text,bigint)to service_role;
commit;
