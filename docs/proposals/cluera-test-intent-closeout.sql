-- REVIEW PROPOSAL ONLY. NOT APPLIED. Do not run until the owner approves it.
--
-- PURPOSE (plain English)
--   Two TEST (no real money) checkouts are stuck in state BOUND in the Test ledger:
--     intent f103baee-119c-49f9-b218-ee8e2fcc3a60   Razorpay Test order order_TpRplT79SeFnTp
--     intent 4952c441-894e-4055-801d-3c8a702bc4e4   Razorpay Test order order_Trd46ZnYqCmuLp
--   The Live "promote" SQL refuses to run while ANY Test intent is CREATING, BOUND or UNCERTAIN
--   ("Acceptance or Test reconciliation incomplete"). The system has no built-in way to close a
--   BOUND intent that was never paid: the only existing exits are VERIFIED / REFUNDED, and both
--   require a genuinely paid, signed Razorpay event. This proposal adds the missing, audited exit.
--
-- WHAT IT CHANGES (and nothing else)
--   1. Widens the CHECK on cluera_billing_private.intents.state to also allow 'REJECTED'.
--      'REJECTED' is a value the website and the installed Windows app already understand
--      (their schemas list it), so no app update is needed.
--   2. Sets state = 'REJECTED' on exactly the two intents above, and only if every safety check passes.
--   3. Writes two immutable rows to cluera_billing_private.cutover_audit (one per intent) holding
--      the full before and after row and the reason. That table cannot be updated or deleted.
--
-- WHAT IT NEVER TOUCHES
--   No payment, grant, application, event, subscription, balance, catalog or Live-ledger row.
--   No other intent. If anything unexpected is found the whole transaction stops and changes nothing.
--
-- WHICH INTENT STATES THE PROMOTE CHECK ACCEPTS
--   The promote SQL (scripts/payments/razorpay-go-live.cjs --phase promote) fails only when
--   cluera_billing_private.intents contains state IN ('CREATING','BOUND','UNCERTAIN'), or an events row
--   is still 'PENDING'. Every other state passes: VERIFIED, REFUNDED and (after this change) REJECTED.
--   The promote SQL itself is NOT modified.
--
-- BEFORE YOU RUN IT (owner, in the Razorpay dashboard, Test mode)
--   Open each order id above. Confirm it has no captured payment. (If an order WAS paid, do not use
--   this proposal; the normal signed webhook will turn it VERIFIED by itself.)
--
-- ROLLBACK
--   The audit rows are permanent by design. To put the two intents back to BOUND (only if they still
--   have no payment) run the commented block at the bottom; it writes two more audit rows.

begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(862117,20261102);

do $$
declare
 intent_ids uuid[]:=array['f103baee-119c-49f9-b218-ee8e2fcc3a60','4952c441-894e-4055-801d-3c8a702bc4e4']::uuid[];
 order_ids text[]:=array['order_TpRplT79SeFnTp','order_Trd46ZnYqCmuLp'];
 operation_ids uuid[]:=array['6e550de3-9cf3-4127-bbdd-0eed0d707047','388f2053-2a12-437a-a6f3-e8687cbf3ac8']::uuid[];
 i cluera_billing_private.intents;
 kind_value text;
 before_value jsonb;
 constraint_name text;
 n integer;
begin
 -- Same lock order as the checkout functions: account row first, then the intent row.
 perform 1 from cluera_billing_private.processing_owner where singleton for share;
 for n in 1..2 loop
  select * into i from cluera_billing_private.intents where id=intent_ids[n];
  if not found then raise exception 'Intent % not found; stop and review',intent_ids[n];end if;
  perform 1 from public.customer_accounts where user_id=i.user_id for update;
  select * into strict i from cluera_billing_private.intents where id=intent_ids[n] for update;
  select r.kind into strict kind_value from cluera_billing_private.catalog_revisions r where r.id=i.revision_id;
  if i.state<>'BOUND' or i.order_id is distinct from order_ids[n] or i.subscription_id is not null or kind_value<>'PACK'
  then raise exception 'Intent % is not the expected BOUND pack order; stop and review',intent_ids[n];end if;
  if exists(select 1 from cluera_billing_private.payments where intent_id=i.id or order_id=i.order_id)
  or exists(select 1 from cluera_billing_private.applications where intent_id=i.id)
  or exists(select 1 from cluera_billing_private.events where order_id=i.order_id)
  or exists(select 1 from cluera_billing_private.subscriptions where intent_id=i.id)
  then raise exception 'Intent % already has payment evidence; stop and review',intent_ids[n];end if;
 end loop;
 if exists(select 1 from cluera_billing_private.events where state='PENDING')
 then raise exception 'A receipt is still pending; let the worker finish first';end if;

 -- 1. Allow the exit state. The constraint is found by its content, never guessed by name.
 select conname into strict constraint_name from pg_constraint
 where conrelid='cluera_billing_private.intents'::regclass and contype='c'
 and pg_get_constraintdef(oid) like '%CREATING%' and pg_get_constraintdef(oid) like '%VERIFIED%' and pg_get_constraintdef(oid) not like '%REJECTED%';
 execute format('alter table cluera_billing_private.intents drop constraint %I',constraint_name);
 alter table cluera_billing_private.intents add constraint intents_state_check
  check(state in('CREATING','BOUND','UNCERTAIN','VERIFIED','REFUNDED','REJECTED'));

 -- 2. Close exactly the two reviewed intents and 3. leave the immutable audit.
 for n in 1..2 loop
  select to_jsonb(x) into strict before_value from cluera_billing_private.intents x where x.id=intent_ids[n];
  update cluera_billing_private.intents set state='REJECTED' where id=intent_ids[n] and state='BOUND';
  if not found then raise exception 'Intent % changed while closing; stop and review',intent_ids[n];end if;
  insert into cluera_billing_private.cutover_audit(operation_id,reason,before_row,after_row)
  select operation_ids[n],
   'Owner-approved close-out of an unpaid Test checkout (order '||order_ids[n]||') so the Live promote check can pass',
   before_value||jsonb_build_object('kind','TEST_INTENT_CLOSEOUT'),
   to_jsonb(x)||jsonb_build_object('kind','TEST_INTENT_CLOSEOUT')
  from cluera_billing_private.intents x where x.id=intent_ids[n];
 end loop;

 -- The promote check must now be satisfied; otherwise something else is still unresolved and
 -- nothing should be left half-done.
 if exists(select 1 from cluera_billing_private.intents where state in('CREATING','BOUND','UNCERTAIN'))
 then raise exception 'Other unresolved Test intents remain; stop and review';end if;
end$$;
commit;

-- AFTER YOU RUN IT (read-only check; expect 0 rows from the first query and 2 from the second)
--   select id,state,order_id from cluera_billing_private.intents where state in ('CREATING','BOUND','UNCERTAIN');
--   select operation_id,created_at,reason from cluera_billing_private.cutover_audit where before_row->>'kind'='TEST_INTENT_CLOSEOUT';

-- ROLLBACK (review only; separate transaction)
-- begin;
-- set local lock_timeout='2s';
-- select pg_advisory_xact_lock(862117,20261102);
-- do $$declare ids uuid[]:=array['f103baee-119c-49f9-b218-ee8e2fcc3a60','4952c441-894e-4055-801d-3c8a702bc4e4']::uuid[];n integer;i cluera_billing_private.intents;b jsonb;
-- begin for n in 1..2 loop
--  select * into strict i from cluera_billing_private.intents where id=ids[n] for update;
--  if i.state<>'REJECTED' or exists(select 1 from cluera_billing_private.payments where intent_id=i.id) then raise exception 'Cannot roll back intent %',ids[n];end if;
--  b:=to_jsonb(i);update cluera_billing_private.intents set state='BOUND' where id=i.id;
--  insert into cluera_billing_private.cutover_audit(operation_id,reason,before_row,after_row)
--   select gen_random_uuid(),'Rollback of the Test intent close-out for order '||i.order_id,b||jsonb_build_object('kind','TEST_INTENT_REOPEN'),to_jsonb(x)||jsonb_build_object('kind','TEST_INTENT_REOPEN')
--   from cluera_billing_private.intents x where x.id=i.id;
-- end loop;end$$;
-- commit;
