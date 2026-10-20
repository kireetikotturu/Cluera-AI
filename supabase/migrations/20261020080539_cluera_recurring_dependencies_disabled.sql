begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(862117,20261020);
do $$begin
 if to_regclass('cluera_billing_private.native_config') is not null
 or to_regclass('cluera_billing_private.cancellation_commands') is not null
 or to_regprocedure('public.cluera_billing_history(uuid,uuid)') is null
 then raise exception 'Recurring installation precondition requires review';end if;
end$$;
create temporary table cluera_install_preserved_rows(schema_name text,table_name text,row_count bigint,digest text) on commit drop;
do $$declare r record;n bigint;h text;begin
 for r in select n.nspname schema_name,c.relname table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in('public','billing_private','cluera_billing_private') and c.relkind='r' loop
 execute format('select count(*),md5(coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),''''))from %I.%I t',
 r.schema_name,r.table_name)into n,h;
 insert into cluera_install_preserved_rows values(r.schema_name,r.table_name,n,h);
 end loop;
end$$;
create temporary table cluera_install_preserved_functions on commit drop as
 select n.nspname schema_name,p.proname,pg_get_function_identity_arguments(p.oid) args,p.prosrc,p.proconfig,
 p.prosecdef,p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('public','billing_private','cluera_billing_private');
-- UNAPPLIED additive proposal. Review and schema acceptance are required before
-- CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED may be enabled. No provider call,
-- entitlement mutation, scheduler, existing row rewrite or activation occurs.
-- The web service alone may claim one Test cancel-at-cycle-end POST. An unknown
-- response is never retried; a later same-owner GET can prove terminal state.


create table cluera_billing_private.cancellation_commands (
 operation_id uuid primary key,user_id uuid not null references public.customer_accounts(user_id),
 subscription_id text not null,account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),epoch bigint not null check(epoch>0),
 claim_id uuid not null unique default gen_random_uuid(),state text not null check(state in ('CLAIMED','UNCERTAIN','ACCEPTED','CONFIRMED')),
 created_at timestamptz not null default clock_timestamp(),lease_until timestamptz not null default clock_timestamp()+interval '90 seconds',
 observed_at timestamptz,provider_state text check(provider_state in ('active','pending','halted','paused','cancelled','completed','expired')),
 before_row jsonb not null,unique(subscription_id),foreign key(user_id,subscription_id) references cluera_billing_private.subscriptions(user_id,subscription_id)
);
create table cluera_billing_private.cancellation_audit (
 id uuid primary key default gen_random_uuid(),operation_id uuid not null references cluera_billing_private.cancellation_commands(operation_id),
 before_row jsonb not null,after_row jsonb not null,evidence jsonb,created_at timestamptz not null default clock_timestamp()
);
alter table cluera_billing_private.cancellation_commands enable row level security;
alter table cluera_billing_private.cancellation_audit enable row level security;
revoke all on cluera_billing_private.cancellation_commands,cluera_billing_private.cancellation_audit from public,anon,authenticated,service_role;
create trigger immutable before update or delete or truncate on cluera_billing_private.cancellation_audit
 for each statement execute function cluera_billing_private.immutable();
alter table cluera_billing_private.cancellation_audit enable always trigger immutable;

create function cluera_billing_private.cancellation_public(p_row cluera_billing_private.cancellation_commands) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('code','RECORDED','command',jsonb_build_object('operationId',p_row.operation_id,
 'subscriptionId',p_row.subscription_id,'state',p_row.state));
$$;

create function public.cluera_billing_cancel_prepare(p_user uuid,p_session uuid,p_operation uuid,p_subscription text,p_account_digest text,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;c cluera_billing_private.cancellation_commands;s cluera_billing_private.subscriptions;b jsonb;begin
 if p_operation is null or p_subscription is null or p_subscription !~ '^sub_[A-Za-z0-9]{8,64}$' or p_epoch is null
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera' and epoch=p_epoch and account_digest=p_account_digest)
 then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 -- Hold the same owner/epoch fence as the financial writer through commit.
 if cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 select * into c from cluera_billing_private.cancellation_commands where operation_id=p_operation;
 if found then
 if c.user_id<>p_user or c.subscription_id<>p_subscription or c.account_digest<>p_account_digest or c.epoch<>p_epoch then return jsonb_build_object('code','CONFLICT');end if;
 return cluera_billing_private.cancellation_public(c);end if;
 select * into s from cluera_billing_private.subscriptions where user_id=p_user and subscription_id=p_subscription and account_digest=p_account_digest for update;
 if not found then return jsonb_build_object('code','FORBIDDEN');end if;
 -- Reusing another operation UUID cannot lease a second provider command.
 select * into c from cluera_billing_private.cancellation_commands where subscription_id=p_subscription;
 if found then return cluera_billing_private.cancellation_public(c);end if;
 if s.state not in ('ACTIVE','PAST_DUE','PAUSED') or s.cancel_future or s.paid_through is null then return jsonb_build_object('code','UNAVAILABLE');end if;
 b:=public.cluera_billing_binding(p_subscription,p_account_digest)-'legacy';
 if b->>'code' is distinct from 'VERIFIED' or b->>'userId' is distinct from p_user::text
 or b->'revision'->>'kind' is distinct from 'RECURRING' then return jsonb_build_object('code','FORBIDDEN');end if;
 insert into cluera_billing_private.cancellation_commands(operation_id,user_id,subscription_id,account_digest,epoch,state,before_row)
 values(p_operation,p_user,p_subscription,p_account_digest,p_epoch,'CLAIMED',to_jsonb(s)) returning * into c;
 insert into cluera_billing_private.cancellation_audit(operation_id,before_row,after_row) values(c.operation_id,'{}',to_jsonb(c));
 return jsonb_build_object('code','CLAIMED','claimId',c.claim_id,'binding',b);
end$$;

create function public.cluera_billing_cancel_finish(p_user uuid,p_session uuid,p_operation uuid,p_subscription text,p_account_digest text,p_epoch bigint,p_claim uuid,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;c cluera_billing_private.cancellation_commands;prior jsonb;observed timestamptz;state_value text;begin
 if p_claim is null or p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select * into c from cluera_billing_private.cancellation_commands where operation_id=p_operation and user_id=p_user
 and subscription_id=p_subscription and account_digest=p_account_digest and epoch=p_epoch and claim_id=p_claim for update;
 if not found then return jsonb_build_object('code','CONFLICT');end if;
 if c.state<>'CLAIMED' then return cluera_billing_private.cancellation_public(c);end if;
 prior:=to_jsonb(c);
 if p_evidence is null or c.lease_until<clock_timestamp() then state_value:='UNCERTAIN';
 else
 if jsonb_typeof(p_evidence) is distinct from 'object' or p_evidence-array['subscriptionId','providerState','observedAt']<>'{}'::jsonb
 or p_evidence->>'subscriptionId' is distinct from c.subscription_id
 or p_evidence->>'providerState' is null or p_evidence->>'providerState' not in ('active','pending','halted','paused','cancelled','completed','expired')
 then return jsonb_build_object('code','INVALID');end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;exception when others then return jsonb_build_object('code','INVALID');end;
 if observed is null or not isfinite(observed) or observed<c.created_at-interval '5 seconds' or observed<clock_timestamp()-interval '90 seconds'
 or observed>clock_timestamp()+interval '5 seconds' then return jsonb_build_object('code','INVALID');end if;
 state_value:=case when p_evidence->>'providerState' in ('cancelled','completed','expired') then 'CONFIRMED' else 'ACCEPTED' end;
 end if;
 update cluera_billing_private.cancellation_commands set state=state_value,observed_at=observed,provider_state=p_evidence->>'providerState'
 where operation_id=c.operation_id returning * into c;
 insert into cluera_billing_private.cancellation_audit(operation_id,before_row,after_row,evidence) values(c.operation_id,prior,to_jsonb(c),p_evidence);
 -- ACK does not fabricate a cancellation cutoff or revoke already-paid time.
 -- Subscription state, grace, grants and reservations remain webhook-owned.
 return cluera_billing_private.cancellation_public(c);
end$$;

create function public.cluera_billing_cancel_read(p_user uuid,p_session uuid,p_operation uuid,p_account_digest text,p_epoch bigint)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;c cluera_billing_private.cancellation_commands;b jsonb;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select * into c from cluera_billing_private.cancellation_commands where operation_id=p_operation and user_id=p_user and account_digest=p_account_digest and epoch=p_epoch;
 if not found then return jsonb_build_object('code','FORBIDDEN');end if;
 b:=public.cluera_billing_binding(c.subscription_id,p_account_digest)-'legacy';
 return cluera_billing_private.cancellation_public(c)||jsonb_build_object('binding',b);
end$$;

create function public.cluera_billing_cancel_observe(p_user uuid,p_session uuid,p_operation uuid,p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb;c cluera_billing_private.cancellation_commands;prior jsonb;observed timestamptz;begin
 if p_epoch is null or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select * into c from cluera_billing_private.cancellation_commands where operation_id=p_operation and user_id=p_user and account_digest=p_account_digest and epoch=p_epoch for update;
 if not found then return jsonb_build_object('code','FORBIDDEN');end if;
 if c.state='CONFIRMED' then return cluera_billing_private.cancellation_public(c);end if;
 if jsonb_typeof(p_evidence) is distinct from 'object' or p_evidence-array['subscriptionId','providerState','observedAt']<>'{}'::jsonb
 or p_evidence->>'subscriptionId' is distinct from c.subscription_id or p_evidence->>'providerState' is null
 or p_evidence->>'providerState' not in ('cancelled','completed','expired') then return jsonb_build_object('code','INVALID');end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;exception when others then return jsonb_build_object('code','INVALID');end;
 if observed is null or not isfinite(observed) or observed<c.created_at-interval '5 seconds' or observed<clock_timestamp()-interval '90 seconds'
 or observed>clock_timestamp()+interval '5 seconds' then return jsonb_build_object('code','INVALID');end if;
 prior:=to_jsonb(c);
 update cluera_billing_private.cancellation_commands set state='CONFIRMED',observed_at=observed,provider_state=p_evidence->>'providerState'
 where operation_id=c.operation_id returning * into c;
 insert into cluera_billing_private.cancellation_audit(operation_id,before_row,after_row,evidence) values(c.operation_id,prior,to_jsonb(c),p_evidence);
 return cluera_billing_private.cancellation_public(c);
end$$;

revoke all on function cluera_billing_private.cancellation_public(cluera_billing_private.cancellation_commands) from public,anon,authenticated,service_role;
revoke all on function public.cluera_billing_cancel_prepare(uuid,uuid,uuid,text,text,bigint),
 public.cluera_billing_cancel_finish(uuid,uuid,uuid,text,text,bigint,uuid,jsonb),public.cluera_billing_cancel_read(uuid,uuid,uuid,text,bigint),
 public.cluera_billing_cancel_observe(uuid,uuid,uuid,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.cluera_billing_cancel_prepare(uuid,uuid,uuid,text,text,bigint),
 public.cluera_billing_cancel_finish(uuid,uuid,uuid,text,text,bigint,uuid,jsonb),public.cluera_billing_cancel_read(uuid,uuid,uuid,text,bigint),
 public.cluera_billing_cancel_observe(uuid,uuid,uuid,text,bigint,jsonb) to service_role;


-- UNAPPLIED financial proposal for isolated Cluera Test only. This is NOT a
-- migration, activation, provider command or replacement for merchant acceptance.
-- Every financial entry point requires this NEW database gate (default false)
-- plus the existing owner/epoch/leased-receipt proof. The prepared web caller
-- independently requires CLUERA_RECURRING_SCHEDULE_ENABLED=true (default false).
-- RESCHEDULE is deliberately REVIEW-only: no speculative provider PATCH exists.

create table cluera_billing_private.native_config(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into cluera_billing_private.native_config values(true,false);
create table cluera_billing_private.native_schedules(
 user_id uuid primary key references public.customer_accounts(user_id),version bigint not null default 0 check(version>=0),
 schedule jsonb not null check(jsonb_typeof(schedule)='object'),updated_at timestamptz not null default clock_timestamp()
);
create table cluera_billing_private.native_outbox(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.customer_accounts(user_id),subscription_id text not null,
 schedule_version bigint not null,action_key text not null,kind text not null check(kind in ('CANCEL_FUTURE','RESCHEDULE')),effective_at timestamptz,
 state text not null check(state in ('PENDING','CLAIMED','ACCEPTED','DONE','UNCERTAIN','REVIEW','SUPERSEDED')),
 claim_id uuid,lease_until timestamptz,account_digest text not null,epoch bigint not null,
 created_at timestamptz not null default clock_timestamp(),observed_at timestamptz,evidence jsonb,
 unique(user_id,schedule_version,action_key),foreign key(user_id,subscription_id) references cluera_billing_private.subscriptions(user_id,subscription_id),
 check((kind='CANCEL_FUTURE' and effective_at is null)or(kind='RESCHEDULE' and effective_at is not null and isfinite(effective_at)))
);
create index cluera_native_outbox_pending on cluera_billing_private.native_outbox(created_at,id) where state='PENDING';
create table cluera_billing_private.native_audit(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.customer_accounts(user_id),
 source text not null,before_row jsonb not null,after_row jsonb not null,evidence jsonb,created_at timestamptz not null default clock_timestamp()
);
do $$declare name text;begin
 foreach name in array array['native_config','native_schedules','native_outbox','native_audit']loop
 execute format('alter table cluera_billing_private.%I enable row level security',name);
 execute format('revoke all on cluera_billing_private.%I from public,anon,authenticated,service_role',name);
 end loop;
end$$;
create trigger immutable before update or delete or truncate on cluera_billing_private.native_audit
 for each statement execute function cluera_billing_private.immutable();
alter table cluera_billing_private.native_audit enable always trigger immutable;

create function cluera_billing_private.native_integer(p_value jsonb,p_key text,p_nullable boolean default false)returns bigint
language plpgsql immutable security invoker set search_path='' as $$declare value bigint;begin
 if p_nullable and p_value->p_key='null'::jsonb then return null;end if;
 if jsonb_typeof(p_value->p_key)is distinct from 'number' or p_value->>p_key!~'^[0-9]+$'then raise exception 'Native schedule integer requires review';end if;
 value:=(p_value->>p_key)::bigint;if value>9007199254740991 then raise exception 'Native schedule integer requires review';end if;return value;
end$$;
create function cluera_billing_private.native_live(p_user uuid,p_schedule jsonb,p_at timestamptz)returns jsonb
language plpgsql stable security invoker set search_path='' as $$declare terms_value jsonb;begin
 select coalesce(jsonb_agg(case when p.grant_id is null then t.value else
 jsonb_set(jsonb_set(t.value,'{spentMs}',to_jsonb(g.spent_ms)),'{reservedMs}',to_jsonb(g.reserved_ms))end order by(t.value->>'sequence')::bigint),'[]')into terms_value
 from jsonb_array_elements(p_schedule->'terms')t(value)
 left join cluera_billing_private.payments p on p.invoice_id=t.value->>'invoiceId'and p.user_id=p_user
 left join public.customer_usage_grants g on g.id=p.grant_id and g.user_id=p_user;
 return jsonb_set(jsonb_set(p_schedule,'{terms}',terms_value),'{at}',to_jsonb(floor(extract(epoch from p_at)*1000)::bigint));
end$$;
create function cluera_billing_private.native_digest(p_schedule jsonb)returns text
language sql immutable security invoker set search_path=''as $$select encode(sha256(convert_to((p_schedule-'at')::text,'UTF8')),'hex')$$;

-- This validation is repeated before a snapshot, settlement or commit. Provider
-- evidence still comes from the independently verified server adapter, never a
-- browser callback. SQL additionally checks the exact signed receipt lease and
-- all immutable policy/resource/amount/period/cancellation/replay relationships.
create function cluera_billing_private.native_receipt(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns cluera_billing_private.intents language plpgsql security invoker set search_path=''as $$
declare i cluera_billing_private.intents;r cluera_billing_private.catalog_revisions;e cluera_billing_private.events;
 paid cluera_billing_private.payments;observed timestamptz;ps timestamptz;pe timestamptz;paid_at_value timestamptz;cutoff timestamptz;
 action_value text:=p_evidence->>'action';t timestamptz:=date_trunc('milliseconds',clock_timestamp());begin
 if not exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or p_epoch is null or p_claim is null or p_event is null or p_digest is null or p_digest!~'^[a-f0-9]{64}$'
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'and epoch=p_epoch and account_digest=p_account_digest)
 or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch)is not true then raise exception 'Native recurring is unavailable';end if;
 if jsonb_typeof(p_evidence)is distinct from 'object'or p_evidence-array['action','intentId','orderId','paymentId','invoiceId','subscriptionId','amountPaise','currency','observedAt','periodStart','periodEnd','subscriptionState','refundId','paidAt','cancellationAt']<>'{}'::jsonb
 or action_value is null or action_value not in('GRANT','REFUND','STATUS')then raise exception 'Native receipt requires review';end if;
 begin
 select *into i from cluera_billing_private.intents where id=(p_evidence->>'intentId')::uuid;
 observed:=(p_evidence->>'observedAt')::timestamptz;ps:=(p_evidence->>'periodStart')::timestamptz;pe:=(p_evidence->>'periodEnd')::timestamptz;
 paid_at_value:=(p_evidence->>'paidAt')::timestamptz;cutoff:=(p_evidence->>'cancellationAt')::timestamptz;
 exception when others then raise exception 'Native receipt requires review';end;
 if i.id is null or i.subscription_id is null or i.account_digest<>p_account_digest or i.state not in('BOUND','VERIFIED','REFUNDED')
 or observed is null or not isfinite(observed)or observed<t-interval '90 seconds'or observed>t+interval '5 seconds'
 then raise exception 'Native receipt requires review';end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select *into strict i from cluera_billing_private.intents where id=i.id for update;
 if exists(select 1 from public.customer_recurring_terms where user_id=i.user_id)
 or exists(select 1 from cluera_billing_private.native_schedules ns join cluera_billing_private.terms physical on physical.user_id=ns.user_id
 where ns.user_id=i.user_id and not exists(select 1 from jsonb_array_elements(ns.schedule->'terms')planned where planned->>'invoiceId'=physical.invoice_id))
 then raise exception 'Native writer routing requires review';end if;
 select *into strict r from cluera_billing_private.catalog_revisions where id=i.revision_id;
 select *into e from cluera_billing_private.events where event_id=p_event for update;
 if e.event_id is null or e.state<>'PENDING'or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=t
 or e.digest<>p_digest or e.account_digest<>p_account_digest or r.kind<>'RECURRING'
 or p_evidence->>'subscriptionId'is distinct from i.subscription_id or jsonb_typeof(p_evidence->'amountPaise')is distinct from 'number'
 or(p_evidence->>'amountPaise')::numeric<>r.amount_paise or p_evidence->>'currency'is distinct from 'INR'
 then raise exception 'Native receipt requires review';end if;
 if(e.subscription_id is not null and e.subscription_id is distinct from i.subscription_id)
 or(e.payment_id is not null and e.payment_id is distinct from p_evidence->>'paymentId')
 or(e.order_id is not null and e.order_id is distinct from p_evidence->>'orderId')
 or(e.invoice_id is not null and e.invoice_id is distinct from p_evidence->>'invoiceId')then raise exception 'Native receipt requires review';end if;
 if cutoff is not null and(not isfinite(cutoff)or cutoff>observed+interval '5 seconds')then raise exception 'Native receipt requires review';end if;
 if p_evidence->>'subscriptionState'='CANCELED'and cutoff is null then raise exception 'Native receipt requires review';end if;
 if action_value='STATUS'then
 if e.event_type not like 'subscription.%'or e.event_type='subscription.charged'or e.resource_id is distinct from i.subscription_id
 or p_evidence->>'paymentId'is not null or p_evidence->>'orderId'is not null or p_evidence->>'invoiceId'is not null
 or ps is not null or pe is not null or paid_at_value is not null or p_evidence->>'refundId'is not null
 or(p_evidence->>'subscriptionState'is null and e.event_type<>'subscription.authenticated')
 or(p_evidence->>'subscriptionState'is not null and p_evidence->>'subscriptionState'not in('ACTIVE','PAST_DUE','PAUSED','CANCELED'))
 then raise exception 'Native receipt requires review';end if;
 else
 if p_evidence->>'paymentId'is null or p_evidence->>'paymentId'!~'^pay_[A-Za-z0-9]{8,64}$'
 or p_evidence->>'orderId'is null or p_evidence->>'orderId'!~'^order_[A-Za-z0-9]{8,64}$'
 or p_evidence->>'invoiceId'is null or p_evidence->>'invoiceId'!~'^inv_[A-Za-z0-9]{8,64}$'
 or ps is null or pe is null or not isfinite(ps)or not isfinite(pe)or pe-ps not between interval '27 days'and interval '32 days'
 or ps>t+interval '32 days'or paid_at_value is null or not isfinite(paid_at_value)or paid_at_value>observed+interval '5 seconds'
 or p_evidence->>'subscriptionState'is null or p_evidence->>'subscriptionState'not in('ACTIVE','PAST_DUE','PAUSED','CANCELED')
 then raise exception 'Native receipt requires review';end if;
 if action_value='GRANT'and(e.event_type not in('payment.captured','order.paid','subscription.charged')or p_evidence->>'refundId'is not null
 or p_evidence->>'subscriptionState'not in('ACTIVE','CANCELED')or(cutoff is not null and paid_at_value>cutoff))
 then raise exception 'Native receipt requires review';end if;
 if action_value='REFUND'and(e.event_type<>'refund.processed'or p_evidence->>'refundId'is null
 or p_evidence->>'refundId'!~'^rfnd_[A-Za-z0-9]{8,64}$'or e.resource_id is distinct from p_evidence->>'refundId')
 then raise exception 'Native receipt requires review';end if;
 select *into paid from cluera_billing_private.payments where payment_id=p_evidence->>'paymentId'or order_id=p_evidence->>'orderId'or invoice_id=p_evidence->>'invoiceId'for update;
 if paid.payment_id is not null and(paid.payment_id is distinct from p_evidence->>'paymentId'or paid.order_id is distinct from p_evidence->>'orderId'
 or paid.invoice_id is distinct from p_evidence->>'invoiceId'or paid.intent_id<>i.id or paid.user_id<>i.user_id or paid.subscription_id is distinct from i.subscription_id
 or paid.revision_id<>r.id or paid.amount_paise<>r.amount_paise or paid.period_start is distinct from ps or paid.period_end is distinct from pe or paid.paid_at is distinct from paid_at_value)
 then raise exception 'Native receipt requires review';end if;
 if exists(select 1 from billing_private.payment_intents where order_id=p_evidence->>'orderId'or payment_id=p_evidence->>'paymentId')
 then raise exception 'Native receipt requires review';end if;
 end if;
 return i;
end$$;

create function public.cluera_billing_native_snapshot(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare i cluera_billing_private.intents;s cluera_billing_private.native_schedules;value jsonb;begin
 i:=cluera_billing_private.native_receipt(p_event,p_claim,p_digest,p_account_digest,p_epoch,p_evidence);
 select *into s from cluera_billing_private.native_schedules where user_id=i.user_id for update;
 if not found then
 if exists(select 1 from cluera_billing_private.terms where user_id=i.user_id)or exists(select 1 from public.customer_recurring_terms where user_id=i.user_id)
 then raise exception 'Native recurring import requires review';end if;
 insert into cluera_billing_private.native_schedules(user_id,schedule)values(i.user_id,jsonb_build_object('at',floor(extract(epoch from clock_timestamp())*1000)::bigint,'terms','[]'::jsonb,'subscriptions','[]'::jsonb,'actions','[]'::jsonb))returning *into s;
 end if;
 value:=cluera_billing_private.native_live(i.user_id,s.schedule,clock_timestamp());
 return jsonb_build_object('code','ACTIVE','userId',i.user_id,'version',s.version,'schedule',value,'snapshotDigest',cluera_billing_private.native_digest(value));
end$$;

create function public.cluera_billing_native_settle(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)
returns text language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare i cluera_billing_private.intents;s cluera_billing_private.native_schedules;t record;target timestamptz;now_value timestamptz:=clock_timestamp();begin
 i:=cluera_billing_private.native_receipt(p_event,p_claim,p_digest,p_account_digest,p_epoch,p_evidence);
 select *into strict s from cluera_billing_private.native_schedules where user_id=i.user_id for update;
 for t in select x.value,p.grant_id from jsonb_array_elements(s.schedule->'terms')x(value)
 join cluera_billing_private.payments p on p.invoice_id=x.value->>'invoiceId'and p.user_id=i.user_id
 join public.customer_usage_grants g on g.id=p.grant_id and g.user_id=i.user_id where g.reserved_ms>0 and(
 ((x.value->>'state')in('ACTIVE','SUSPENDED')and to_timestamp((x.value->>'endsAt')::numeric/1000)<=now_value)
 or(p_evidence->>'action'='REFUND'and x.value->>'invoiceId'=p_evidence->>'invoiceId')
 or(p_evidence->>'action'='STATUS'and p_evidence->>'subscriptionState'='PAUSED'and x.value->>'subscriptionId'=i.subscription_id)
 or(p_evidence->>'action'='GRANT'and(p_evidence->>'periodStart')::timestamptz<=now_value and(x.value->>'subscriptionId'=i.subscription_id
 or(x.value->>'offerCode'in('cluera_monthly_40h_v2','cluera_monthly_100h_v2')and(select offer_code from cluera_billing_private.catalog_revisions where id=i.revision_id)='cluera_monthly_200h_v2'))))loop
 target:=least(now_value,coalesce(to_timestamp((t.value->>'endsAt')::numeric/1000),now_value));
 perform public.customer_recurring_stop_grant(i.user_id,t.grant_id,target);
 end loop;
 return 'SETTLED';
end$$;

create function cluera_billing_private.native_commands(p_user uuid,p_previous jsonb,p_next jsonb,p_version bigint,p_account_digest text,p_epoch bigint)returns void
language plpgsql security invoker set search_path=''as $$declare command_value jsonb;begin
 -- Only PENDING work may be superseded. Unknown/claimed commands retain their
 -- evidence and block later mutation claims for the same subscription.
 update cluera_billing_private.native_outbox o set state='SUPERSEDED'where user_id=p_user and state='PENDING'and kind='RESCHEDULE'
 and not exists(select 1 from jsonb_array_elements(p_next->'actions')a where a->>'key'=o.action_key);
 for command_value in select *from jsonb_array_elements(p_next->'actions')loop
 if not exists(select 1 from jsonb_array_elements(p_previous->'actions')a where a->>'key'=command_value->>'key')then
 insert into cluera_billing_private.native_outbox(user_id,subscription_id,schedule_version,action_key,kind,effective_at,state,account_digest,epoch)
 values(p_user,command_value->>'subscriptionId',p_version,command_value->>'key',command_value->>'kind',case when command_value->>'at'is null then null else to_timestamp((command_value->>'at')::numeric/1000)end,
 case when command_value->>'kind'='RESCHEDULE'then 'REVIEW'else 'PENDING'end,p_account_digest,p_epoch);
 end if;end loop;
end$$;

-- Strict structural and immutable-attribution checks are repeated in SQL.
-- Only service RPCs can submit plans; no browser can write this representation.
create function cluera_billing_private.native_check(p_user uuid,p_previous jsonb,p_next jsonb,p_at bigint,p_invoice text default null)
returns void language plpgsql security invoker set search_path=''as $$
declare v jsonb;old jsonb;s jsonb;r cluera_billing_private.catalog_revisions;g public.customer_usage_grants;paid cluera_billing_private.payments;n bigint;begin
 if jsonb_typeof(p_next)is distinct from 'object'or p_next-array['at','terms','subscriptions','actions']<>'{}'::jsonb
 or cluera_billing_private.native_integer(p_next,'at')<>p_at
 or jsonb_typeof(p_next->'terms')is distinct from 'array'or jsonb_typeof(p_next->'subscriptions')is distinct from 'array'or jsonb_typeof(p_next->'actions')is distinct from 'array'
 or jsonb_array_length(p_next->'terms')>10000 or jsonb_array_length(p_next->'subscriptions')>10000 or jsonb_array_length(p_next->'actions')>20000
 then raise exception 'Native plan requires review';end if;
 if(select count(*)from jsonb_array_elements(p_next->'terms')t where t->>'state'in('ACTIVE','SUSPENDED'))>1
 or exists(select 1 from jsonb_array_elements(p_previous->'terms')o where not exists(select 1 from jsonb_array_elements(p_next->'terms')t where t->>'invoiceId'=o->>'invoiceId'))
 or exists(select 1 from jsonb_array_elements(p_previous->'subscriptions')o where not exists(select 1 from jsonb_array_elements(p_next->'subscriptions')candidate where candidate->>'subscriptionId'=o->>'subscriptionId'))
 then raise exception 'Native plan requires review';end if;
 for v in select *from jsonb_array_elements(p_next->'terms')loop
 if v-array['invoiceId','paymentId','orderId','subscriptionId','revisionId','offerCode','amountPaise','grantedMs','spentMs','reservedMs','periodStart','periodEnd','paidAt','state','startsAt','endsAt','remainingWallMs','closedAt','sequence']<>'{}'::jsonb
 or v->>'state'is null or v->>'state'not in('ACTIVE','SUSPENDED','QUEUED','PRESERVED','ENDED','REFUNDED')
 or(select count(*)from jsonb_array_elements(p_next->'terms')t where t->>'invoiceId'=v->>'invoiceId'or t->>'paymentId'=v->>'paymentId'or t->>'orderId'=v->>'orderId')<>1
 then raise exception 'Native term requires review';end if;
 select *into r from cluera_billing_private.catalog_revisions where id=(v->>'revisionId')::uuid;
 select *into s from jsonb_array_elements(p_next->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 if r.id is null or r.kind<>'RECURRING'or r.offer_code<>v->>'offerCode'or s is null or s->>'revisionId'<>r.id::text
 or cluera_billing_private.native_integer(v,'amountPaise')<>r.amount_paise or cluera_billing_private.native_integer(v,'grantedMs')<>r.allowance_seconds::bigint*1000
 or cluera_billing_private.native_integer(v,'periodEnd')-cluera_billing_private.native_integer(v,'periodStart')not between 2332800000 and 2764800000
 or cluera_billing_private.native_integer(v,'paidAt')>p_at+5000
 or cluera_billing_private.native_integer(v,'spentMs')+cluera_billing_private.native_integer(v,'reservedMs')>cluera_billing_private.native_integer(v,'grantedMs')
 then raise exception 'Native term requires review';end if;
 perform cluera_billing_private.native_integer(v,'sequence');perform cluera_billing_private.native_integer(v,'startsAt',true);
 perform cluera_billing_private.native_integer(v,'endsAt',true);perform cluera_billing_private.native_integer(v,'remainingWallMs',true);perform cluera_billing_private.native_integer(v,'closedAt',true);
 select x into old from jsonb_array_elements(p_previous->'terms')x where x->>'invoiceId'=v->>'invoiceId';
 if old is not null then
 if old-array['state','startsAt','endsAt','remainingWallMs','closedAt'] is distinct from v-array['state','startsAt','endsAt','remainingWallMs','closedAt']
 or(old->>'state'='REFUNDED'and v->>'state'<>'REFUNDED')then raise exception 'Native attribution is immutable';end if;
 else
 if v->>'invoiceId'is distinct from p_invoice or cluera_billing_private.native_integer(v,'spentMs')<>0 or cluera_billing_private.native_integer(v,'reservedMs')<>0
 then raise exception 'Native invoice requires review';end if;
 end if;
 select *into paid from cluera_billing_private.payments where invoice_id=v->>'invoiceId';
 if paid.payment_id is not null then
 if paid.user_id<>p_user or paid.payment_id<>v->>'paymentId'or paid.order_id<>v->>'orderId'or paid.subscription_id<>v->>'subscriptionId'or paid.revision_id<>r.id
 or paid.amount_paise<>r.amount_paise or paid.period_start<>to_timestamp((v->>'periodStart')::numeric/1000)or paid.period_end<>to_timestamp((v->>'periodEnd')::numeric/1000)
 or paid.paid_at<>to_timestamp((v->>'paidAt')::numeric/1000)then raise exception 'Native invoice requires review';end if;
 if paid.grant_id is null then
 if v->>'state'<>'REFUNDED'or(v->>'spentMs')::bigint<>0 or(v->>'reservedMs')::bigint<>0 then raise exception 'Native refund tombstone requires review';end if;
 else
 select *into strict g from public.customer_usage_grants where id=paid.grant_id and user_id=p_user for update;
 if g.kind<>'RECURRING'or g.source_key<>'razorpay-test-invoice:'||paid.invoice_id or g.granted_ms<>(v->>'grantedMs')::bigint
 or g.spent_ms<>(v->>'spentMs')::bigint or g.reserved_ms<>(v->>'reservedMs')::bigint then raise exception 'Native usage changed';end if;
 end if;end if;
 if v->>'state'in('ACTIVE','SUSPENDED')then
 if v->>'startsAt'is null or v->>'endsAt'is null or(v->>'endsAt')::bigint<=(v->>'startsAt')::bigint or v->>'remainingWallMs'is not null
 or(v->>'startsAt')::bigint>p_at then raise exception 'Native active window requires review';end if;
 elsif v->>'state'in('QUEUED','PRESERVED')then
 if v->>'startsAt'is not null or v->>'endsAt'is not null or coalesce((v->>'remainingWallMs')::bigint,0)<=0 or(v->>'reservedMs')::bigint<>0
 or(v->>'state'='PRESERVED'and r.offer_code='cluera_monthly_200h_v2')then raise exception 'Native preserved window requires review';end if;
 else
 if v->>'closedAt'is null or(v->>'closedAt')::bigint>p_at or(v->>'reservedMs')::bigint<>0 then raise exception 'Native closed window requires review';end if;
 end if;
 if old->>'state'in('ACTIVE','SUSPENDED')and v->>'state'in('PRESERVED','QUEUED','ENDED','REFUNDED')and(v->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 if old->>'state'='PRESERVED'and v->>'state'in('ACTIVE','SUSPENDED')and(v->>'endsAt')::bigint-(v->>'startsAt')::bigint<>(old->>'remainingWallMs')::bigint
 then raise exception 'Native saved wall time changed';end if;
 if old->>'state'in('ACTIVE','SUSPENDED')and v->>'state'='PRESERVED'then
 select x into s from jsonb_array_elements(p_previous->'subscriptions')x where x->>'subscriptionId'=old->>'subscriptionId';
 if(v->>'remainingWallMs')::bigint<>least((old->>'endsAt')::bigint,(s->>'paidThrough')::bigint)-p_at then raise exception 'Native saved wall time changed';end if;
 end if;
 if old->>'state'='ENDED'and v->>'state'in('ACTIVE','SUSPENDED')then
 select x into s from jsonb_array_elements(p_next->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 if s->>'state'<>'PAST_DUE'or s->>'stopRequestedAt'is not null or(v->>'periodEnd')::bigint<>(s->>'paidThrough')::bigint
 or(v->>'endsAt')::bigint<>(s->>'paidThrough')::bigint+86400000 or(v->>'endsAt')::bigint<=p_at then raise exception 'Native reopen requires review';end if;
 end if;
 end loop;
 for v in select *from jsonb_array_elements(p_next->'subscriptions')loop
 if v-array['subscriptionId','revisionId','offerCode','state','observedAt','paidThrough','graceUntil','cancellationAt','stopRequestedAt']<>'{}'::jsonb
 or v->>'state'is null or v->>'state'not in('ACTIVE','PAST_DUE','PAUSED','CANCELED')
 or(select count(*)from jsonb_array_elements(p_next->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId')<>1
 then raise exception 'Native subscription requires review';end if;
 perform cluera_billing_private.native_integer(v,'observedAt');perform cluera_billing_private.native_integer(v,'paidThrough');
 perform cluera_billing_private.native_integer(v,'graceUntil',true);perform cluera_billing_private.native_integer(v,'cancellationAt',true);perform cluera_billing_private.native_integer(v,'stopRequestedAt',true);
 if(v->>'state'='CANCELED'and v->>'cancellationAt'is null)or(v->>'graceUntil'is not null and(v->>'graceUntil')::bigint<>(v->>'paidThrough')::bigint+86400000)
 then raise exception 'Native subscription requires review';end if;
 select x into old from jsonb_array_elements(p_previous->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 if old is not null and(old->>'revisionId'is distinct from v->>'revisionId'or old->>'offerCode'is distinct from v->>'offerCode'
 or(old->>'state'='CANCELED'and v->>'state'<>'CANCELED')or(old->>'stopRequestedAt'is not null and old->>'stopRequestedAt'is distinct from v->>'stopRequestedAt')
 or(old->>'cancellationAt'is not null and(v->>'cancellationAt'is null or(v->>'cancellationAt')::bigint>(old->>'cancellationAt')::bigint)))
 then raise exception 'Native subscription attribution changed';end if;
 end loop;
 for v in select *from jsonb_array_elements(p_next->'actions')loop
 if v-array['key','subscriptionId','kind','at']<>'{}'::jsonb or v->>'kind'is null or v->>'kind'not in('CANCEL_FUTURE','RESCHEDULE')
 or not exists(select 1 from jsonb_array_elements(p_next->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId')
 or v->>'key'is distinct from(v->>'subscriptionId')||':'||(v->>'kind')||':'||coalesce(v->>'at','end')
 or(v->>'kind'='CANCEL_FUTURE'and v->>'at'is not null)or(v->>'kind'='RESCHEDULE'and v->>'at'is null)
 or(select count(*)from jsonb_array_elements(p_next->'actions')x where x->>'key'=v->>'key')<>1
 then raise exception 'Native command requires review';end if;
 perform cluera_billing_private.native_integer(v,'at',true);
 end loop;
end$$;

-- Project only already-proven invoice rows into the shared usage ledger. Never
-- rewrite a grant amount/spend/reservation or another product's trial/pack row.
create function cluera_billing_private.native_project(p_user uuid,p_plan jsonb)returns void
language plpgsql security invoker set search_path=''as $$declare v jsonb;p cluera_billing_private.payments;begin
 if exists(select 1 from public.customer_recurring_terms where user_id=p_user)
 or exists(select 1 from cluera_billing_private.terms physical where physical.user_id=p_user
 and not exists(select 1 from jsonb_array_elements(p_plan->'terms')planned where planned->>'invoiceId'=physical.invoice_id))then raise exception 'Native writer routing requires review';end if;
 update cluera_billing_private.terms set state='ENDED'where user_id=p_user and state in('ACTIVE','PAUSED');
 for v in select *from jsonb_array_elements(p_plan->'terms')loop
 select *into strict p from cluera_billing_private.payments where invoice_id=v->>'invoiceId'and user_id=p_user;
 update cluera_billing_private.terms set state=case v->>'state'when 'SUSPENDED'then 'PAUSED'when 'PRESERVED'then 'ENDED'else v->>'state'end,
 ends_at=to_timestamp(coalesce((v->>'endsAt')::numeric,(v->>'periodEnd')::numeric)/1000)where invoice_id=p.invoice_id;
 if p.grant_id is not null then
 update public.customer_usage_grants set state=case v->>'state'when 'ACTIVE'then 'ACTIVE'when 'ENDED'then 'REVOKED'when 'REFUNDED'then 'REVOKED'else 'PAUSED'end,
 starts_at=to_timestamp(coalesce((v->>'startsAt')::numeric,(v->>'periodStart')::numeric)/1000),
 expires_at=to_timestamp(coalesce((v->>'endsAt')::numeric,(v->>'periodEnd')::numeric)/1000)where id=p.grant_id and user_id=p_user;
 end if;
 if v->>'state'='REFUNDED'then update cluera_billing_private.payments set state='REFUNDED'where payment_id=p.payment_id;end if;
 end loop;
 for v in select *from jsonb_array_elements(p_plan->'subscriptions')loop
 update cluera_billing_private.subscriptions set state=v->>'state',observed_at=to_timestamp((v->>'observedAt')::numeric/1000),
 paid_through=to_timestamp((v->>'paidThrough')::numeric/1000),grace_until=to_timestamp((v->>'graceUntil')::numeric/1000),
 cancellation_at=to_timestamp((v->>'cancellationAt')::numeric/1000),cancel_future=v->>'state'='CANCELED'
 where subscription_id=v->>'subscriptionId'and user_id=p_user;
 end loop;
end$$;

-- This server-only gate runs BEFORE provider CREATE. The presently documented
-- merchant/method APIs do not establish arbitrary ACTIVE next-charge deferral,
-- so a competing purchase or upgrade must remain blocked before taking money.
create function public.cluera_billing_native_purchase_policy(p_user uuid,p_session uuid,p_revision uuid,p_account_digest text,p_epoch bigint)returns text
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare a jsonb;r cluera_billing_private.catalog_revisions;begin
 if not exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'and account_digest=p_account_digest and epoch=p_epoch)
 or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch)is not true then return 'UNAVAILABLE';end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code'is distinct from 'ACTIVE'then return 'UNAVAILABLE';end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 select *into r from cluera_billing_private.catalog_revisions where id=p_revision;
 if r.id is null then return 'UNAVAILABLE';end if;if r.kind='PACK'then return 'ALLOWED';end if;
 if exists(select 1 from public.customer_recurring_terms where user_id=p_user and state in('ACTIVE','PAUSED','QUEUED'))
 or exists(select 1 from cluera_billing_private.terms where user_id=p_user and state in('ACTIVE','PAUSED','QUEUED'))
 or exists(select 1 from cluera_billing_private.native_schedules s,jsonb_array_elements(s.schedule->'terms')term where s.user_id=p_user and term->>'state'in('ACTIVE','SUSPENDED','QUEUED','PRESERVED'))
 or exists(select 1 from cluera_billing_private.subscriptions where user_id=p_user and state<>'CANCELED')
 then return 'REVIEW';end if;return 'ALLOWED';
end$$;

create function public.cluera_billing_native_commit(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb,p_expected_version bigint,p_expected_digest text,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path=''set timezone='UTC'set lock_timeout='2s'set statement_timeout='5s'as $$
declare i cluera_billing_private.intents;s cluera_billing_private.native_schedules;r cluera_billing_private.catalog_revisions;
 previous jsonb;plan_item jsonb;old jsonb;sub jsonb;t bigint;paid cluera_billing_private.payments;grant_value uuid;removed bigint:=0;result text;begin
 i:=cluera_billing_private.native_receipt(p_event,p_claim,p_digest,p_account_digest,p_epoch,p_evidence);
 select *into strict s from cluera_billing_private.native_schedules where user_id=i.user_id for update;
 previous:=cluera_billing_private.native_live(i.user_id,s.schedule,clock_timestamp());
 if s.version is distinct from p_expected_version or cluera_billing_private.native_digest(previous)is distinct from p_expected_digest then return jsonb_build_object('code','CONFLICT');end if;
 t:=cluera_billing_private.native_integer(p_plan,'at');
 if abs(t-floor(extract(epoch from clock_timestamp())*1000))>5000 then return jsonb_build_object('code','CONFLICT');end if;
 -- A service DTO is not financial authority. Independently derive the complete
 -- policy transition in SQL; even a compromised planner cannot extend a term,
 -- fabricate a refund, change paidThrough or rewrite a queued duration.
 if to_regprocedure('cluera_billing_private.native_expected(uuid,jsonb,jsonb,uuid,bigint)')is null then raise exception 'Native policy bridge requires review';end if;
 if cluera_billing_private.native_expected(i.user_id,previous,p_evidence,i.revision_id,t)is distinct from p_plan then raise exception 'Native policy transition requires review';end if;
 perform cluera_billing_private.native_check(i.user_id,previous,p_plan,t,case when p_evidence->>'action'in('GRANT','REFUND')then p_evidence->>'invoiceId'else null end);
 select *into strict r from cluera_billing_private.catalog_revisions where id=i.revision_id;
 -- Only the incoming canonical subscription can change provider observation.
 for plan_item in select *from jsonb_array_elements(p_plan->'subscriptions')loop
 select x into old from jsonb_array_elements(previous->'subscriptions')x where x->>'subscriptionId'=plan_item->>'subscriptionId';
 if plan_item->>'subscriptionId'<>i.subscription_id then
 if old is null or old-array['stopRequestedAt','graceUntil']is distinct from plan_item-array['stopRequestedAt','graceUntil']then raise exception 'Native subscription evidence requires review';end if;
 else
 if plan_item->>'revisionId'<>r.id::text or plan_item->>'offerCode'<>r.offer_code then raise exception 'Native policy requires review';end if;
 end if;end loop;
 if p_evidence->>'action'<>'STATUS'then
 select x into strict plan_item from jsonb_array_elements(p_plan->'terms')x where x->>'invoiceId'=p_evidence->>'invoiceId';
 if plan_item->>'paymentId'is distinct from p_evidence->>'paymentId'or plan_item->>'orderId'is distinct from p_evidence->>'orderId'or plan_item->>'subscriptionId'is distinct from i.subscription_id
 or plan_item->>'revisionId'<>r.id::text or(plan_item->>'periodStart')::bigint<>floor(extract(epoch from(p_evidence->>'periodStart')::timestamptz)*1000)
 or(plan_item->>'periodEnd')::bigint<>floor(extract(epoch from(p_evidence->>'periodEnd')::timestamptz)*1000)
 or(plan_item->>'paidAt')::bigint<>floor(extract(epoch from(p_evidence->>'paidAt')::timestamptz)*1000)
 or(p_evidence->>'action'='REFUND'and plan_item->>'state'<>'REFUNDED')then raise exception 'Native invoice evidence requires review';end if;
 select *into paid from cluera_billing_private.payments where invoice_id=plan_item->>'invoiceId'for update;
 if paid.payment_id is null then
 if not exists(select 1 from public.customer_accounts a join auth.users u on u.id=a.user_id where a.user_id=i.user_id and a.state='ACTIVE'and u.email_confirmed_at is not null)
 and p_evidence->>'action'='GRANT'then raise exception 'Native customer is unavailable';end if;
 select x into strict sub from jsonb_array_elements(p_plan->'subscriptions')x where x->>'subscriptionId'=i.subscription_id;
 insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at)
 values(i.subscription_id,i.user_id,i.id,r.id,p_account_digest,sub->>'state',to_timestamp((sub->>'observedAt')::numeric/1000))on conflict(subscription_id)do nothing;
 if not exists(select 1 from cluera_billing_private.subscriptions where subscription_id=i.subscription_id and user_id=i.user_id and intent_id=i.id and revision_id=r.id and account_digest=p_account_digest)
 then raise exception 'Native subscription owner requires review';end if;
 if p_evidence->>'action'='GRANT'then
 insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at,expires_at,state)
 values(i.user_id,'razorpay-test-invoice:'||(plan_item->>'invoiceId'),'RECURRING',r.allowance_seconds::bigint*1000,(p_evidence->>'periodStart')::timestamptz,(p_evidence->>'periodEnd')::timestamptz,'PAUSED')returning id into grant_value;
 end if;
 insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,grant_id,state,period_start,period_end,paid_at)
 values(plan_item->>'paymentId',plan_item->>'orderId',i.id,i.user_id,plan_item->>'invoiceId',i.subscription_id,r.amount_paise,r.id,grant_value,
 case when p_evidence->>'action'='REFUND'then 'REFUNDED'else 'VERIFIED'end,(p_evidence->>'periodStart')::timestamptz,(p_evidence->>'periodEnd')::timestamptz,(p_evidence->>'paidAt')::timestamptz);
 insert into cluera_billing_private.terms values(plan_item->>'invoiceId',i.user_id,i.subscription_id,grant_value,'ENDED',(p_evidence->>'periodStart')::timestamptz,(p_evidence->>'periodEnd')::timestamptz,(p_evidence->>'periodEnd')::timestamptz);
 elsif p_evidence->>'action'='REFUND'and paid.state<>'REFUNDED'and paid.grant_id is not null then
 select granted_ms-spent_ms into removed from public.customer_usage_grants where id=paid.grant_id and user_id=i.user_id;
 end if;
 update cluera_billing_private.intents set state='VERIFIED'where id=i.id;
 end if;
 perform cluera_billing_private.native_project(i.user_id,p_plan);
 perform cluera_billing_private.native_commands(i.user_id,previous,p_plan,s.version+1,p_account_digest,p_epoch);
 update cluera_billing_private.native_schedules set schedule=p_plan,version=version+1,updated_at=clock_timestamp()where user_id=i.user_id;
 insert into cluera_billing_private.native_audit(user_id,source,before_row,after_row,evidence)values(i.user_id,'receipt:'||p_event,previous,p_plan,p_evidence);
 insert into cluera_billing_private.applications(event_id,intent_id,action,evidence,before_row,after_row,removed_ms)values(p_event,i.id,p_evidence->>'action',p_evidence,previous,p_plan,removed);
 update cluera_billing_private.events set state='PROCESSED',claim_id=null,lease_until=null where event_id=p_event;
 result:=case p_evidence->>'action'when 'GRANT'then 'VERIFIED'when 'REFUND'then 'REFUNDED'else case when p_evidence->>'subscriptionState'is null then 'NO_GRANT'else 'STATUS'end end;
 return jsonb_build_object('code',result);
end$$;

create function public.cluera_billing_native_command_claim(p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare o cluera_billing_private.native_outbox;c uuid:=gen_random_uuid();other text;begin
 if not exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'and account_digest=p_account_digest and epoch=p_epoch)
 or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch)is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 -- Expiration means UNKNOWN, never a new claim or mutation retry.
 update cluera_billing_private.native_outbox set state='UNCERTAIN'where state='CLAIMED'and lease_until<=clock_timestamp()and account_digest=p_account_digest and epoch=p_epoch;
 select *into o from cluera_billing_private.native_outbox x where x.state='PENDING'and x.kind='CANCEL_FUTURE'and x.account_digest=p_account_digest and x.epoch=p_epoch
 and not exists(select 1 from cluera_billing_private.native_outbox z where z.subscription_id=x.subscription_id and z.state in('CLAIMED','UNCERTAIN','ACCEPTED','DONE'))
 order by x.created_at,x.id limit 1;
 if not found then return jsonb_build_object('code','EMPTY');end if;
 perform 1 from public.customer_accounts where user_id=o.user_id for update;
 select *into o from cluera_billing_private.native_outbox where id=o.id and state='PENDING'for update;
 if not found then return jsonb_build_object('code','EMPTY');end if;
 if exists(select 1 from cluera_billing_private.native_outbox z where z.id<>o.id and z.subscription_id=o.subscription_id and z.state in('CLAIMED','UNCERTAIN','ACCEPTED','DONE'))then return jsonb_build_object('code','EMPTY');end if;
 if not exists(select 1 from cluera_billing_private.native_schedules s,jsonb_array_elements(s.schedule->'actions')a
 where s.user_id=o.user_id and a->>'key'=o.action_key)then
 update cluera_billing_private.native_outbox set state='SUPERSEDED'where id=o.id;return jsonb_build_object('code','EMPTY');end if;
 -- Coordinate the independent owner-directed cancellation facility, if that
 -- separately approved proposal is installed. Its insert trigger below uses
 -- the same account lock to prevent a concurrent second command family.
 if to_regclass('cluera_billing_private.cancellation_commands')is not null then
 execute 'select state from cluera_billing_private.cancellation_commands where subscription_id=$1'into other using o.subscription_id;
 if other is not null then
 update cluera_billing_private.native_outbox set state=case other when 'CONFIRMED'then 'DONE'when 'ACCEPTED'then 'ACCEPTED'else 'UNCERTAIN'end where id=o.id;
 return jsonb_build_object('code','EMPTY');end if;end if;
 update cluera_billing_private.native_outbox set state='CLAIMED',claim_id=c,lease_until=clock_timestamp()+interval '90 seconds'where id=o.id;
 insert into cluera_billing_private.native_audit(user_id,source,before_row,after_row)values(o.user_id,'command-claim:'||o.id,to_jsonb(o),jsonb_build_object('state','CLAIMED','claimId',c));
 return jsonb_build_object('code','CLAIMED','commandId',o.id,'claimId',c,'userId',o.user_id,'subscriptionId',o.subscription_id,'kind',o.kind);
end$$;

create function public.cluera_billing_native_command_finish(p_id uuid,p_claim uuid,p_account_digest text,p_epoch bigint,p_evidence jsonb)returns text
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare o cluera_billing_private.native_outbox;state_value text:='UNCERTAIN';observed timestamptz;begin
 if not exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'and account_digest=p_account_digest and epoch=p_epoch)
 or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch)is not true then return 'UNAVAILABLE';end if;
 select *into o from cluera_billing_private.native_outbox where id=p_id;
 if not found then return 'NOT_FOUND';end if;
 perform 1 from public.customer_accounts where user_id=o.user_id for update;
 select *into o from cluera_billing_private.native_outbox where id=p_id for update;
 if o.account_digest<>p_account_digest or o.epoch<>p_epoch or o.claim_id is distinct from p_claim or o.state not in('CLAIMED','UNCERTAIN','ACCEPTED')then return 'CONFLICT';end if;
 if p_evidence is null and o.state in('UNCERTAIN','ACCEPTED')then return o.state;end if;
 if p_evidence is not null then
 if jsonb_typeof(p_evidence)is distinct from 'object'or p_evidence-array['subscriptionId','providerState','observedAt']<>'{}'::jsonb
 or p_evidence->>'subscriptionId'is distinct from o.subscription_id then return 'INVALID';end if;
 begin observed:=(p_evidence->>'observedAt')::timestamptz;exception when others then return 'INVALID';end;
 if observed is null or not isfinite(observed)or observed<clock_timestamp()-interval '90 seconds'or observed>clock_timestamp()+interval '5 seconds'
 or p_evidence->>'providerState'is null or p_evidence->>'providerState'not in('created','authenticated','active','pending','halted','paused','cancelled','completed','expired')then return 'INVALID';end if;
 if p_evidence->>'providerState'in('cancelled','completed','expired')then state_value:='DONE';
 elsif o.state='CLAIMED'and o.lease_until>clock_timestamp()then state_value:='ACCEPTED';
 else state_value:=case when o.state='CLAIMED'then 'UNCERTAIN'else o.state end;end if;
 end if;
 -- An active response is an ACK, never terminal proof or an entitlement write.
 update cluera_billing_private.native_outbox set state=state_value,lease_until=null,observed_at=observed,evidence=p_evidence where id=o.id;
 insert into cluera_billing_private.native_audit(user_id,source,before_row,after_row,evidence)values(o.user_id,'command-finish:'||o.id,to_jsonb(o),jsonb_build_object('state',state_value),p_evidence);
 return state_value;
end$$;

create function public.cluera_billing_native_command_observation(p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare o cluera_billing_private.native_outbox;begin
 if not exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'and account_digest=p_account_digest and epoch=p_epoch)
 or cluera_billing_private.owns(p_account_digest,'cluera',p_epoch)is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 select *into o from cluera_billing_private.native_outbox where account_digest=p_account_digest and epoch=p_epoch and claim_id is not null
 and(state in('UNCERTAIN','ACCEPTED')or(state='CLAIMED'and lease_until<=clock_timestamp()))
 and(observed_at is null or observed_at<clock_timestamp()-interval '1 minute')order by observed_at nulls first,created_at,id limit 1;
 if not found then return jsonb_build_object('code','EMPTY');end if;
 return jsonb_build_object('code','OBSERVE','commandId',o.id,'claimId',o.claim_id,'userId',o.user_id,'subscriptionId',o.subscription_id,'kind',o.kind);
end$$;

create function cluera_billing_private.native_cancel_guard()returns trigger language plpgsql security invoker set search_path=''as $$begin
 if exists(select 1 from cluera_billing_private.native_outbox where subscription_id=new.subscription_id and kind='CANCEL_FUTURE'and state not in('SUPERSEDED','REVIEW'))
 then raise exception 'Subscription change is already retained for review';end if;return new;
end$$;
do $$begin
 if to_regclass('cluera_billing_private.cancellation_commands')is not null then
 execute 'create trigger cluera_native_cancel_guard before insert on cluera_billing_private.cancellation_commands for each row execute function cluera_billing_private.native_cancel_guard()';
 end if;
end$$;

-- No activation RPC is shipped. This proposal stays disabled until independent
-- SQL/provider-method review and explicit owner acceptance. A later activation
-- migration must also install/recheck the usage bridge and cancellation guard.
do $$declare item record;begin
 for item in select oid::regprocedure signature from pg_proc where pronamespace='cluera_billing_private'::regnamespace and proname like 'native\_%'escape '\'loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',item.signature);end loop;
end$$;
revoke all on function public.cluera_billing_native_snapshot(text,uuid,text,text,bigint,jsonb),
 public.cluera_billing_native_settle(text,uuid,text,text,bigint,jsonb),public.cluera_billing_native_commit(text,uuid,text,text,bigint,jsonb,bigint,text,jsonb),
 public.cluera_billing_native_command_claim(text,bigint),public.cluera_billing_native_command_finish(uuid,uuid,text,bigint,jsonb),
 public.cluera_billing_native_command_observation(text,bigint),public.cluera_billing_native_purchase_policy(uuid,uuid,uuid,text,bigint)from public,anon,authenticated,service_role;
grant execute on function public.cluera_billing_native_snapshot(text,uuid,text,text,bigint,jsonb),
 public.cluera_billing_native_settle(text,uuid,text,text,bigint,jsonb),public.cluera_billing_native_commit(text,uuid,text,text,bigint,jsonb,bigint,text,jsonb),
 public.cluera_billing_native_command_claim(text,bigint),public.cluera_billing_native_command_finish(uuid,uuid,text,bigint,jsonb),
 public.cluera_billing_native_command_observation(text,bigint),public.cluera_billing_native_purchase_policy(uuid,uuid,uuid,text,bigint)to service_role;


-- UNAPPLIED companion to cluera-native-recurring.sql. No financial activation.
-- Installs a default-disabled usage bridge. The existing function is preserved
-- under a private name; non-native accounts execute that exact previous body.

create function cluera_billing_private.native_action(p_schedule jsonb,p_sub text,p_at bigint)returns jsonb
language plpgsql immutable security invoker set search_path=''as $$declare actions jsonb;begin
 select coalesce(jsonb_agg(v),'[]')into actions from jsonb_array_elements(p_schedule->'actions')v where v->>'subscriptionId'<>p_sub or v->>'kind'<>'RESCHEDULE';
 actions:=actions||jsonb_build_array(jsonb_build_object('key',p_sub||':RESCHEDULE:'||p_at,'subscriptionId',p_sub,'kind','RESCHEDULE','at',p_at));
 return jsonb_set(p_schedule,'{actions}',actions);
end$$;

create function cluera_billing_private.native_stop(p_schedule jsonb,p_sub text,p_at bigint)returns jsonb
language plpgsql immutable security invoker set search_path=''as $$declare v jsonb;idx integer;actions jsonb;begin
 select value,ordinality::integer-1 into strict v,idx from jsonb_array_elements(p_schedule->'subscriptions')with ordinality where value->>'subscriptionId'=p_sub;
 v:=v||jsonb_build_object('stopRequestedAt',coalesce((v->>'stopRequestedAt')::bigint,p_at),'graceUntil',null);
 p_schedule:=jsonb_set(p_schedule,array['subscriptions',idx::text],v);
 select coalesce(jsonb_agg(x),'[]')into actions from jsonb_array_elements(p_schedule->'actions')x where x->>'subscriptionId'<>p_sub or x->>'kind'<>'RESCHEDULE';
 if not exists(select 1 from jsonb_array_elements(actions)x where x->>'key'=p_sub||':CANCEL_FUTURE:end')then
 actions:=actions||jsonb_build_array(jsonb_build_object('key',p_sub||':CANCEL_FUTURE:end','subscriptionId',p_sub,'kind','CANCEL_FUTURE','at',null));end if;
 return jsonb_set(p_schedule,'{actions}',actions);
end$$;

-- Time advancement has no new invoice, allowance or provider-state input.
-- Exact expiry/resume anchors mirror the checked native TypeScript policy.
create function cluera_billing_private.native_advance(p_user uuid,p_schedule jsonb,p_at bigint)returns jsonb
language plpgsql security invoker set search_path=''as $$
declare result jsonb:=p_schedule;v jsonb;s jsonb;last_term jsonb;row_value record;idx integer;cursor_at bigint;target bigint;
 count_value integer;hold boolean;queued boolean;g uuid;active_tier boolean;begin
 select coalesce(max((x->>'closedAt')::bigint),(p_schedule->>'at')::bigint)into cursor_at from jsonb_array_elements(result->'terms')x;
 for count_value in 0..jsonb_array_length(result->'terms')loop
 select value,ordinality::integer-1 into v,idx from jsonb_array_elements(result->'terms')with ordinality where value->>'state'in('ACTIVE','SUSPENDED');
 if v is not null then
 if(v->>'endsAt')::bigint>p_at then exit;end if;
 select x into strict s from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 if s->>'state'='PAST_DUE'and s->>'stopRequestedAt'is null and(s->>'paidThrough')::bigint=(v->>'periodEnd')::bigint
 and(s->>'graceUntil')::bigint>(v->>'endsAt')::bigint then
 v:=jsonb_set(v,'{endsAt}',s->'graceUntil');result:=jsonb_set(result,array['terms',idx::text],v);
 if(v->>'endsAt')::bigint>p_at then exit;end if;end if;
 cursor_at:=(v->>'endsAt')::bigint;
 select grant_id into g from cluera_billing_private.payments where invoice_id=v->>'invoiceId'and user_id=p_user;
 if g is not null then perform public.customer_recurring_stop_grant(p_user,g,to_timestamp(cursor_at::numeric/1000));end if;
 v:=v||jsonb_build_object('state','ENDED','closedAt',cursor_at,'remainingWallMs',null);
 result:=jsonb_set(result,array['terms',idx::text],v);
 end if;
 select value,ordinality::integer-1 into v,idx from jsonb_array_elements(result->'terms')with ordinality where value->>'state'in('QUEUED','PRESERVED')
 order by case when value->>'offerCode'='cluera_monthly_200h_v2'then 0 else 1 end,case when value->>'state'='PRESERVED'then 0 else 1 end,(value->>'sequence')::bigint limit 1;
 if v is null then exit;end if;
 if v->>'offerCode'<>'cluera_monthly_200h_v2'then
 hold:=false;
 for s in select *from jsonb_array_elements(result->'subscriptions')x where x->>'offerCode'='cluera_monthly_200h_v2'loop
 select x into last_term from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=s->>'subscriptionId'order by(x->>'periodStart')::bigint desc,(x->>'sequence')::bigint desc limit 1;
 if last_term is null then continue;end if;
 if last_term->>'state'='REFUNDED'then cursor_at:=greatest(cursor_at,(last_term->>'closedAt')::bigint);continue;end if;
 if s->>'state'in('ACTIVE','PAUSED')then hold:=true;exit;
 elsif s->>'state'='PAST_DUE'then
 if s->>'graceUntil'is null or(s->>'graceUntil')::bigint>p_at then hold:=true;exit;end if;
 cursor_at:=greatest(cursor_at,(s->>'graceUntil')::bigint);
 else cursor_at:=greatest(cursor_at,(s->>'cancellationAt')::bigint);end if;
 end loop;
 if hold then exit;end if;
 end if;
 cursor_at:=greatest(cursor_at,(v->>'periodStart')::bigint);if cursor_at>p_at then exit;end if;
 queued:=v->>'state'='QUEUED';select x into strict s from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 target:=cursor_at+(v->>'remainingWallMs')::bigint;
 v:=v||jsonb_build_object('state',case when s->>'state'='PAUSED'then 'SUSPENDED'else 'ACTIVE'end,'startsAt',cursor_at,'endsAt',target,'remainingWallMs',null);
 result:=jsonb_set(result,array['terms',idx::text],v);
 if queued and s->>'stopRequestedAt'is null and target<>(v->>'periodEnd')::bigint then result:=cluera_billing_private.native_action(result,v->>'subscriptionId',target);end if;
 end loop;
 select x into v from jsonb_array_elements(result->'terms')x where x->>'state'in('ACTIVE','SUSPENDED');
 if v is not null then
 active_tier:=v->>'offerCode'='cluera_monthly_200h_v2';cursor_at:=(v->>'endsAt')::bigint;
 for row_value in select x from jsonb_array_elements(result->'terms')x where x->>'state'='QUEUED'and(x->>'offerCode'='cluera_monthly_200h_v2')=active_tier order by(x->>'sequence')::bigint loop
 cursor_at:=greatest(cursor_at,(row_value.x->>'periodStart')::bigint)+(row_value.x->>'remainingWallMs')::bigint;
 select x into strict s from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=row_value.x->>'subscriptionId';
 if s->>'stopRequestedAt'is null and s->>'subscriptionId'<>v->>'subscriptionId'then result:=cluera_billing_private.native_action(result,s->>'subscriptionId',cursor_at);end if;
 end loop;end if;
 return cluera_billing_private.native_live(p_user,result,to_timestamp(p_at::numeric/1000));
end$$;

-- Independent SQL implementation of the allowed canonical receipt transition.
-- Commit compares the ENTIRE proposed state with this result before writing.
create function cluera_billing_private.native_expected(p_user uuid,p_previous jsonb,p_evidence jsonb,p_revision uuid,p_at bigint)returns jsonb
language plpgsql security invoker set search_path=''as $$
declare result jsonb:=p_previous;v jsonb;s jsonb;old_term jsonb;active_term jsonb;next_term jsonb;item jsonb;
 r cluera_billing_private.catalog_revisions;subid text:=p_evidence->>'subscriptionId';invoice text:=p_evidence->>'invoiceId';action_value text:=p_evidence->>'action';
 subidx integer;termidx integer;activeidx integer;observed bigint;ps bigint;pe bigint;paid bigint;cutoff bigint;sequence_value bigint;remaining bigint;hold boolean;begin
 select *into strict r from cluera_billing_private.catalog_revisions where id=p_revision;
 observed:=floor(extract(epoch from(p_evidence->>'observedAt')::timestamptz)*1000)::bigint;
 cutoff:=floor(extract(epoch from(p_evidence->>'cancellationAt')::timestamptz)*1000)::bigint;
 select value,ordinality::integer-1 into s,subidx from jsonb_array_elements(result->'subscriptions')with ordinality where value->>'subscriptionId'=subid;
 if action_value='STATUS'then
 if p_evidence->>'subscriptionState'is null or s is null or observed<(s->>'observedAt')::bigint then return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if s->>'state'='CANCELED'and p_evidence->>'subscriptionState'<>'CANCELED'then raise exception 'Native terminal state requires review';end if;
 s:=s||jsonb_build_object('state',p_evidence->>'subscriptionState','observedAt',observed);
 if s->>'state'='CANCELED'then s:=s||jsonb_build_object('cancellationAt',least(coalesce((s->>'cancellationAt')::bigint,cutoff),cutoff),'graceUntil',null);
 elsif s->>'state'='PAST_DUE'and s->>'stopRequestedAt'is null then s:=jsonb_set(s,'{graceUntil}',to_jsonb(coalesce((s->>'graceUntil')::bigint,(s->>'paidThrough')::bigint+86400000)));
 else s:=jsonb_set(s,'{graceUntil}','null');end if;
 result:=jsonb_set(result,array['subscriptions',subidx::text],s);
 for item in select value||jsonb_build_object('_index',ordinality::integer-1)from jsonb_array_elements(result->'terms')with ordinality where value->>'subscriptionId'=subid loop
 termidx:=(item->>'_index')::integer;v:=item-'_index';
 if s->>'state'='PAUSED'and v->>'state'='ACTIVE'then
 if(v->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;v:=jsonb_set(v,'{state}','"SUSPENDED"');
 elsif s->>'state'='ACTIVE'and v->>'state'='SUSPENDED'then v:=jsonb_set(v,'{state}','"ACTIVE"');end if;
 result:=jsonb_set(result,array['terms',termidx::text],v);end loop;
 if s->>'state'='PAST_DUE'and(s->>'graceUntil')::bigint>p_at
 and not exists(select 1 from jsonb_array_elements(result->'terms')x where x->>'state'in('ACTIVE','SUSPENDED'))then
 select value,ordinality::integer-1 into v,termidx from jsonb_array_elements(result->'terms')with ordinality where value->>'subscriptionId'=subid order by(value->>'periodStart')::bigint desc,(value->>'sequence')::bigint desc limit 1;
 if v->>'state'='ENDED'and(v->>'periodEnd')::bigint=(s->>'paidThrough')::bigint then
 v:=v||jsonb_build_object('state','ACTIVE','startsAt',(v->>'periodStart')::bigint,'endsAt',(s->>'graceUntil')::bigint,'closedAt',null);
 result:=jsonb_set(result,array['terms',termidx::text],v);end if;end if;
 return cluera_billing_private.native_advance(p_user,result,p_at);
 end if;
 ps:=floor(extract(epoch from(p_evidence->>'periodStart')::timestamptz)*1000)::bigint;
 pe:=floor(extract(epoch from(p_evidence->>'periodEnd')::timestamptz)*1000)::bigint;
 paid:=floor(extract(epoch from(p_evidence->>'paidAt')::timestamptz)*1000)::bigint;
 select value,ordinality::integer-1 into v,termidx from jsonb_array_elements(result->'terms')with ordinality where value->>'invoiceId'=invoice;
 if v is not null then
 if action_value='GRANT'then return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 result:=cluera_billing_private.native_advance(p_user,result,p_at);
 select value,ordinality::integer-1 into strict v,termidx from jsonb_array_elements(result->'terms')with ordinality where value->>'invoiceId'=invoice;
 if v->>'state'='REFUNDED'then return result;end if;
 if(v->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 v:=v||jsonb_build_object('state','REFUNDED','remainingWallMs',null,'closedAt',p_at);result:=jsonb_set(result,array['terms',termidx::text],v);
 select value,ordinality::integer-1 into strict s,subidx from jsonb_array_elements(result->'subscriptions')with ordinality where value->>'subscriptionId'=subid;
 if(s->>'paidThrough')::bigint=(v->>'periodEnd')::bigint then result:=jsonb_set(result,array['subscriptions',subidx::text,'graceUntil'],'null');end if;
 return cluera_billing_private.native_advance(p_user,result,p_at);
 end if;
 select coalesce(max((x->>'sequence')::bigint),0)+1 into sequence_value from jsonb_array_elements(result->'terms')x;
 if action_value='GRANT'then
 select x into old_term from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=subid order by(x->>'periodStart')::bigint desc,(x->>'sequence')::bigint desc limit 1;
 if s is not null then
 if old_term is null or(old_term->>'periodEnd')::bigint<>ps or old_term->>'state'='PRESERVED'
 or(s->>'stopRequestedAt'is not null and paid>(s->>'stopRequestedAt')::bigint)or(s->>'cancellationAt'is not null and paid>(s->>'cancellationAt')::bigint)
 or(select count(*)from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=subid)>=r.total_count
 then raise exception 'Native renewal requires review';end if;
 end if;
 result:=cluera_billing_private.native_advance(p_user,result,p_at);
 select value,ordinality::integer-1 into active_term,activeidx from jsonb_array_elements(result->'terms')with ordinality where value->>'state'in('ACTIVE','SUSPENDED');
 if old_term is not null and active_term is not null and active_term->>'subscriptionId'<>subid and ps<p_at then raise exception 'Native renewal requires review';end if;
 end if;
 select value,ordinality::integer-1 into s,subidx from jsonb_array_elements(result->'subscriptions')with ordinality where value->>'subscriptionId'=subid;
 if s is null then
 s:=jsonb_build_object('subscriptionId',subid,'revisionId',r.id,'offerCode',r.offer_code,'state',coalesce(p_evidence->>'subscriptionState','ACTIVE'),
 'observedAt',observed,'paidThrough',pe,'graceUntil',null,'cancellationAt',cutoff,'stopRequestedAt',null);
 result:=jsonb_set(result,'{subscriptions}',result->'subscriptions'||jsonb_build_array(s));subidx:=jsonb_array_length(result->'subscriptions')-1;
 elsif action_value='GRANT'then
 s:=s||jsonb_build_object('paidThrough',pe,'graceUntil',null);
 if observed>=(s->>'observedAt')::bigint then
 s:=s||jsonb_build_object('state',p_evidence->>'subscriptionState','observedAt',observed);
 if cutoff is not null then s:=jsonb_set(s,'{cancellationAt}',to_jsonb(least(coalesce((s->>'cancellationAt')::bigint,cutoff),cutoff)));end if;end if;
 result:=jsonb_set(result,array['subscriptions',subidx::text],s);
 end if;
 next_term:=jsonb_build_object('invoiceId',invoice,'paymentId',p_evidence->>'paymentId','orderId',p_evidence->>'orderId','subscriptionId',subid,
 'revisionId',r.id,'offerCode',r.offer_code,'amountPaise',r.amount_paise,'grantedMs',r.allowance_seconds::bigint*1000,'spentMs',0,'reservedMs',0,
 'periodStart',ps,'periodEnd',pe,'paidAt',paid,'sequence',sequence_value,'state',case when action_value='REFUND'then 'REFUNDED'when pe<=p_at then 'ENDED'when ps>p_at then 'QUEUED'else 'ACTIVE'end,
 'startsAt',case when action_value='REFUND'or ps>p_at then null else ps end,'endsAt',case when action_value='REFUND'or ps>p_at then null else pe end,
 'remainingWallMs',case when action_value='GRANT'and ps>p_at then pe-ps else null end,'closedAt',case when action_value='REFUND'then p_at when pe<=p_at then pe else null end);
 if action_value='REFUND'then
 result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if old_term is null and pe<=p_at then result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if old_term is not null then
 if active_term is not null and active_term->>'subscriptionId'=subid and ps<=p_at then
 if(active_term->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 active_term:=active_term||jsonb_build_object('state','ENDED','closedAt',least(p_at,(active_term->>'endsAt')::bigint),'remainingWallMs',null);
 result:=jsonb_set(result,array['terms',activeidx::text],active_term);end if;
 result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if active_term is not null and active_term->>'offerCode'<>'cluera_monthly_200h_v2'and r.offer_code='cluera_monthly_200h_v2'then
 if(active_term->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 select x into strict item from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=active_term->>'subscriptionId';
 remaining:=least((active_term->>'endsAt')::bigint,(item->>'paidThrough')::bigint)-p_at;
 if remaining>0 then active_term:=active_term||jsonb_build_object('state','PRESERVED','startsAt',null,'endsAt',null,'remainingWallMs',remaining);
 else active_term:=active_term||jsonb_build_object('state','ENDED','closedAt',p_at,'remainingWallMs',null);end if;
 result:=jsonb_set(result,array['terms',activeidx::text],active_term);
 for item in select *from jsonb_array_elements(result->'subscriptions')x where x->>'offerCode'<>'cluera_monthly_200h_v2'loop result:=cluera_billing_private.native_stop(result,item->>'subscriptionId',p_at);end loop;
 else
 hold:=false;
 if r.offer_code<>'cluera_monthly_200h_v2'then
 for item in select *from jsonb_array_elements(result->'subscriptions')x where x->>'offerCode'='cluera_monthly_200h_v2'loop
 select x into v from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=item->>'subscriptionId'order by(x->>'periodStart')::bigint desc,(x->>'sequence')::bigint desc limit 1;
 if v is null or v->>'state'='REFUNDED'then continue;end if;
 if item->>'state'in('ACTIVE','PAUSED')or(item->>'state'='PAST_DUE'and(item->>'graceUntil'is null or(item->>'graceUntil')::bigint>p_at))then hold:=true;end if;
 end loop;end if;
 if active_term is not null or hold then
 next_term:=next_term||jsonb_build_object('state','QUEUED','startsAt',null,'endsAt',null,'remainingWallMs',pe-ps);
 if r.offer_code<>'cluera_monthly_200h_v2'and(active_term is null or active_term->>'offerCode'='cluera_monthly_200h_v2')then result:=cluera_billing_private.native_stop(result,subid,p_at);
 else
 for item in select *from jsonb_array_elements(result->'subscriptions')x where(x->>'offerCode'='cluera_monthly_200h_v2')=(r.offer_code='cluera_monthly_200h_v2')and x->>'subscriptionId'<>subid loop
 result:=cluera_billing_private.native_stop(result,item->>'subscriptionId',p_at);end loop;
 end if;end if;end if;
 result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));
 return cluera_billing_private.native_advance(p_user,result,p_at);
end$$;

create function cluera_billing_private.native_refresh(p_user uuid,p_at timestamptz)returns void
language plpgsql security invoker set search_path=''as $$declare s cluera_billing_private.native_schedules;previous jsonb;plan jsonb;o cluera_billing_private.processing_owner;t bigint;begin
 if p_at is null or not isfinite(p_at)or p_at>clock_timestamp()+interval '5 seconds'then raise exception 'Native clock requires review';end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 select *into strict o from cluera_billing_private.processing_owner where singleton for share;
 if o.owner<>'cluera'or o.account_digest is null then raise exception 'Native owner requires review';end if;
 select *into strict s from cluera_billing_private.native_schedules where user_id=p_user for update;
 t:=floor(extract(epoch from p_at)*1000)::bigint;if t<(s.schedule->>'at')::bigint then raise exception 'Native clock requires review';end if;
 previous:=cluera_billing_private.native_live(p_user,s.schedule,p_at);plan:=cluera_billing_private.native_advance(p_user,previous,t);
 -- Reservation settlement can change trusted spend while advancing. Refresh
 -- both sides before validating immutable counters and projecting atomically.
 previous:=cluera_billing_private.native_live(p_user,s.schedule,p_at);
 perform cluera_billing_private.native_check(p_user,previous,plan,t,null);
 if previous-'at'is distinct from plan-'at'then
 perform cluera_billing_private.native_project(p_user,plan);
 perform cluera_billing_private.native_commands(p_user,previous,plan,s.version+1,o.account_digest,o.epoch);
 update cluera_billing_private.native_schedules set schedule=plan,version=version+1,updated_at=clock_timestamp()where user_id=p_user;
 insert into cluera_billing_private.native_audit(user_id,source,before_row,after_row)values(p_user,'usage-refresh',previous,plan);
 end if;
end$$;

alter function cluera_billing_private.refresh(uuid,timestamptz)rename to refresh_pre_native;
create function cluera_billing_private.refresh(p_user uuid,p_at timestamptz)returns void
language plpgsql security invoker set search_path=''as $$begin
 -- Pausing new financial processing must not send previously funded native
 -- schedules back through the older policy or discard preserved paid time.
 if exists(select 1 from cluera_billing_private.native_schedules where user_id=p_user)then
 perform cluera_billing_private.native_refresh(p_user,p_at);
 else perform cluera_billing_private.refresh_pre_native(p_user,p_at);end if;
end$$;

-- Once a user has native state, the previous writer can never race or overwrite
-- it, even when new native processing is paused. Pack reconciliation retains its
-- exact prior path. The runtime gate routes recurring receipts to native_commit.
alter function public.cluera_billing_apply(text,uuid,text,text,bigint,jsonb)rename to cluera_billing_apply_pre_native;
create function public.cluera_billing_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)returns jsonb
language plpgsql security definer set search_path=''set timezone='UTC'set lock_timeout='2s'set statement_timeout='5s'as $$declare uid uuid;kind_value text;begin
 select i.user_id,r.kind into uid,kind_value from cluera_billing_private.intents i join cluera_billing_private.catalog_revisions r on r.id=i.revision_id where i.id::text=p_evidence->>'intentId';
 if kind_value='RECURRING'and(exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or exists(select 1 from cluera_billing_private.native_schedules where user_id=uid))then return jsonb_build_object('code','REVIEW');end if;
 return public.cluera_billing_apply_pre_native(p_event,p_claim,p_digest,p_account_digest,p_epoch,p_evidence);
end$$;
revoke all on function public.cluera_billing_apply_pre_native(text,uuid,text,text,bigint,jsonb)from public,anon,authenticated,service_role;
revoke all on function public.cluera_billing_apply(text,uuid,text,text,bigint,jsonb)from public,anon,authenticated;
grant execute on function public.cluera_billing_apply(text,uuid,text,text,bigint,jsonb)to service_role;

-- Repeat the unsupported-purchase check under the SAME account transaction as
-- intent creation. A separate web preflight alone would permit a race.
alter function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)rename to cluera_billing_prepare_pre_native;
create function public.cluera_billing_prepare(p_user uuid,p_session uuid,p_request uuid,p_revision uuid,p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare policy text;begin
 if exists(select 1 from cluera_billing_private.catalog_revisions where id=p_revision and kind='RECURRING')
 and(exists(select 1 from cluera_billing_private.native_config where singleton and enabled)or exists(select 1 from cluera_billing_private.native_schedules where user_id=p_user))then
 policy:=public.cluera_billing_native_purchase_policy(p_user,p_session,p_revision,p_account_digest,p_epoch);
 if policy<>'ALLOWED'then return jsonb_build_object('code','REVIEW');end if;
 end if;
 return public.cluera_billing_prepare_pre_native(p_user,p_session,p_request,p_revision,p_account_digest,p_epoch);
end$$;
revoke all on function public.cluera_billing_prepare_pre_native(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated,service_role;
revoke all on function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated;
grant execute on function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)to service_role;

create function cluera_billing_private.native_owner_guard()returns trigger language plpgsql security invoker set search_path=''as $$begin
 if(new.owner is distinct from old.owner or new.account_digest is distinct from old.account_digest or new.epoch is distinct from old.epoch)
 and(exists(select 1 from cluera_billing_private.native_schedules s,jsonb_array_elements(s.schedule->'terms')t where t->>'state'in('ACTIVE','SUSPENDED','QUEUED','PRESERVED'))
 or exists(select 1 from cluera_billing_private.native_outbox where state in('PENDING','CLAIMED','UNCERTAIN','ACCEPTED','REVIEW')))then raise exception 'Native paid obligations require review';end if;
 return new;
end$$;
create trigger cluera_native_owner_guard before update on cluera_billing_private.processing_owner for each row execute function cluera_billing_private.native_owner_guard();
revoke all on function cluera_billing_private.native_owner_guard()from public,anon,authenticated,service_role;

revoke all on function cluera_billing_private.native_action(jsonb,text,bigint),cluera_billing_private.native_stop(jsonb,text,bigint),
 cluera_billing_private.native_advance(uuid,jsonb,bigint),cluera_billing_private.native_expected(uuid,jsonb,jsonb,uuid,bigint),
 cluera_billing_private.native_refresh(uuid,timestamptz),cluera_billing_private.refresh_pre_native(uuid,timestamptz),cluera_billing_private.refresh(uuid,timestamptz)
 from public,anon,authenticated,service_role;


-- UNAPPLIED SELECT-only customer presentation extension. Requires the exact
-- applied customer-history migration and BOTH native financial proposals to be
-- installed first. This file neither installs nor enables financial processing.
-- Runtime separately requires CLUERA_NATIVE_RECURRING_HISTORY_ENABLED=true.

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


do $$declare r record;n bigint;h text;target_name text;begin
 for r in select *from cluera_install_preserved_rows loop
 execute format('select count(*),md5(coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),''''))from %I.%I t',
 r.schema_name,r.table_name)into n,h;
 if n<>r.row_count or h<>r.digest then raise exception 'Existing business rows changed during recurring installation';end if;
 end loop;
 for r in select *from cluera_install_preserved_functions loop
 target_name:=case when r.schema_name='public'and r.proname in('cluera_billing_apply','cluera_billing_prepare')
 then r.proname||'_pre_native' when r.schema_name='cluera_billing_private'and r.proname='refresh'
 then 'refresh_pre_native' else r.proname end;
 if not exists(select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
 where ns.nspname=r.schema_name and p.proname=target_name and pg_get_function_identity_arguments(p.oid)=r.args
 and p.prosrc=r.prosrc and p.proconfig is not distinct from r.proconfig and p.prosecdef=r.prosecdef and p.provolatile=r.provolatile)
 then raise exception 'Existing function implementation was not preserved';end if;
 end loop;
 if(select count(*)from cluera_billing_private.native_config)<>1
 or exists(select 1 from cluera_billing_private.native_config where enabled)
 or exists(select 1 from cluera_billing_private.cancellation_commands)
 or exists(select 1 from cluera_billing_private.cancellation_audit)
 or exists(select 1 from cluera_billing_private.native_schedules)
 or exists(select 1 from cluera_billing_private.native_outbox)
 or exists(select 1 from cluera_billing_private.native_audit)
 then raise exception 'Recurring installation unexpectedly activated financial state';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='cluera_billing_private'and c.relkind='r'and(not c.relrowsecurity
 or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
 then raise exception 'Recurring table privilege boundary failed';end if;
end$$;
commit;
