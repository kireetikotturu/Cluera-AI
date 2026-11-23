-- Cluera Live: let a customer cancel their own UNPAID checkout so they can buy again.
--
-- Before: any CREATING/BOUND/UNCERTAIN Live intent blocked every new purchase forever,
-- with no exit unless Razorpay delivered a paid webhook.
-- After:
--   * public.cluera_live_billing_intent_cancel() moves an unpaid intent to 'REJECTED'
--     (a state the website and installed Windows app already understand) and writes an
--     immutable audit row. The server calls it only after Razorpay itself reports the
--     order has no captured/authorized payment.
--   * A late genuine payment on a cancelled order is still credited: apply accepts a
--     REJECTED pack intent exactly like BOUND, and the intent becomes VERIFIED.
--     Grants stay keyed by order id, so a customer can never receive more than they paid.
-- Nothing else changes: no payment, grant, event or catalog row is touched.

begin;
set local lock_timeout='5s';

-- 1. Allow the exit state on Live intents.
do $$declare c text;begin
 select conname into strict c from pg_constraint
 where conrelid='cluera_live_billing_private.intents'::regclass and contype='c'
 and pg_get_constraintdef(oid) like '%CREATING%' and pg_get_constraintdef(oid) like '%VERIFIED%'
 and pg_get_constraintdef(oid) not like '%REJECTED%';
 execute format('alter table cluera_live_billing_private.intents drop constraint %I',c);
end$$;
alter table cluera_live_billing_private.intents add constraint intents_state_check
 check(state in('CREATING','BOUND','UNCERTAIN','VERIFIED','REFUNDED','REJECTED'));

-- 2. A late signed payment for a cancelled pack order is still applied (and credited).
do $$declare d text;n int;begin
 d:=pg_get_functiondef('public.cluera_live_billing_apply_pre_native(text,uuid,text,text,bigint,jsonb)'::regprocedure);
 n:=(length(d)-length(replace(d,'i.state not in (''BOUND'',''VERIFIED'',''REFUNDED'')','')))
   /length('i.state not in (''BOUND'',''VERIFIED'',''REFUNDED'')');
 if n<>1 then raise exception 'apply guard not found exactly once (found %)',n;end if;
 d:=replace(d,'i.state not in (''BOUND'',''VERIFIED'',''REFUNDED'')',
  'i.state not in (''BOUND'',''VERIFIED'',''REFUNDED'') and not (i.state=''REJECTED'' and r.kind=''PACK'')');
 execute d;
end$$;

-- 3. Immutable audit of every customer cancellation.
create table cluera_live_billing_private.intent_cancellations(
 intent_id uuid primary key references cluera_live_billing_private.intents(id),
 user_id uuid not null,
 before_state text not null check(before_state in('CREATING','BOUND','UNCERTAIN')),
 order_id text,
 evidence jsonb not null,
 created_at timestamptz not null default clock_timestamp());
revoke all on cluera_live_billing_private.intent_cancellations from public,anon,authenticated,service_role;
create trigger immutable before update or delete or truncate on cluera_live_billing_private.intent_cancellations
 for each statement execute function cluera_live_billing_private.immutable();
alter table cluera_live_billing_private.intent_cancellations enable always trigger immutable;

-- 4. Customer cancellation of their own unpaid checkout.
-- p_evidence (BOUND only) is the server's fresh Razorpay read of the exact order:
--   {"orderId":"order_…","orderStatus":"created"|"attempted","amountPaidPaise":0,"openPayments":0}
-- CREATING/UNCERTAIN never reached a known order; they may be cancelled after 10 minutes.
create function public.cluera_live_billing_intent_cancel(p_user uuid,p_session uuid,p_intent uuid,
 p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s'
as $$declare a jsonb;i cluera_live_billing_private.intents;begin
 if p_epoch is null or p_intent is null or cluera_live_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true
 then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 select * into i from cluera_live_billing_private.intents where id=p_intent and user_id=p_user for update;
 if not found then return jsonb_build_object('code','NOT_FOUND');end if;
 if i.state not in('CREATING','BOUND','UNCERTAIN') then return jsonb_build_object('code',i.state);end if;
 if i.state in('CREATING','UNCERTAIN') and i.created_at>clock_timestamp()-interval '10 minutes'
 then return jsonb_build_object('code','TOO_SOON');end if;
 if i.state='BOUND' and (jsonb_typeof(p_evidence) is distinct from 'object'
  or (p_evidence-array['orderId','orderStatus','amountPaidPaise','openPayments'])<>'{}'::jsonb
  or p_evidence->>'orderId' is distinct from i.order_id
  or p_evidence->>'orderStatus' not in('created','attempted')
  or p_evidence->>'amountPaidPaise' is distinct from '0' or p_evidence->>'openPayments' is distinct from '0')
 then return jsonb_build_object('code','PAYMENT_IN_PROGRESS');end if;
 if exists(select 1 from cluera_live_billing_private.payments where intent_id=i.id or (i.order_id is not null and order_id=i.order_id))
 or (i.order_id is not null and exists(select 1 from cluera_live_billing_private.events where order_id=i.order_id))
 then return jsonb_build_object('code','PAYMENT_IN_PROGRESS');end if;
 update cluera_live_billing_private.intents set state='REJECTED' where id=i.id;
 insert into cluera_live_billing_private.intent_cancellations(intent_id,user_id,before_state,order_id,evidence)
 values(i.id,i.user_id,i.state,i.order_id,coalesce(p_evidence,'{}'::jsonb));
 return jsonb_build_object('code','CANCELLED','intentId',i.id);
end$$;
revoke all on function public.cluera_live_billing_intent_cancel(uuid,uuid,uuid,text,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.cluera_live_billing_intent_cancel(uuid,uuid,uuid,text,bigint,jsonb) to service_role;

commit;
