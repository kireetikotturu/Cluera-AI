-- UNAPPLIED REVIEW PROPOSAL. Do not execute against the retained database without
-- separate schema approval. This file does NOT switch scheduler/webhook URLs,
-- import secrets, activate checkout, change a historical financial row or grant.
-- New recurring purchases conservatively reject competing old/new recurring
-- entitlements; automatic cross-provider pause/queue/cancel is NOT implemented.
create schema cluera_billing_private;
revoke all on schema cluera_billing_private from public,anon,authenticated,service_role;

create table cluera_billing_private.catalog_revisions (
 id uuid primary key default gen_random_uuid(), offer_code text not null check(offer_code in
 ('cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2')),
 version integer not null check(version>0), name text not null check(length(trim(name)) between 2 and 80),
 amount_paise integer not null check(amount_paise between 100 and 10000000), currency text not null default 'INR' check(currency='INR'),
 allowance_seconds integer not null check(allowance_seconds between 60 and 3600000),
 kind text not null check(kind in ('PACK','RECURRING')), interval_name text check(interval_name='MONTH'),
 razorpay_plan_id text check(razorpay_plan_id ~ '^plan_[A-Za-z0-9]{8,64}$'),total_count integer check(total_count between 1 and 120),created_at timestamptz not null default clock_timestamp(),
 unique(offer_code,version),unique(offer_code,id),
 check((kind='PACK' and interval_name is null and razorpay_plan_id is null and total_count is null and offer_code='cluera_pack_3h_v2')
 or(kind='RECURRING' and interval_name='MONTH' and total_count is not null and offer_code<>'cluera_pack_3h_v2'))
);
create table cluera_billing_private.catalog_heads (
 offer_code text primary key, revision_id uuid not null, enabled boolean not null default false,
 foreign key(offer_code,revision_id) references cluera_billing_private.catalog_revisions(offer_code,id)
);
insert into cluera_billing_private.catalog_revisions(offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,total_count) values
 ('cluera_pack_3h_v2',1,'Cluera 3 Hours',54900,10800,'PACK',null,null),
 ('cluera_monthly_40h_v2',1,'Cluera Pro 40 Hours Monthly',549900,144000,'RECURRING','MONTH',120),
 ('cluera_monthly_100h_v2',1,'Cluera Pro 100 Hours Monthly',959900,360000,'RECURRING','MONTH',120),
 ('cluera_monthly_200h_v2',1,'Cluera Enterprise 200 Hours Monthly',1954900,720000,'RECURRING','MONTH',120);
insert into cluera_billing_private.catalog_heads(offer_code,revision_id) select offer_code,id from cluera_billing_private.catalog_revisions;
create table cluera_billing_private.plan_verifications (
 revision_id uuid not null references cluera_billing_private.catalog_revisions(id),account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),
 evidence jsonb not null,observed_at timestamptz not null,primary key(revision_id,account_digest)
);
create table cluera_billing_private.admin_audit (
 operation_id uuid primary key,actor_id uuid not null references public.account_admin_profiles(user_id),session_id uuid not null,
 action text not null,reason text not null check(length(trim(reason)) between 10 and 500),input jsonb not null,before_row jsonb not null,after_row jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.processing_owner (
 singleton boolean primary key default true check(singleton),owner text not null check(owner in ('account','cluera')),
 epoch bigint not null check(epoch>0),account_digest text check(account_digest ~ '^[a-f0-9]{64}$'),
 changed_at timestamptz not null default clock_timestamp()
);
-- Policy only: old handlers continue unchanged until a separately approved CAS.
insert into cluera_billing_private.processing_owner(singleton,owner,epoch) values(true,'account',1);
create table cluera_billing_private.cutover_audit (
 operation_id uuid primary key,reason text not null check(length(trim(reason)) between 10 and 500),
 before_row jsonb not null,after_row jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.worker_nonces (
 nonce uuid primary key,epoch bigint not null,issued_at timestamptz not null,consumed_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.intents (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.customer_accounts(user_id),request_id uuid not null,
 attempt_id uuid not null default gen_random_uuid(),revision_id uuid not null references cluera_billing_private.catalog_revisions(id),
 account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),epoch bigint not null,
 state text not null check(state in ('CREATING','BOUND','UNCERTAIN','VERIFIED','REFUNDED')),
 order_id text unique check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'),subscription_id text unique check(subscription_id ~ '^sub_[A-Za-z0-9]{8,64}$'),
 created_at timestamptz not null default clock_timestamp(),unique(user_id,request_id),unique(user_id,id),
 check(state not in ('BOUND','VERIFIED','REFUNDED') or order_id is not null or subscription_id is not null)
);
create unique index cluera_one_unresolved_intent on cluera_billing_private.intents(user_id) where state in ('CREATING','BOUND','UNCERTAIN');
create index cluera_intents_owner on cluera_billing_private.intents(user_id,created_at desc,id);
create table cluera_billing_private.events (
 event_id text primary key check(event_id ~ '^[A-Za-z0-9_-]{8,128}$'),account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),
 event_type text not null check(event_type in ('payment.captured','order.paid','refund.processed','subscription.charged','subscription.activated',
 'subscription.pending','subscription.halted','subscription.cancelled','subscription.paused','subscription.resumed','subscription.completed','subscription.authenticated','subscription.updated')),
 resource_id text not null, payment_id text check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),order_id text check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'),
 subscription_id text check(subscription_id ~ '^sub_[A-Za-z0-9]{8,64}$'),invoice_id text check(invoice_id ~ '^inv_[A-Za-z0-9]{8,64}$'),
 digest text not null check(digest ~ '^[a-f0-9]{64}$'),occurred_at timestamptz not null check(isfinite(occurred_at)),
 received_at timestamptz not null default clock_timestamp(),state text not null default 'PENDING' check(state in ('PENDING','PROCESSED','QUARANTINED')),
 claim_id uuid,lease_until timestamptz,retry_at timestamptz not null default clock_timestamp(),attempts integer not null default 0
);
create index cluera_events_due on cluera_billing_private.events(retry_at,received_at,event_id) where state='PENDING';
create table cluera_billing_private.subscriptions (
 subscription_id text primary key,user_id uuid not null references public.customer_accounts(user_id),intent_id uuid not null references cluera_billing_private.intents(id),
 revision_id uuid not null references cluera_billing_private.catalog_revisions(id),account_digest text not null,
 state text not null check(state in ('ACTIVE','PAST_DUE','CANCELED','PAUSED')),observed_at timestamptz not null,
 paid_through timestamptz,grace_until timestamptz,cancel_future boolean not null default false,
 cancellation_at timestamptz check(cancellation_at is null or isfinite(cancellation_at)),unique(user_id,subscription_id)
);
create table cluera_billing_private.payments (
 payment_id text primary key check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),order_id text not null unique,
 intent_id uuid not null references cluera_billing_private.intents(id),user_id uuid not null references public.customer_accounts(user_id),
 invoice_id text unique check(invoice_id ~ '^inv_[A-Za-z0-9]{8,64}$'),subscription_id text references cluera_billing_private.subscriptions(subscription_id),
 amount_paise integer not null,revision_id uuid not null references cluera_billing_private.catalog_revisions(id),grant_id uuid,
 state text not null check(state in ('VERIFIED','REFUNDED')),period_start timestamptz,period_end timestamptz,
 paid_at timestamptz check(paid_at is null or isfinite(paid_at)),
 foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
 check((subscription_id is null and invoice_id is null and period_start is null and period_end is null and paid_at is null)
 or(subscription_id is not null and invoice_id is not null and period_end>period_start and paid_at is not null))
);
create table cluera_billing_private.terms (
 invoice_id text primary key references cluera_billing_private.payments(invoice_id),user_id uuid not null,
 subscription_id text not null,grant_id uuid,state text not null check(state in ('ACTIVE','QUEUED','PAUSED','ENDED','REFUNDED')),
 period_start timestamptz not null,period_end timestamptz not null,ends_at timestamptz not null,
 foreign key(user_id,subscription_id) references cluera_billing_private.subscriptions(user_id,subscription_id),
 foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),unique(subscription_id,period_start),
 check(period_end>period_start and isfinite(period_start) and isfinite(period_end))
);
create unique index cluera_one_active_term on cluera_billing_private.terms(user_id) where state in ('ACTIVE','PAUSED');
create index cluera_terms_due_queue on cluera_billing_private.terms(user_id,period_start,invoice_id) where state='QUEUED';
create table cluera_billing_private.applications (
 event_id text primary key references cluera_billing_private.events(event_id),intent_id uuid not null references cluera_billing_private.intents(id),
 action text not null check(action in ('GRANT','REFUND','STATUS')),evidence jsonb not null,before_row jsonb not null,after_row jsonb not null,
 removed_ms bigint not null default 0 check(removed_ms>=0),created_at timestamptz not null default clock_timestamp()
);

create function cluera_billing_private.immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='42501',message='Cluera billing record is immutable';end$$;
do $$declare t text;begin
 foreach t in array array['catalog_revisions','catalog_heads','plan_verifications','admin_audit','processing_owner','cutover_audit','worker_nonces','intents','events','subscriptions','payments','terms','applications'] loop
 execute format('alter table cluera_billing_private.%I enable row level security',t);
 execute format('revoke all on cluera_billing_private.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach t in array array['catalog_revisions','plan_verifications','admin_audit','cutover_audit','worker_nonces','applications'] loop
 execute format('create trigger immutable before update or delete or truncate on cluera_billing_private.%I for each statement execute function cluera_billing_private.immutable()',t);
 execute format('alter table cluera_billing_private.%I enable always trigger immutable',t);
 end loop;
end$$;
create function public.cluera_billing_worker_nonce(p_nonce uuid,p_issued_at timestamptz,p_epoch bigint,p_account_digest text) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if p_nonce is null or p_epoch is null or p_issued_at is null or not isfinite(p_issued_at)
 or p_issued_at<clock_timestamp()-interval '60 seconds' or p_issued_at>clock_timestamp()+interval '5 seconds' then return 'INVALID';end if;
 if cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return 'UNAVAILABLE';end if;
 insert into cluera_billing_private.worker_nonces(nonce,epoch,issued_at) values(p_nonce,p_epoch,p_issued_at) on conflict do nothing;
 return case when found then 'CLAIMED' else 'REPLAY' end;
end$$;

create function public.cluera_billing_event_accept(p_event jsonb,p_account_digest text) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e cluera_billing_private.events;occurred timestamptz;begin
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_event) is distinct from 'object'
 or (p_event-array['eventId','eventType','resourceId','paymentId','orderId','subscriptionId','invoiceId','digest','occurredAt'])<>'{}'::jsonb
 or p_event->>'eventId' is null or p_event->>'digest' is null or p_event->>'resourceId' is null then return 'INVALID';end if;
 begin occurred:=(p_event->>'occurredAt')::timestamptz;exception when others then return 'INVALID';end;
 if occurred is null or not isfinite(occurred) then return 'INVALID';end if;
 -- The old canonical order keeps the SAME receipt, intent, unique grant key and
 -- immutable application audits. Never copy it into the new financial tables.
 if exists(select 1 from billing_private.payment_intents where order_id=p_event->>'orderId' and account_digest=p_account_digest)
 or exists(select 1 from billing_private.payment_events where event_id=p_event->>'eventId') then
 if p_event->>'eventType' not in ('payment.captured','order.paid','refund.processed') or p_event->>'paymentId' is null then return 'INVALID';end if;
 return public.account_payment_receive(p_event-array['subscriptionId','invoiceId'],p_account_digest);
 end if;
 insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,payment_id,order_id,subscription_id,invoice_id,digest,occurred_at)
 values(p_event->>'eventId',p_account_digest,p_event->>'eventType',p_event->>'resourceId',p_event->>'paymentId',p_event->>'orderId',p_event->>'subscriptionId',p_event->>'invoiceId',p_event->>'digest',occurred)
 on conflict do nothing;
 if found then return 'STORED';end if;
 select * into strict e from cluera_billing_private.events where event_id=p_event->>'eventId' for update;
 if e.account_digest<>p_account_digest or e.event_type is distinct from p_event->>'eventType' or e.resource_id is distinct from p_event->>'resourceId'
 or e.payment_id is distinct from p_event->>'paymentId' or e.order_id is distinct from p_event->>'orderId' or e.subscription_id is distinct from p_event->>'subscriptionId'
 or e.invoice_id is distinct from p_event->>'invoiceId' or e.digest is distinct from p_event->>'digest' or e.occurred_at is distinct from occurred then
 update cluera_billing_private.events set state='QUARANTINED' where event_id=e.event_id;return 'CONFLICT';end if;
 return case when e.state='QUARANTINED' then 'CONFLICT' else 'DUPLICATE' end;
end$$;
create function public.cluera_billing_event_claim(p_account_digest text,p_epoch bigint) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e cluera_billing_private.events;c uuid:=gen_random_uuid();legacy jsonb;oldest_new timestamptz;oldest_old timestamptz;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 select min(received_at) into oldest_new from cluera_billing_private.events where account_digest=p_account_digest and state='PENDING' and retry_at<=clock_timestamp()
 and (lease_until is null or lease_until<clock_timestamp()) and attempts<20;
 select min(received_at) into oldest_old from billing_private.payment_events where account_digest=p_account_digest and state='PENDING' and retry_at<=clock_timestamp()
 and (lease_until is null or lease_until<clock_timestamp()) and attempts<20;
 -- One chronological selection across both durable inboxes, not permanent
 -- priority for an old endpoint that could starve current Cluera receipts.
 if oldest_old is not null and (oldest_new is null or oldest_old<=oldest_new) then
 legacy:=public.account_payment_claim_account_base(p_account_digest);
 if legacy->>'code'='CLAIMED' then return legacy||jsonb_build_object('legacy',true,'subscriptionId',null,'invoiceId',null,
 'occurredAt',(select occurred_at from billing_private.payment_events where event_id=legacy->>'eventId'));end if;
 end if;
 select * into e from cluera_billing_private.events where account_digest=p_account_digest and state='PENDING' and retry_at<=clock_timestamp()
 and (lease_until is null or lease_until<clock_timestamp()) and attempts<20 order by received_at,event_id limit 1 for update skip locked;
 if not found then
 legacy:=public.account_payment_claim_account_base(p_account_digest);
 return case when legacy->>'code'='CLAIMED' then legacy||jsonb_build_object('legacy',true,'subscriptionId',null,'invoiceId',null,
 'occurredAt',(select occurred_at from billing_private.payment_events where event_id=legacy->>'eventId')) else jsonb_build_object('code','EMPTY') end;end if;
 update cluera_billing_private.events set claim_id=c,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 where event_id=e.event_id;
 return jsonb_build_object('code','CLAIMED','legacy',false,'eventId',e.event_id,'eventType',e.event_type,'resourceId',e.resource_id,
 'paymentId',e.payment_id,'orderId',e.order_id,'subscriptionId',e.subscription_id,'invoiceId',e.invoice_id,'digest',e.digest,'occurredAt',e.occurred_at,'claimId',c);
end$$;
create function public.cluera_billing_event_finish(p_event text,p_claim uuid,p_epoch bigint,p_retry boolean) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare d text;begin
 if p_claim is null or p_epoch is null or p_retry is distinct from true then return 'INVALID';end if;
 select account_digest into d from cluera_billing_private.events where event_id=p_event;
 if not found then select account_digest into d from billing_private.payment_events where event_id=p_event;end if;
 if cluera_billing_private.owns(d,'cluera',p_epoch) is not true then return 'UNAVAILABLE';end if;
 if exists(select 1 from billing_private.payment_events where event_id=p_event) then return public.account_payment_retry(p_event,p_claim);end if;
 update cluera_billing_private.events set claim_id=null,lease_until=null,retry_at=clock_timestamp()+interval '1 minute'
 where event_id=p_event and claim_id=p_claim and state='PENDING';return case when found then 'PENDING' else 'CONFLICT' end;
end$$;

-- Account lock first. Future paid invoices are funded but PAUSED until their
-- exact immutable billing start; accepting one never ends today's paid cycle.
create function cluera_billing_private.refresh(p_user uuid,p_at timestamptz) returns void
language plpgsql security invoker set search_path='' as $$declare t record;q record;s cluera_billing_private.subscriptions;target timestamptz;begin
 if p_at is null or not isfinite(p_at) then return;end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 for t in select * from cluera_billing_private.terms where user_id=p_user and state in ('ACTIVE','PAUSED') and ends_at<=p_at order by invoice_id for update loop
 select * into strict s from cluera_billing_private.subscriptions where subscription_id=t.subscription_id;
 target:=case when s.state='PAST_DUE' and not s.cancel_future and s.paid_through=t.period_end then s.grace_until else null end;
 if target is not null and target>p_at then
 update cluera_billing_private.terms set ends_at=target where invoice_id=t.invoice_id;
 update public.customer_usage_grants set expires_at=target where id=t.grant_id;
 else
 if t.grant_id is not null then perform public.customer_recurring_stop_grant(p_user,t.grant_id,least(p_at,t.ends_at));
 update public.customer_usage_grants set state='REVOKED' where id=t.grant_id;end if;
 update cluera_billing_private.terms set state='ENDED' where invoice_id=t.invoice_id;
 end if;
 end loop;
 for q in select * from cluera_billing_private.terms where user_id=p_user and state='QUEUED' and period_start<=p_at
 order by period_start,invoice_id for update loop
 select * into strict s from cluera_billing_private.subscriptions where subscription_id=q.subscription_id;
 target:=case when s.state='PAST_DUE' and not s.cancel_future and s.paid_through=q.period_end then s.grace_until else null end;
 if q.ends_at<=p_at and (target is null or target<=p_at) then
 update public.customer_usage_grants set state='REVOKED' where id=q.grant_id;
 update cluera_billing_private.terms set state='ENDED' where invoice_id=q.invoice_id;continue;
 end if;
 -- Do not activate behind a separately funded legacy/other subscription.
 -- The original paid invoice remains QUEUED for explicit conflict review.
 if exists(select 1 from public.customer_recurring_terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=p_user and subscription_id<>q.subscription_id
 and state in ('ACTIVE','PAUSED') and ends_at>p_at) then continue;end if;
 for t in select * from cluera_billing_private.terms where user_id=p_user and subscription_id=q.subscription_id
 and state in ('ACTIVE','PAUSED') order by period_start,invoice_id for update loop
 if t.grant_id is not null then
 perform public.customer_recurring_stop_grant(p_user,t.grant_id,least(q.period_start,t.ends_at));
 update public.customer_usage_grants set state='REVOKED' where id=t.grant_id;end if;
 update cluera_billing_private.terms set state='ENDED' where invoice_id=t.invoice_id;
 end loop;
 target:=greatest(q.ends_at,coalesce(target,q.ends_at));
 update public.customer_usage_grants set state=case when s.state='PAUSED' then 'PAUSED' else 'ACTIVE' end,
 expires_at=target where id=q.grant_id and state='PAUSED';
 update cluera_billing_private.terms set state=case when s.state='PAUSED' then 'PAUSED' else 'ACTIVE' end,
 ends_at=target where invoice_id=q.invoice_id;
 end loop;
end$$;
create function public.cluera_billing_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;e cluera_billing_private.events;s cluera_billing_private.subscriptions;
 paid cluera_billing_private.payments;observed timestamptz;ps timestamptz;pe timestamptz;paid_at_value timestamptz;cancel_at_value timestamptz;cutoff timestamptz;
 t timestamptz:=date_trunc('milliseconds',clock_timestamp());
 action_value text:=p_evidence->>'action';grant_value uuid;removed bigint:=0;before_value jsonb;state_value text;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 if jsonb_typeof(p_evidence) is distinct from 'object' or (p_evidence-array['action','intentId','orderId','paymentId','invoiceId','subscriptionId','amountPaise','currency','observedAt','periodStart','periodEnd','subscriptionState','refundId','paidAt','cancellationAt'])<>'{}'::jsonb
 or action_value is null or action_value not in ('GRANT','REFUND','STATUS') or p_event is null or p_claim is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('code','INVALID');end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;ps:=(p_evidence->>'periodStart')::timestamptz;pe:=(p_evidence->>'periodEnd')::timestamptz;
 paid_at_value:=(p_evidence->>'paidAt')::timestamptz;cancel_at_value:=(p_evidence->>'cancellationAt')::timestamptz;
 select * into i from cluera_billing_private.intents where id=(p_evidence->>'intentId')::uuid;
 exception when others then return jsonb_build_object('code','INVALID');end;
 if i.id is null then return jsonb_build_object('code','UNBOUND');end if;
 if observed is null or not isfinite(observed) or observed<t-interval '2 minutes' or observed>t+interval '5 seconds' then return jsonb_build_object('code','INVALID');end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into strict i from cluera_billing_private.intents where id=i.id for update;
 select * into strict r from cluera_billing_private.catalog_revisions where id=i.revision_id;
 -- Creation epoch is provenance; current worker epoch above fences fulfillment
 -- after approved rollback/re-cutover, with the same immutable unique sources.
 select * into e from cluera_billing_private.events where event_id=p_event for update;
 if not found or e.state<>'PENDING' or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=t
 or e.digest<>p_digest or e.account_digest<>p_account_digest or i.account_digest<>p_account_digest
 or i.state not in ('BOUND','VERIFIED','REFUNDED') then return jsonb_build_object('code','CONFLICT');end if;
 -- Captured/charged payloads may omit order/subscription/invoice links. Missing
 -- links are resolved only by independent provider GETs and canonical binding;
 -- any PRESENT signed link still has to match exactly.
 if (action_value<>'STATUS' and e.payment_id is not null and e.payment_id is distinct from p_evidence->>'paymentId')
 or (action_value<>'STATUS' and e.order_id is not null and e.order_id is distinct from p_evidence->>'orderId')
 or (e.subscription_id is not null and e.subscription_id is distinct from p_evidence->>'subscriptionId')
 or (action_value<>'STATUS' and e.invoice_id is not null and e.invoice_id is distinct from p_evidence->>'invoiceId') then return jsonb_build_object('code','CONFLICT');end if;
 if (e.event_type='payment.captured' and e.resource_id is distinct from p_evidence->>'paymentId')
 or (e.event_type='order.paid' and e.resource_id is distinct from p_evidence->>'orderId')
 or (e.event_type='subscription.charged' and e.resource_id is distinct from p_evidence->>'subscriptionId') then return jsonb_build_object('code','CONFLICT');end if;
 if action_value='GRANT' and e.event_type in ('payment.captured','subscription.charged') and e.payment_id is null then return jsonb_build_object('code','INVALID');end if;
 if r.kind='PACK' and (i.order_id is distinct from p_evidence->>'orderId' or p_evidence->>'subscriptionId' is not null or p_evidence->>'invoiceId' is not null or ps is not null or pe is not null or paid_at_value is not null or cancel_at_value is not null or action_value='STATUS')
 or r.kind='RECURRING' and (i.subscription_id is distinct from p_evidence->>'subscriptionId'
 or (p_evidence->>'subscriptionState' is null and not(action_value='STATUS' and e.event_type='subscription.authenticated'))
 or (p_evidence->>'subscriptionState' is not null and p_evidence->>'subscriptionState' not in ('ACTIVE','PAST_DUE','CANCELED','PAUSED'))
 or (p_evidence->>'subscriptionState'='CANCELED' and (cancel_at_value is null or not isfinite(cancel_at_value) or cancel_at_value>observed+interval '5 seconds'))
 or (p_evidence->>'subscriptionState' is distinct from 'CANCELED' and cancel_at_value is not null)) then return jsonb_build_object('code','INVALID');end if;
 if action_value<>'STATUS' and (p_evidence->>'currency' is distinct from 'INR' or p_evidence->>'amountPaise' is distinct from r.amount_paise::text
 or p_evidence->>'orderId' is null or p_evidence->>'orderId' !~ '^order_[A-Za-z0-9]{8,64}$'
 or p_evidence->>'paymentId' is null or p_evidence->>'paymentId' !~ '^pay_[A-Za-z0-9]{8,64}$'
 or (r.kind='RECURRING' and (p_evidence->>'invoiceId' is null or p_evidence->>'invoiceId' !~ '^inv_[A-Za-z0-9]{8,64}$'
 or ps is null or pe is null or not isfinite(ps) or not isfinite(pe) or ps>t+interval '32 days' or pe-ps not between interval '27 days' and interval '32 days'
 or paid_at_value is null or not isfinite(paid_at_value) or paid_at_value>observed+interval '5 seconds')))
 then return jsonb_build_object('code','INVALID');end if;
 if (action_value='GRANT' and (e.event_type not in ('payment.captured','order.paid','subscription.charged') or p_evidence->>'refundId' is not null))
 or (action_value='REFUND' and (e.event_type<>'refund.processed' or p_evidence->>'refundId' is null or p_evidence->>'refundId' !~ '^rfnd_[A-Za-z0-9]{8,64}$' or e.resource_id is distinct from p_evidence->>'refundId'))
 or (action_value='STATUS' and (e.event_type not like 'subscription.%' or e.event_type='subscription.charged' or e.resource_id is distinct from i.subscription_id
 or p_evidence->>'paymentId' is not null or p_evidence->>'orderId' is not null or p_evidence->>'invoiceId' is not null or ps is not null or pe is not null or paid_at_value is not null)) then return jsonb_build_object('code','INVALID');end if;
 -- Validate every rejection path BEFORE mutable subscription/term metadata.
 -- A CONFLICT/REVIEW/PENDING result is a no-op on all financial business rows;
 -- only the previously acquired receipt lease exists outside this transaction.
 if r.kind='RECURRING' then
 select * into s from cluera_billing_private.subscriptions where subscription_id=i.subscription_id for update;
 if s.subscription_id is not null and (s.user_id<>i.user_id or s.revision_id<>r.id or s.account_digest<>p_account_digest) then return jsonb_build_object('code','CONFLICT');end if;
 end if;
 if action_value<>'STATUS' then
 select * into paid from cluera_billing_private.payments where payment_id=p_evidence->>'paymentId' or order_id=p_evidence->>'orderId' or invoice_id=p_evidence->>'invoiceId' for update;
 if paid.payment_id is not null and (paid.payment_id is distinct from p_evidence->>'paymentId' or paid.order_id is distinct from p_evidence->>'orderId'
 or paid.intent_id<>i.id or paid.user_id<>i.user_id or paid.revision_id<>r.id or paid.amount_paise<>r.amount_paise or paid.invoice_id is distinct from p_evidence->>'invoiceId'
 or paid.subscription_id is distinct from p_evidence->>'subscriptionId' or paid.period_start is distinct from ps or paid.period_end is distinct from pe or paid.paid_at is distinct from paid_at_value) then return jsonb_build_object('code','CONFLICT');end if;
 if exists(select 1 from billing_private.payment_intents where order_id=p_evidence->>'orderId' or payment_id=p_evidence->>'paymentId')
 or (r.kind='RECURRING' and exists(select 1 from cluera_billing_private.terms where subscription_id=i.subscription_id and period_start=ps and invoice_id is distinct from p_evidence->>'invoiceId')) then return jsonb_build_object('code','CONFLICT');end if;
 if paid.payment_id is null and action_value='GRANT' then
 if i.state='REFUNDED' and r.kind='PACK' then return jsonb_build_object('code','CONFLICT');end if;
 if r.kind='RECURRING' and (exists(select 1 from public.customer_recurring_terms where user_id=i.user_id and state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=i.user_id and subscription_id<>i.subscription_id and state in ('ACTIVE','QUEUED','PAUSED') and ends_at>t)
 or (s.paid_through is not null and ps<>s.paid_through)
 or (select count(*) from cluera_billing_private.terms where subscription_id=i.subscription_id)>=r.total_count) then return jsonb_build_object('code','REVIEW');end if;
 if r.kind='RECURRING' then
 cutoff:=case when s.cancellation_at is null then cancel_at_value when cancel_at_value is null then s.cancellation_at else least(s.cancellation_at,cancel_at_value) end;
 -- Cancellation stops future billing, not time already funded before it.
 -- Unknown cutoff or a newly paid post-cancel invoice stays review-only.
 if (s.cancel_future and cutoff is null) or (cutoff is not null and paid_at_value>cutoff) then return jsonb_build_object('code','REVIEW');end if;
 end if;
 if not exists(select 1 from public.customer_accounts a join auth.users u on u.id=a.user_id where a.user_id=i.user_id and a.state='ACTIVE' and u.email_confirmed_at is not null)
 then return jsonb_build_object('code','PENDING');end if;
 end if;
 end if;
 before_value:=jsonb_build_object('intent',to_jsonb(i),
 'entitlements',(select coalesce(jsonb_agg(jsonb_build_object('term',to_jsonb(x),'grant',to_jsonb(g)) order by x.period_start),'[]') from cluera_billing_private.terms x left join public.customer_usage_grants g on g.id=x.grant_id where x.subscription_id=i.subscription_id),
 'subscription',(select to_jsonb(x) from cluera_billing_private.subscriptions x where x.subscription_id=i.subscription_id),
 'payment',(select to_jsonb(x) from cluera_billing_private.payments x where x.payment_id=p_evidence->>'paymentId'),
 'term',(select to_jsonb(x) from cluera_billing_private.terms x where x.invoice_id=p_evidence->>'invoiceId'),
 'grant',(select to_jsonb(g) from public.customer_usage_grants g join cluera_billing_private.payments x on x.grant_id=g.id where x.payment_id=p_evidence->>'paymentId'));
 state_value:=i.state;
 if action_value='STATUS' and e.event_type='subscription.authenticated' then
 -- Authentication/mandate is never paid state, including a late auth receipt
 -- received AFTER genuine invoice processing. Preserve current paid state.
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row)
 values(e.event_id,i.id,'STATUS',p_evidence,before_value,before_value);
 return jsonb_build_object('code','NO_GRANT');
 end if;
 if r.kind='RECURRING' then
 select * into s from cluera_billing_private.subscriptions where subscription_id=i.subscription_id for update;
 if not found then
 if action_value='STATUS' then
 -- Mandate/authentication/setup notifications never create subscriptions/grants.
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row) values(e.event_id,i.id,'STATUS',p_evidence,before_value,before_value);
 return jsonb_build_object('code','NO_GRANT');end if;
 insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at,cancel_future,cancellation_at)
 values(i.subscription_id,i.user_id,i.id,r.id,p_account_digest,p_evidence->>'subscriptionState',observed,p_evidence->>'subscriptionState'='CANCELED',cancel_at_value) returning * into s;
 elsif s.user_id<>i.user_id or s.revision_id<>r.id or s.account_digest<>p_account_digest then return jsonb_build_object('code','CONFLICT');end if;
 if observed>s.observed_at then
 update cluera_billing_private.subscriptions set state=p_evidence->>'subscriptionState',observed_at=observed,
 cancel_future=cancel_future or p_evidence->>'subscriptionState'='CANCELED',
 cancellation_at=case when cancellation_at is null then cancel_at_value when cancel_at_value is null then cancellation_at else least(cancellation_at,cancel_at_value) end,
 grace_until=case when p_evidence->>'subscriptionState'='PAST_DUE' and not cancel_future then coalesce(grace_until,paid_through+interval '1 day') else null end
 where subscription_id=s.subscription_id returning * into s;
 end if;
 if action_value='STATUS' and observed>=s.observed_at then
 if s.state='PAUSED' then
 perform public.customer_recurring_stop_grant(i.user_id,x.grant_id,t) from cluera_billing_private.terms x where x.subscription_id=s.subscription_id and x.state='ACTIVE';
 update public.customer_usage_grants g set state='PAUSED' from cluera_billing_private.terms x where x.subscription_id=s.subscription_id and x.state='ACTIVE' and g.id=x.grant_id;
 update cluera_billing_private.terms set state='PAUSED' where subscription_id=s.subscription_id and state='ACTIVE';
 elsif s.state='ACTIVE' then
 -- Resume comes only from verified provider state, never merchant mandate code.
 update public.customer_usage_grants g set state='ACTIVE' from cluera_billing_private.terms x where x.subscription_id=s.subscription_id and x.state='PAUSED' and x.ends_at>t and g.id=x.grant_id;
 update cluera_billing_private.terms set state='ACTIVE' where subscription_id=s.subscription_id and state='PAUSED' and ends_at>t;
 elsif s.state='PAST_DUE' and not s.cancel_future and s.grace_until>t then
 -- A delayed failure may reopen only this original paid cycle during its ONE
 -- fixed day, never a new grant/time or an already-refunded/competing cycle.
 if not exists(select 1 from public.customer_recurring_terms where user_id=i.user_id and state in ('ACTIVE','QUEUED','PAUSED'))
 and not exists(select 1 from cluera_billing_private.terms where user_id=i.user_id and subscription_id<>s.subscription_id and state in ('ACTIVE','PAUSED')) then
 update public.customer_usage_grants g set state='ACTIVE',expires_at=s.grace_until from cluera_billing_private.terms x
 where x.subscription_id=s.subscription_id and x.period_end=s.paid_through and x.state in ('ACTIVE','ENDED') and g.id=x.grant_id;
 update cluera_billing_private.terms set state='ACTIVE',ends_at=s.grace_until where subscription_id=s.subscription_id and period_end=s.paid_through and state in ('ACTIVE','ENDED');
 end if;
 end if;
 end if;
 end if;
 if action_value<>'STATUS' then
 if paid.payment_id is null then
 if action_value='GRANT' then
 if r.kind='RECURRING' then
 perform cluera_billing_private.refresh(i.user_id,t);
 if ps<=t then
 -- An accepted renewal replaces the old cycle: no rollover, no double-active.
 perform public.customer_recurring_stop_grant(i.user_id,x.grant_id,least(t,x.ends_at)) from cluera_billing_private.terms x where x.subscription_id=i.subscription_id and x.state in ('ACTIVE','PAUSED');
 update public.customer_usage_grants g set state='REVOKED' from cluera_billing_private.terms x where x.subscription_id=i.subscription_id and x.state in ('ACTIVE','PAUSED') and g.id=x.grant_id;
 update cluera_billing_private.terms set state='ENDED' where subscription_id=i.subscription_id and state in ('ACTIVE','PAUSED');
 end if;
 end if;
 insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at,state)
 values(i.user_id,case when r.kind='PACK' then 'razorpay-test:'||(p_evidence->>'orderId') else 'razorpay-test-invoice:'||(p_evidence->>'invoiceId') end,
 r.kind,r.allowance_seconds::bigint*1000,coalesce(ps,t),pe,case when pe is not null and pe<=t then 'REVOKED'
 when r.kind='RECURRING' and (ps>t or p_evidence->>'subscriptionState'='PAUSED') then 'PAUSED' else 'ACTIVE' end) returning id into grant_value;
 end if;
 insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,grant_id,state,period_start,period_end,paid_at)
 values(p_evidence->>'paymentId',p_evidence->>'orderId',i.id,i.user_id,p_evidence->>'invoiceId',i.subscription_id,r.amount_paise,r.id,grant_value,
 case when action_value='REFUND' then 'REFUNDED' else 'VERIFIED' end,ps,pe,paid_at_value) returning * into paid;
 if r.kind='RECURRING' then
 insert into cluera_billing_private.terms values(paid.invoice_id,i.user_id,i.subscription_id,grant_value,
 case when action_value='REFUND' then 'REFUNDED' when pe<=t then 'ENDED' when ps>t then 'QUEUED' when p_evidence->>'subscriptionState'='PAUSED' then 'PAUSED' else 'ACTIVE' end,ps,pe,pe);
 update cluera_billing_private.subscriptions set paid_through=greatest(coalesce(paid_through,pe),pe),grace_until=null where subscription_id=i.subscription_id;
 end if;
 elsif action_value='REFUND' and paid.state<>'REFUNDED' then
 if paid.grant_id is not null then
 perform public.customer_recurring_stop_grant(i.user_id,paid.grant_id,t);
 if exists(select 1 from public.customer_usage_grants where id=paid.grant_id and reserved_ms<>0) then raise exception 'Refund settlement incomplete';end if;
 select granted_ms-spent_ms into removed from public.customer_usage_grants where id=paid.grant_id;
 update public.customer_usage_grants set state='REVOKED' where id=paid.grant_id;
 end if;
 update cluera_billing_private.payments set state='REFUNDED' where payment_id=paid.payment_id;
 update cluera_billing_private.terms set state='REFUNDED' where invoice_id=paid.invoice_id;
 update cluera_billing_private.subscriptions set grace_until=null where subscription_id=i.subscription_id;
 end if;
 state_value:=case when r.kind='PACK' and (paid.state='REFUNDED' or action_value='REFUND') then 'REFUNDED' else 'VERIFIED' end;
 update cluera_billing_private.intents set state=state_value where id=i.id;
 end if;
 perform cluera_billing_private.refresh(i.user_id,t);
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row,removed_ms)
 select e.event_id,i.id,action_value,p_evidence,before_value,jsonb_build_object('intent',to_jsonb(x),
 'entitlements',(select coalesce(jsonb_agg(jsonb_build_object('term',to_jsonb(y),'grant',to_jsonb(g)) order by y.period_start),'[]') from cluera_billing_private.terms y left join public.customer_usage_grants g on g.id=y.grant_id where y.subscription_id=i.subscription_id),
 'subscription',(select to_jsonb(y) from cluera_billing_private.subscriptions y where y.subscription_id=i.subscription_id),
 'payment',(select to_jsonb(y) from cluera_billing_private.payments y where y.payment_id=p_evidence->>'paymentId'),
 'term',(select to_jsonb(y) from cluera_billing_private.terms y where y.invoice_id=p_evidence->>'invoiceId'),
 'grant',(select to_jsonb(g) from public.customer_usage_grants g join cluera_billing_private.payments y on y.grant_id=g.id where y.payment_id=p_evidence->>'paymentId')),removed
 from cluera_billing_private.intents x where x.id=i.id;
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 return jsonb_build_object('code',case when action_value='STATUS' then 'APPLIED' else state_value end);
end$$;

create function cluera_billing_private.owns(p_digest text,p_owner text,p_epoch bigint default null) returns boolean
language plpgsql security invoker set search_path='' as $$declare r cluera_billing_private.processing_owner;begin
 select * into strict r from cluera_billing_private.processing_owner where singleton for share;
 return p_digest is not null and p_digest ~ '^[a-f0-9]{64}$' and r.owner=p_owner
 and (r.account_digest is null or r.account_digest=p_digest) and (p_epoch is null or r.epoch=p_epoch);
end$$;
create function public.cluera_billing_owner(p_account_digest text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare r cluera_billing_private.processing_owner;begin
 select * into strict r from cluera_billing_private.processing_owner where singleton;
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or (r.account_digest is not null and r.account_digest<>p_account_digest) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','ACTIVE','owner',r.owner,'epoch',r.epoch);
end$$;
create function public.cluera_billing_cutover(p_operation uuid,p_expected_owner text,p_expected_epoch bigint,p_owner text,p_account_digest text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare r cluera_billing_private.processing_owner;prior cluera_billing_private.cutover_audit;before_value jsonb;begin
 if p_operation is null or p_owner is null or p_owner not in ('account','cluera') or p_expected_owner is null or p_expected_epoch is null
 or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or p_reason is null or length(trim(p_reason)) not between 10 and 500 then return jsonb_build_object('code','INVALID');end if;
 select * into strict r from cluera_billing_private.processing_owner where singleton for update;
 select * into prior from cluera_billing_private.cutover_audit where operation_id=p_operation;
 if found then
 if prior.before_row->>'owner' is distinct from p_expected_owner or (prior.before_row->>'epoch')::bigint is distinct from p_expected_epoch
 or prior.after_row->>'owner' is distinct from p_owner or prior.after_row->>'account_digest' is distinct from p_account_digest or prior.reason is distinct from trim(p_reason)
 then return jsonb_build_object('code','CONFLICT');end if;return jsonb_build_object('code','APPLIED','epoch',(prior.after_row->>'epoch')::bigint);end if;
 if r.owner<>p_expected_owner or r.epoch<>p_expected_epoch or r.owner=p_owner or (r.account_digest is not null and r.account_digest<>p_account_digest)
 then return jsonb_build_object('code','CONFLICT');end if;
 if exists(select 1 from billing_private.payment_events where state='PENDING' and lease_until>clock_timestamp())
 or exists(select 1 from cluera_billing_private.events where state='PENDING' and lease_until>clock_timestamp())
 then return jsonb_build_object('code','DRAIN_REQUIRED');end if;
 if p_owner='cluera' and (exists(select 1 from public.customer_billing_jobs where state in ('READY','RUNNING'))
 or exists(select 1 from public.customer_billing_outbox where state in ('READY','RUNNING'))
 or exists(select 1 from public.customer_recurring_terms where state in ('ACTIVE','QUEUED','PAUSED'))
 -- cancel_future is a local request, not independently confirmed provider
 -- termination; even a failed/REVIEW cancellation may still renew.
 or exists(select 1 from public.customer_recurring_subscriptions where state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from public.customer_checkout_intents i where i.state in ('CREATING','UNCERTAIN')
 or (i.state='BOUND'
 and not exists(select 1 from public.customer_pack_purchases p where p.transaction_id=i.transaction_id and p.intent_id=i.id and p.user_id=i.user_id and p.state in ('ACTIVE','REFUNDED'))
 and not exists(select 1 from public.customer_recurring_terms t where t.transaction_id=i.transaction_id and t.user_id=i.user_id))))
 then return jsonb_build_object('code','PADDLE_DRAIN_REQUIRED');end if;
 -- Old Account bindings cannot resolve Cluera revisions or later refunds.
 -- Once any Cluera financial application exists, keep Cluera as owner and
 -- roll back only to another reviewed Cluera runtime, never to the old worker.
 if p_owner='account' and (exists(select 1 from cluera_billing_private.intents where state in ('CREATING','BOUND','UNCERTAIN'))
 or exists(select 1 from cluera_billing_private.events where state='PENDING')
 or exists(select 1 from cluera_billing_private.terms where state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.subscriptions where state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from cluera_billing_private.payments)
 or exists(select 1 from cluera_billing_private.applications))
 then return jsonb_build_object('code','CLUERA_DRAIN_REQUIRED');end if;
 if exists(select 1 from billing_private.payment_intents where account_digest<>p_account_digest)
 or exists(select 1 from cluera_billing_private.intents where account_digest<>p_account_digest) then return jsonb_build_object('code','CONFLICT');end if;
 before_value:=to_jsonb(r);
 update cluera_billing_private.processing_owner set owner=p_owner,epoch=epoch+1,account_digest=p_account_digest,changed_at=clock_timestamp() where singleton returning * into r;
 insert into cluera_billing_private.cutover_audit values(p_operation,trim(p_reason),before_value,to_jsonb(r),clock_timestamp());
 return jsonb_build_object('code','APPLIED','epoch',r.epoch);
end$$;

create function public.cluera_billing_catalog() returns jsonb language sql security definer set search_path='' set statement_timeout='5s' as $$
 select coalesce(jsonb_agg(jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,'currency',r.currency,
 'allowanceSeconds',r.allowance_seconds,'kind',r.kind,'interval',r.interval_name,'razorpayPlanId',r.razorpay_plan_id,'totalCount',r.total_count,
 'testPlanValidated',exists(select 1 from cluera_billing_private.plan_verifications v join cluera_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id),'enabled',h.enabled,'version',r.version)
 order by r.amount_paise),'[]') from cluera_billing_private.catalog_heads h join cluera_billing_private.catalog_revisions r on r.id=h.revision_id
$$;
create function public.cluera_billing_admin_read(p_actor uuid,p_session uuid,p_operation uuid default null) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$declare a cluera_billing_private.admin_audit;begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null then return jsonb_build_object('code','ACTIVE','catalog',public.cluera_billing_catalog());end if;
 select * into a from cluera_billing_private.admin_audit where operation_id=p_operation and actor_id=p_actor;
 return case when found then jsonb_build_object('code','APPLIED','revision',a.after_row) else jsonb_build_object('code','NOT_FOUND') end;
end$$;
create function public.cluera_billing_admin_mutate(p_actor uuid,p_session uuid,p_operation uuid,p_action text,p_offer text,p_expected_revision uuid,p_reauthenticated_at timestamptz,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare r cluera_billing_private.catalog_revisions;h cluera_billing_private.catalog_heads;a cluera_billing_private.admin_audit;before_value jsonb;after_value jsonb;begin
 if public.account_admin_check(p_actor,p_session,true) is not true or p_reauthenticated_at is null or not isfinite(p_reauthenticated_at)
 or p_reauthenticated_at<clock_timestamp()-interval '2 minutes' or p_reauthenticated_at>clock_timestamp()+interval '5 seconds' then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null or p_action is null or p_action not in ('CREATE_REVISION','SET_ENABLED') or p_expected_revision is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 or jsonb_typeof(p_input) is distinct from 'object' then return jsonb_build_object('code','INVALID');end if;
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation::text,862117));
 select * into a from cluera_billing_private.admin_audit where operation_id=p_operation;
 if found then
 if a.actor_id<>p_actor or a.session_id<>p_session or a.action<>p_action or a.reason is distinct from trim(p_reason) or a.input is distinct from jsonb_build_object('offer',p_offer,'expectedRevision',p_expected_revision,'input',p_input)
 then return jsonb_build_object('code','CONFLICT');end if;return jsonb_build_object('code','APPLIED','revision',a.after_row);end if;
 select * into h from cluera_billing_private.catalog_heads where offer_code=p_offer for update;
 if not found or h.revision_id<>p_expected_revision then return jsonb_build_object('code','CONFLICT');end if;
 select * into strict r from cluera_billing_private.catalog_revisions where id=h.revision_id;
 before_value:=to_jsonb(r)||jsonb_build_object('enabled',h.enabled);
 if p_action='CREATE_REVISION' then
 if (p_input-array['name','amountPaise','allowanceSeconds','razorpayPlanId','totalCount'])<>'{}'::jsonb
 or jsonb_typeof(p_input->'name') is distinct from 'string' or length(trim(p_input->>'name')) not between 2 and 80
 or coalesce(p_input->>'amountPaise','') !~ '^[0-9]{3,8}$' or coalesce(p_input->>'allowanceSeconds','') !~ '^[0-9]{2,7}$'
 or (p_input->>'amountPaise')::integer not between 100 and 10000000 or (p_input->>'allowanceSeconds')::integer not between 60 and 3600000
 or (r.kind='PACK' and p_input->>'razorpayPlanId' is not null)
 or (r.kind='PACK' and p_input->>'totalCount' is not null)
 or (r.kind='RECURRING' and (coalesce(p_input->>'totalCount','') !~ '^[0-9]{1,3}$' or (p_input->>'totalCount')::integer not between 1 and 120))
 or (r.kind='RECURRING' and p_input->>'razorpayPlanId' is not null and p_input->>'razorpayPlanId' !~ '^plan_[A-Za-z0-9]{8,64}$') then return jsonb_build_object('code','INVALID');end if;
 insert into cluera_billing_private.catalog_revisions(offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,razorpay_plan_id,total_count)
 values(r.offer_code,r.version+1,trim(p_input->>'name'),(p_input->>'amountPaise')::integer,(p_input->>'allowanceSeconds')::integer,r.kind,r.interval_name,p_input->>'razorpayPlanId',(p_input->>'totalCount')::integer) returning * into r;
 update cluera_billing_private.catalog_heads set revision_id=r.id,enabled=false where offer_code=p_offer;
 else
 if (p_input-array['enabled'])<>'{}'::jsonb or jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then return jsonb_build_object('code','INVALID');end if;
 if (p_input->>'enabled')::boolean and r.kind='RECURRING' and not exists(select 1 from cluera_billing_private.plan_verifications v
 join cluera_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id and r.razorpay_plan_id is not null)
 then return jsonb_build_object('code','PLAN_UNVERIFIED');end if;
 update cluera_billing_private.catalog_heads set enabled=(p_input->>'enabled')::boolean where offer_code=p_offer;
 end if;
 if public.account_admin_check(p_actor,p_session,true) is not true then raise exception 'Admin session changed';end if;
 select value into after_value from jsonb_array_elements(public.cluera_billing_catalog()) where value->>'revisionId'=r.id::text;
 insert into cluera_billing_private.admin_audit(operation_id,actor_id,session_id,action,reason,input,before_row,after_row)
 values(p_operation,p_actor,p_session,p_action,trim(p_reason),jsonb_build_object('offer',p_offer,'expectedRevision',p_expected_revision,'input',p_input),before_value,after_value);
 return jsonb_build_object('code','APPLIED','revision',after_value);
end$$;
create function public.cluera_billing_plan_verify(p_revision uuid,p_account_digest text,p_evidence jsonb) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare r cluera_billing_private.catalog_revisions;observed timestamptz;begin
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_evidence) is distinct from 'object'
 or (p_evidence-array['planId','period','interval','amountPaise','currency','observedAt'])<>'{}'::jsonb then return 'INVALID';end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;exception when others then return 'INVALID';end;
 if observed is null or not isfinite(observed) or observed<clock_timestamp()-interval '2 minutes' or observed>clock_timestamp()+interval '5 seconds' then return 'INVALID';end if;
 select * into r from cluera_billing_private.catalog_revisions where id=p_revision;
 if not found or r.kind<>'RECURRING' or r.razorpay_plan_id is null or p_evidence->>'planId' is distinct from r.razorpay_plan_id
 or p_evidence->>'period' is distinct from 'monthly' or p_evidence->>'interval' is distinct from '1'
 or p_evidence->>'amountPaise' is distinct from r.amount_paise::text or p_evidence->>'currency' is distinct from 'INR' then return 'INVALID';end if;
 insert into cluera_billing_private.plan_verifications values(r.id,p_account_digest,p_evidence,observed) on conflict do nothing;
 return 'VERIFIED';
end$$;

create function public.cluera_billing_status(p_user uuid,p_session uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare a jsonb;pending jsonb;resolved jsonb;subscriptions jsonb;begin
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select jsonb_build_object('intentId',i.id,'state',i.state,'kind',r.kind,'revisionId',r.id,'offerCode',r.offer_code,'orderId',i.order_id,'subscriptionId',i.subscription_id,'legacy',false) into pending
 from cluera_billing_private.intents i join cluera_billing_private.catalog_revisions r on r.id=i.revision_id where i.user_id=p_user and i.state in ('CREATING','BOUND','UNCERTAIN') limit 1;
 if pending is null then select jsonb_build_object('intentId',id,'state',state,'kind','PACK','revisionId',null,'offerCode',offer_code,'orderId',order_id,'subscriptionId',null,'legacy',true) into pending
 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN') limit 1;end if;
 select coalesce(jsonb_agg(resource order by created desc),'[]') into resolved from(select resource,max(created_at) created from(
 select order_id resource,created_at from cluera_billing_private.intents where user_id=p_user and state in ('VERIFIED','REFUNDED') and order_id is not null
 union all select order_id,created_at from billing_private.payment_intents where user_id=p_user and state in ('VERIFIED','REFUNDED') and order_id is not null) x
 group by resource order by created desc limit 50) q;
 select coalesce(jsonb_agg(subscription_id order by created_at desc),'[]') into subscriptions from(
 select subscription_id,created_at from cluera_billing_private.intents where user_id=p_user and state in ('VERIFIED','REFUNDED') and subscription_id is not null order by created_at desc limit 50) q;
 return jsonb_build_object('code',case when pending is null then 'AVAILABLE' else 'PENDING' end,'userId',p_user,'pending',pending,'resolvedOrderIds',resolved,'resolvedSubscriptionIds',subscriptions);
end$$;
create function public.cluera_billing_prepare(p_user uuid,p_session uuid,p_request uuid,p_revision uuid,p_account_digest text,p_epoch bigint) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;rev jsonb;begin
 if p_epoch is null or p_request is null or p_revision is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select * into i from cluera_billing_private.intents where user_id=p_user and request_id=p_request;
 if found then
 if i.revision_id<>p_revision or i.account_digest<>p_account_digest then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code',i.state,'intentId',i.id,'orderId',i.order_id,'subscriptionId',i.subscription_id);end if;
 -- Fence concurrent Admin revision/disable while taking the immutable checkout
 -- snapshot; no network request occurs under this short shared-head lock.
 perform 1 from cluera_billing_private.catalog_heads where revision_id=p_revision and enabled for share;
 if not found then return jsonb_build_object('code','DISABLED');end if;
 select * into strict r from cluera_billing_private.catalog_revisions where id=p_revision;
 if exists(select 1 from cluera_billing_private.intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN'))
 or exists(select 1 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN')) then return jsonb_build_object('code','PENDING');end if;
 if r.kind='RECURRING' and (exists(select 1 from public.customer_recurring_terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED'))
 or exists(select 1 from cluera_billing_private.subscriptions where user_id=p_user and not cancel_future and state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED') and ends_at>clock_timestamp())) then return jsonb_build_object('code','COMPETING_SUBSCRIPTION');end if;
 if r.kind='RECURRING' and not exists(select 1 from cluera_billing_private.plan_verifications where revision_id=r.id and account_digest=p_account_digest) then return jsonb_build_object('code','PLAN_UNVERIFIED');end if;
 if (select count(*) from cluera_billing_private.intents where user_id=p_user and created_at>clock_timestamp()-interval '1 hour')>=5 then return jsonb_build_object('code','RATE_LIMITED');end if;
 insert into cluera_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state) values(p_user,p_request,r.id,p_account_digest,p_epoch,'CREATING') returning * into i;
 select value into rev from jsonb_array_elements(public.cluera_billing_catalog()) where value->>'revisionId'=r.id::text;
 return jsonb_build_object('code','CLAIMED','intentId',i.id,'attemptId',i.attempt_id,'revision',rev);
end$$;
create function public.cluera_billing_bind(p_intent uuid,p_attempt uuid,p_account_digest text,p_epoch bigint,p_resource jsonb) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return 'UNAVAILABLE';end if;
 select * into i from cluera_billing_private.intents where id=p_intent;if not found then return 'UNBOUND';end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into strict i from cluera_billing_private.intents where id=i.id for update;
 if i.attempt_id is distinct from p_attempt or i.account_digest is distinct from p_account_digest or i.epoch<>p_epoch then return 'CONFLICT';end if;
 if i.state<>'CREATING' then return i.state;end if;
 if p_resource is null then update cluera_billing_private.intents set state='UNCERTAIN' where id=i.id;return 'UNCERTAIN';end if;
 select * into strict r from cluera_billing_private.catalog_revisions where id=i.revision_id;
 if jsonb_typeof(p_resource) is distinct from 'object' or (p_resource-array['orderId','subscriptionId'])<>'{}'::jsonb
 or (r.kind='PACK' and (p_resource->>'orderId' is null or p_resource->>'orderId' !~ '^order_[A-Za-z0-9]{8,64}$' or p_resource->>'subscriptionId' is not null))
 or (r.kind='RECURRING' and (p_resource->>'subscriptionId' is null or p_resource->>'subscriptionId' !~ '^sub_[A-Za-z0-9]{8,64}$' or p_resource->>'orderId' is not null))
 or exists(select 1 from billing_private.payment_intents where order_id=p_resource->>'orderId') then return 'INVALID';end if;
 update cluera_billing_private.intents set state='BOUND',order_id=p_resource->>'orderId',subscription_id=p_resource->>'subscriptionId' where id=i.id;return 'BOUND';
end$$;
create function public.cluera_billing_binding(p_resource text,p_account_digest text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$declare i cluera_billing_private.intents;rev jsonb;begin
 select * into i from cluera_billing_private.intents where account_digest=p_account_digest and (order_id=p_resource or subscription_id=p_resource);
 if not found then return public.account_payment_binding(p_resource,p_account_digest)||jsonb_build_object('legacy',true);end if;
 select jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,'currency',r.currency,'allowanceSeconds',r.allowance_seconds,
 'kind',r.kind,'interval',r.interval_name,'razorpayPlanId',r.razorpay_plan_id,'totalCount',r.total_count,'version',r.version,
 'enabled',exists(select 1 from cluera_billing_private.catalog_heads h where h.revision_id=r.id and h.enabled),
 'testPlanValidated',exists(select 1 from cluera_billing_private.plan_verifications v where v.revision_id=r.id and v.account_digest=p_account_digest))
 into rev from cluera_billing_private.catalog_revisions r where id=i.revision_id;
 return jsonb_build_object('code',i.state,'legacy',false,'intentId',i.id,'userId',i.user_id,'orderId',i.order_id,'subscriptionId',i.subscription_id,'revision',rev);
end$$;

-- Legacy compatibility stays durable. These wrappers change authority only
-- after the approved owner CAS; original audited code and data stay in place.
alter function public.account_payment_claim(text) rename to account_payment_claim_account_base;
alter function public.account_payment_apply(text,uuid,text,text,jsonb) rename to account_payment_apply_account_base;
alter function public.account_payment_prepare(uuid,uuid,uuid,text) rename to account_payment_prepare_account_base;
revoke all on function public.account_payment_claim_account_base(text),public.account_payment_apply_account_base(text,uuid,text,text,jsonb),
 public.account_payment_prepare_account_base(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.account_payment_claim(p_account_digest text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if cluera_billing_private.owns(p_account_digest,'account') is not true then return jsonb_build_object('code','EMPTY');end if;
 return public.account_payment_claim_account_base(p_account_digest);
end$$;
create function public.account_payment_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if cluera_billing_private.owns(p_account_digest,'account') is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 return public.account_payment_apply_account_base(p_event,p_claim,p_digest,p_account_digest,p_evidence);
end$$;
create function public.account_payment_prepare(p_user uuid,p_session uuid,p_request uuid,p_account_digest text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if cluera_billing_private.owns(p_account_digest,'account') is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 return public.account_payment_prepare_account_base(p_user,p_session,p_request,p_account_digest);
end$$;
create function public.cluera_billing_legacy_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e cluera_billing_private.events;o billing_private.payment_events;i billing_private.payment_intents;result jsonb;received text;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 begin select * into i from billing_private.payment_intents where id=(p_evidence->>'intentId')::uuid and provider='razorpay' and environment='test';
 exception when others then return jsonb_build_object('code','INVALID');end;
 if i.id is null or i.order_id is distinct from p_evidence->>'orderId' or i.account_digest is distinct from p_account_digest then return jsonb_build_object('code','UNBOUND');end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into e from cluera_billing_private.events where event_id=p_event for update;
 if found then
 if e.account_digest<>p_account_digest or e.digest is distinct from p_digest or e.event_type not in ('payment.captured','order.paid','refund.processed')
 or e.payment_id is distinct from p_evidence->>'paymentId' or (e.order_id is not null and e.order_id is distinct from i.order_id)
 or e.subscription_id is not null or e.invoice_id is not null or e.state='QUARANTINED' then return jsonb_build_object('code','CONFLICT');end if;
 select * into o from billing_private.payment_events where event_id=p_event and provider='razorpay' and environment='test' for update;
 if not found then
 if e.state<>'PENDING' or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=clock_timestamp() then return jsonb_build_object('code','CONFLICT');end if;
 -- A raw refund has no order ID. Only fresh independent provider evidence may
 -- discover its OLD immutable binding. Transfer its already signed safe receipt
 -- into that same original inbox; do not synthesize or replay a provider event.
 received:=public.account_payment_receive(jsonb_build_object('eventId',e.event_id,'eventType',e.event_type,'resourceId',e.resource_id,
 'paymentId',e.payment_id,'orderId',e.order_id,'digest',e.digest,'occurredAt',e.occurred_at),p_account_digest);
 if received not in ('STORED','DUPLICATE') then return jsonb_build_object('code','CONFLICT');end if;
 update billing_private.payment_events set claim_id=p_claim,lease_until=e.lease_until,attempts=greatest(attempts,e.attempts)
 where provider='razorpay' and environment='test' and event_id=e.event_id and state='PENDING';
 elsif o.digest<>e.digest or o.account_digest<>e.account_digest or o.event_type<>e.event_type or o.resource_id<>e.resource_id
 or o.payment_id<>e.payment_id or o.order_id is distinct from e.order_id or o.occurred_at<>e.occurred_at then return jsonb_build_object('code','CONFLICT');
 elsif o.state='PROCESSED' and exists(select 1 from billing_private.payment_applications where event_id=p_event and intent_id=i.id) then
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=e.event_id;
 return jsonb_build_object('code',i.state);
 end if;
 end if;
 result:=public.account_payment_apply_account_base(p_event,p_claim,p_digest,p_account_digest,p_evidence);
 if result->>'code' in ('VERIFIED','REFUNDED') then update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=p_event;end if;
 return result;
end$$;

-- Old Paddle history/REVIEW jobs are untouched. No ready/running work or paid
-- term is permitted at the CAS boundary, and no new claim can race after it.
alter function public.customer_billing_claim(text) rename to customer_billing_claim_pre_cluera;
alter function public.customer_billing_action_claim() rename to customer_billing_action_claim_pre_cluera;
revoke all on function public.customer_billing_claim_pre_cluera(text),public.customer_billing_action_claim_pre_cluera() from public,anon,authenticated,service_role;
create function public.customer_billing_claim(p_event_id text default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare o text;begin
 select owner into strict o from cluera_billing_private.processing_owner where singleton for share;
 if o<>'account' then return jsonb_build_object('code','EMPTY');end if;
 return public.customer_billing_claim_pre_cluera(p_event_id);
end$$;
create function public.customer_billing_action_claim() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare o text;begin
 select owner into strict o from cluera_billing_private.processing_owner where singleton for share;
 if o<>'account' then return jsonb_build_object('code','EMPTY');end if;
 return public.customer_billing_action_claim_pre_cluera();
end$$;

-- Account-before-grant lock ordering and the shipped usage DTO remain intact.
alter function public.customer_usage_command(uuid,uuid,uuid,integer,text) rename to customer_usage_command_pre_cluera;
alter function public.customer_usage_balance(uuid,uuid) rename to customer_usage_balance_pre_cluera;
revoke all on function public.customer_usage_command_pre_cluera(uuid,uuid,uuid,integer,text),public.customer_usage_balance_pre_cluera(uuid,uuid) from public,anon,authenticated,service_role;
create function public.customer_usage_command(p_user_id uuid,p_session_id uuid,p_run_id uuid,p_sequence integer,p_action text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare a jsonb;begin
 a:=public.customer_authorize(p_user_id,p_session_id);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user_id for update;
 perform cluera_billing_private.refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
 return public.customer_usage_command_pre_cluera(p_user_id,p_session_id,p_run_id,p_sequence,p_action);
end$$;
create function public.customer_usage_balance(p_user_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare a jsonb;begin
 a:=public.customer_authorize(p_user_id,p_session_id);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user_id for update;
 perform cluera_billing_private.refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
 return public.customer_usage_balance_pre_cluera(p_user_id,p_session_id);
end$$;
-- Do not append new offer enums to old Account customers' strict report. Cluera
-- has a separate reader with identical field names and additive allowed enums.
create function public.cluera_credits_read(p_user uuid,p_session uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$declare base jsonb;history jsonb;plans jsonb;a jsonb;begin
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 perform cluera_billing_private.refresh(p_user,date_trunc('milliseconds',clock_timestamp()));
 base:=public.customer_credits_read(p_user,p_session);if base->>'userId' is distinct from p_user::text then return base;end if;
 select coalesce(jsonb_agg(value order by created desc),'[]') into history from(
 select value,(value->>'createdAt')::timestamptz created from jsonb_array_elements(base->'payments')
 union all select jsonb_build_object('offerCode',r.offer_code,'state',i.state,'createdAt',i.created_at),i.created_at
 from cluera_billing_private.intents i join cluera_billing_private.catalog_revisions r on r.id=i.revision_id where i.user_id=p_user
 order by created desc limit 10) q;
 select coalesce(jsonb_agg(value order by sort_at desc),'[]') into plans from(
 select value,coalesce((value->>'endsAt')::timestamptz,'-infinity'::timestamptz) sort_at from jsonb_array_elements(base->'plans')
 union all select jsonb_build_object('tier',case when r.offer_code in ('cluera_monthly_40h_v2','cluera_monthly_100h_v2') then 'PRO' else 'ENTERPRISE' end,'state',t.state,'paymentState',s.state,
 'endsAt',t.ends_at,'cancelFuture',s.cancel_future),t.period_start from cluera_billing_private.terms t join cluera_billing_private.subscriptions s using(subscription_id)
 join cluera_billing_private.catalog_revisions r on r.id=s.revision_id where t.user_id=p_user order by sort_at desc limit 30) q;
 return jsonb_set(jsonb_set(base,'{payments}',history),'{plans}',plans);
end$$;

-- Explicit only-this-proposal privilege boundary; never blanket-revoke old APIs.
revoke all on all functions in schema cluera_billing_private from public,anon,authenticated,service_role;
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like 'cluera_billing_%' or p.proname='cluera_credits_read'
 or p.proname in ('account_payment_claim','account_payment_apply','account_payment_prepare','customer_usage_command','customer_usage_balance','customer_billing_claim','customer_billing_action_claim')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
