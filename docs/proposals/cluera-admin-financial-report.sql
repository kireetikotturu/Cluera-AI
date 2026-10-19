-- UNAPPLIED, read-only Cluera Test financial reporting proposal. No activation,
-- financial writer, provider request or existing function/ACL change. The BFF
-- separately requires CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED=true (default off).
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
create index cluera_report_intent_cursor on cluera_billing_private.intents(created_at desc,id desc);
create index cluera_report_payment_intent on cluera_billing_private.payments(intent_id,payment_id desc);

create function public.cluera_billing_admin_report(p_actor uuid,p_session uuid,p_account_digest text,p_epoch bigint,
 p_from timestamptz,p_to timestamptz,p_subject uuid default null,
 p_before_created timestamptz default null,p_before_intent uuid default null,p_before_payment text default null)
returns jsonb language plpgsql stable security definer set search_path=''set timezone='UTC'set statement_timeout='5s'as $$
declare rows_value jsonb;count_value integer;page_value jsonb;totals jsonb;boundary jsonb;begin
 -- Explicit same live session, active verified customer and Admin allowlist.
 -- user_metadata, email strings and a browser-provided role confer no authority.
 if public.account_admin_check(p_actor,p_session,true)is not true
 or not exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id
  join public.customer_accounts a on a.user_id=u.id
  where u.id=p_actor and s.id=p_session and s.aal::text='aal2'and a.state='ACTIVE'
  and u.email_confirmed_at is not null and u.deleted_at is null and not coalesce(u.is_anonymous,false)
  and(u.banned_until is null or u.banned_until<=now())and(s.not_after is null or s.not_after>now()))
 then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_account_digest is null or p_account_digest!~'^[a-f0-9]{64}$'or p_epoch is null
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'
  and account_digest=p_account_digest and epoch=p_epoch)then return jsonb_build_object('code','UNAVAILABLE');end if;
 if p_from is null or p_to is null or not isfinite(p_from)or not isfinite(p_to)
 or p_from<'2000-01-01T00:00:00Z'::timestamptz or p_to<=p_from or p_to-p_from>interval '31 days'or p_to>statement_timestamp()+interval '5 seconds'
 or(p_before_created is null)<>(p_before_intent is null)
 or(p_before_created is null and p_before_payment is not null)
 or(p_before_created is not null and(not isfinite(p_before_created)or p_before_created<p_from or p_before_created>=p_to))
 or(p_before_payment is not null and p_before_payment!~'^pay_[A-Za-z0-9]{8,64}$')
 then return jsonb_build_object('code','INVALID');end if;

 -- Keyset order includes the intent and actual payment identity. One recurring
 -- intent can have many paid invoices. An unresolved request has payment=null;
 -- its expected catalog price is never counted as cleared money.
 select coalesce(jsonb_agg(v order by created_at desc,intent_id desc,payment_key desc),'[]')into rows_value from(
  select i.created_at,i.id intent_id,coalesce(p.payment_id,'')payment_key,
   jsonb_build_object('intentId',i.id,'userId',i.user_id,'createdAt',i.created_at,'intentState',i.state,
    'revision',jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'version',r.version,'name',r.name,
      'kind',r.kind,'amountPaise',r.amount_paise,'currency','INR'),
    'payment',case when p.payment_id is null then null else jsonb_build_object('paymentId',p.payment_id,
      'orderId',p.order_id,'invoiceId',p.invoice_id,'subscriptionId',p.subscription_id,'state',p.state,
      'amountPaise',p.amount_paise,'currency','INR','paidAt',p.paid_at)end)v
  from cluera_billing_private.intents i
  join cluera_billing_private.catalog_revisions r on r.id=i.revision_id
  left join cluera_billing_private.payments p on p.intent_id=i.id
  where i.account_digest=p_account_digest and i.epoch<=p_epoch
   and i.created_at>=p_from and i.created_at<p_to and(p_subject is null or i.user_id=p_subject)
   and(p_before_created is null or(i.created_at,i.id,coalesce(p.payment_id,''))<(p_before_created,p_before_intent,coalesce(p_before_payment,'')))
  order by i.created_at desc,i.id desc,coalesce(p.payment_id,'')desc limit 51
 )q;
 count_value:=jsonb_array_length(rows_value);
 select coalesce(jsonb_agg(value order by ordinality),'[]')into page_value
 from jsonb_array_elements(rows_value)with ordinality where ordinality<=50;
 -- A malformed physical relationship must not be silently counted or hidden.
 if exists(select 1 from jsonb_array_elements(page_value)x
  join cluera_billing_private.payments p on p.payment_id=x->'payment'->>'paymentId'
  join cluera_billing_private.intents i on i.id=p.intent_id
  join cluera_billing_private.catalog_revisions r on r.id=i.revision_id
  where p.user_id<>(x->>'userId')::uuid or p.revision_id<>(x->'revision'->>'revisionId')::uuid
   or p.amount_paise<>(x->'revision'->>'amountPaise')::integer or p.amount_paise not between 100 and 10000000
   or(r.kind='PACK'and(p.order_id is distinct from i.order_id or p.subscription_id is not null or p.invoice_id is not null))
   or(r.kind='RECURRING'and(p.subscription_id is distinct from i.subscription_id or p.invoice_id is null or p.paid_at is null)))
 then return jsonb_build_object('code','UNAVAILABLE');end if;
 select jsonb_build_object('scope','CURRENT_PAGE','currency','INR',
  'verifiedCount',count(*)filter(where x->'payment'->>'state'='VERIFIED'),
  'verifiedAmountPaise',coalesce(sum((x->'payment'->>'amountPaise')::bigint)filter(where x->'payment'->>'state'='VERIFIED'),0),
  'refundedCount',count(*)filter(where x->'payment'->>'state'='REFUNDED'),
  'refundedAmountPaise',coalesce(sum((x->'payment'->>'amountPaise')::bigint)filter(where x->'payment'->>'state'='REFUNDED'),0),
  'requestsWithoutPayment',count(*)filter(where x->'payment'='null'::jsonb))into totals from jsonb_array_elements(page_value)x;
 if count_value>50 then
  boundary:=jsonb_build_object('createdAt',page_value->49->'createdAt','intentId',page_value->49->'intentId',
   'paymentId',page_value->49->'payment'->'paymentId');
 end if;
 return jsonb_build_object('code','ACTIVE','from',p_from,'to',p_to,'subject',p_subject,'observedAt',statement_timestamp(),
  'rows',page_value,'totals',totals,'hasMore',count_value>50,'before',boundary);
end$$;
revoke all on function public.cluera_billing_admin_report(uuid,uuid,text,bigint,timestamptz,timestamptz,uuid,timestamptz,uuid,text)
 from public,anon,authenticated,service_role;
grant execute on function public.cluera_billing_admin_report(uuid,uuid,text,bigint,timestamptz,timestamptz,uuid,timestamptz,uuid,text)to service_role;
commit;
