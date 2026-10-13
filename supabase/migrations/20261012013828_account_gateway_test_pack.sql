-- Additive Account staging only. No Paddle row/audit is rewritten or removed.
-- Provider identities stay separate; all paid time uses the EXISTING shared ledger.
create table billing_private.payment_intents (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.customer_accounts(user_id),
 provider text not null check(provider in ('razorpay','stripe','paddle')), environment text not null check(environment='test'),
 account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'), request_id uuid not null, attempt_id uuid not null default gen_random_uuid(),
 offer_code text not null check(offer_code='pro_3_hours'), amount integer not null default 54900 check(amount=54900),
 currency text not null default 'INR' check(currency='INR'),
 state text not null check(state in ('CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED')),
 order_id text check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'), payment_id text check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),
 grant_id uuid, created_at timestamptz not null default clock_timestamp(),
 unique(provider,environment,user_id,request_id), unique(provider,environment,order_id), unique(provider,environment,payment_id),
 foreign key(user_id,grant_id) references public.customer_usage_grants(user_id,id),
 check(state not in ('BOUND','VERIFIED','REFUNDED') or order_id is not null),
 check(state<>'VERIFIED' or (payment_id is not null and grant_id is not null))
);
create unique index payment_one_unresolved on billing_private.payment_intents(user_id)
 where state in ('CREATING','BOUND','UNCERTAIN');
create index payment_intents_owner on billing_private.payment_intents(user_id,created_at desc,id);
create table billing_private.payment_events (
 provider text not null check(provider='razorpay'), environment text not null check(environment='test'),
 event_id text not null check(event_id ~ '^[A-Za-z0-9_-]{8,128}$'), account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'),
 event_type text not null check(event_type in ('payment.captured','order.paid','refund.processed')),
 resource_id text not null, payment_id text not null check(payment_id ~ '^pay_[A-Za-z0-9]{8,64}$'),
 order_id text check(order_id ~ '^order_[A-Za-z0-9]{8,64}$'), digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz not null check(isfinite(occurred_at)), received_at timestamptz not null default clock_timestamp(),
 state text not null default 'PENDING' check(state in ('PENDING','PROCESSED','QUARANTINED')),
 claim_id uuid, lease_until timestamptz, retry_at timestamptz not null default clock_timestamp(), attempts integer not null default 0,
 primary key(provider,environment,event_id)
);
create index payment_events_due on billing_private.payment_events(retry_at,received_at) where state='PENDING';
create table billing_private.payment_applications (
 provider text not null, environment text not null, event_id text not null,
 intent_id uuid not null references billing_private.payment_intents(id), action text not null check(action in ('GRANT','REFUND')),
 payment_id text not null, refund_id text, removed_ms bigint not null default 0 check(removed_ms>=0),
 evidence jsonb not null, before_row jsonb not null, after_row jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
 primary key(provider,environment,event_id),
 foreign key(provider,environment,event_id) references billing_private.payment_events(provider,environment,event_id)
);
create index payment_applications_intent on billing_private.payment_applications(intent_id,recorded_at);
create table billing_private.payment_diagnostics (
 id uuid primary key default gen_random_uuid(),intent_id uuid not null references billing_private.payment_intents(id),
 stage text not null check(stage in ('provider_request','binding','identity')),http_status integer check(http_status between 100 and 599),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table billing_private.payment_intents enable row level security;
alter table billing_private.payment_events enable row level security;
alter table billing_private.payment_applications enable row level security;
alter table billing_private.payment_diagnostics enable row level security;
revoke all on billing_private.payment_intents,billing_private.payment_events,billing_private.payment_applications from public,anon,authenticated,service_role;
revoke all on billing_private.payment_diagnostics from public,anon,authenticated,service_role;
create trigger payment_applications_immutable before update or delete or truncate on billing_private.payment_applications
 for each statement execute function billing_private.reject_checkout_audit_mutation();
alter table billing_private.payment_applications enable always trigger payment_applications_immutable;
create trigger payment_diagnostics_immutable before update or delete or truncate on billing_private.payment_diagnostics
 for each statement execute function billing_private.reject_checkout_audit_mutation();
alter table billing_private.payment_diagnostics enable always trigger payment_diagnostics_immutable;

create function public.account_payment_status(p_user uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; pending jsonb; history jsonb; resolved jsonb;
begin
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 select jsonb_build_object('id',id,'state',state,'offerCode',offer_code,'orderId',order_id) into pending
 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN') limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('offerCode',offer_code,'state',state,'createdAt',created_at) order by created_at desc),'[]') into history
 from (select * from billing_private.payment_intents where user_id=p_user order by created_at desc,id limit 10) h;
 select coalesce(jsonb_agg(order_id),'[]') into resolved from (select order_id from billing_private.payment_intents
  where user_id=p_user and state in ('VERIFIED','REFUNDED') order by created_at desc,id limit 50) r;
 return jsonb_build_object('code',case when pending is null then 'AVAILABLE' else 'PENDING' end,'userId',p_user,'pending',pending,'history',history,'resolvedOrderIds',resolved);
end $$;

create function public.account_payment_prepare(p_user uuid,p_session uuid,p_request uuid,p_account_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare a jsonb; i billing_private.payment_intents%rowtype;
begin
 if p_request is null or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('code','INVALID'); end if;
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);
 if a->>'code'<>'ACTIVE' then return jsonb_build_object('code',a->>'code'); end if;
 select * into i from billing_private.payment_intents where provider='razorpay' and environment='test' and user_id=p_user and request_id=p_request;
 if found then
  if i.account_digest<>p_account_digest then return jsonb_build_object('code','PENDING'); end if;
  return jsonb_build_object('code',i.state,'intentId',i.id,'orderId',i.order_id);
 end if;
 -- Old Paddle draft is quarantined by the disabled adapter, not deleted/recovered.
 -- A different gateway cannot bypass ANY unresolved new service operation.
 if exists(select 1 from billing_private.payment_intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN')) then return jsonb_build_object('code','PENDING'); end if;
 if not exists(select 1 from public.account_catalog_policy where offer_code='pro_3_hours' and enabled) then return jsonb_build_object('code','DISABLED'); end if;
 if (select count(*) from billing_private.payment_intents where user_id=p_user and created_at>clock_timestamp()-interval '1 hour')>=5 then return jsonb_build_object('code','RATE_LIMITED'); end if;
 insert into billing_private.payment_intents(user_id,provider,environment,account_digest,request_id,offer_code,state)
 values(p_user,'razorpay','test',p_account_digest,p_request,'pro_3_hours','CREATING') returning * into i;
 return jsonb_build_object('code','CLAIMED','intentId',i.id,'attemptId',i.attempt_id);
end $$;

create function public.account_payment_bind(p_intent uuid,p_attempt uuid,p_account_digest text,p_order text,p_diagnostic jsonb default '{}')
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i billing_private.payment_intents%rowtype; owner_id uuid;
begin
 select user_id into owner_id from billing_private.payment_intents where id=p_intent;
 if not found then return 'UNBOUND'; end if;
 perform 1 from public.customer_accounts where user_id=owner_id for update;
 select * into i from billing_private.payment_intents where id=p_intent for update;
 if i.attempt_id is distinct from p_attempt or i.account_digest is distinct from p_account_digest or i.provider<>'razorpay' then return 'CONFLICT'; end if;
 if p_diagnostic<>'{}'::jsonb then
  if jsonb_typeof(p_diagnostic)<>'object' or (p_diagnostic-array['stage','httpStatus'])<>'{}'::jsonb
   or p_diagnostic->>'stage' is null or p_diagnostic->>'stage' not in ('provider_request','binding','identity')
   or (p_diagnostic ? 'httpStatus' and (p_diagnostic->>'httpStatus')::integer not between 100 and 599) then return 'INVALID'; end if;
  insert into billing_private.payment_diagnostics(intent_id,stage,http_status)
  values(i.id,p_diagnostic->>'stage',(p_diagnostic->>'httpStatus')::integer);
 end if;
 if i.state<>'CREATING' then return i.state; end if;
 if p_order is null then
  update billing_private.payment_intents set state='UNCERTAIN' where id=i.id; return 'UNCERTAIN';
 end if;
 if p_order !~ '^order_[A-Za-z0-9]{8,64}$' then return 'INVALID'; end if;
 update billing_private.payment_intents set state='BOUND',order_id=p_order where id=i.id;
 return 'BOUND';
end $$;

create function public.account_payment_binding(p_order text,p_account_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i billing_private.payment_intents%rowtype;
begin
 select * into i from billing_private.payment_intents where provider='razorpay' and environment='test' and order_id=p_order and account_digest=p_account_digest;
 if not found then return jsonb_build_object('code','UNBOUND'); end if;
 return jsonb_build_object('code',i.state,'intentId',i.id,'userId',i.user_id,'orderId',i.order_id,'offerCode',i.offer_code);
end $$;

create function public.account_payment_receive(p_event jsonb,p_account_digest text)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e billing_private.payment_events%rowtype;
begin
 if p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_event)<>'object' then return 'INVALID'; end if;
 insert into billing_private.payment_events(provider,environment,event_id,account_digest,event_type,resource_id,payment_id,order_id,digest,occurred_at)
 values('razorpay','test',p_event->>'eventId',p_account_digest,p_event->>'eventType',p_event->>'resourceId',p_event->>'paymentId',p_event->>'orderId',p_event->>'digest',(p_event->>'occurredAt')::timestamptz)
 on conflict do nothing;
 if found then return 'STORED'; end if;
 select * into strict e from billing_private.payment_events where provider='razorpay' and environment='test' and event_id=p_event->>'eventId' for update;
 if e.digest is distinct from p_event->>'digest' or e.account_digest<>p_account_digest
 or e.event_type is distinct from p_event->>'eventType' or e.resource_id is distinct from p_event->>'resourceId'
 or e.payment_id is distinct from p_event->>'paymentId' or e.order_id is distinct from p_event->>'orderId'
 or e.occurred_at is distinct from (p_event->>'occurredAt')::timestamptz then
  update billing_private.payment_events set state='QUARANTINED' where provider=e.provider and environment=e.environment and event_id=e.event_id;
  return 'CONFLICT';
 end if;
 return case when e.state='QUARANTINED' then 'CONFLICT' else 'DUPLICATE' end;
end $$;

create function public.account_payment_claim(p_account_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare e billing_private.payment_events%rowtype; claim uuid:=gen_random_uuid();
begin
 select * into e from billing_private.payment_events where account_digest=p_account_digest and state='PENDING'
 and retry_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp()) and attempts<20
 order by received_at,event_id limit 1 for update skip locked;
 if not found then return jsonb_build_object('code','EMPTY'); end if;
 update billing_private.payment_events set claim_id=claim,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1
 where provider=e.provider and environment=e.environment and event_id=e.event_id;
 return jsonb_build_object('code','CLAIMED','eventId',e.event_id,'eventType',e.event_type,'resourceId',e.resource_id,
 'paymentId',e.payment_id,'orderId',e.order_id,'digest',e.digest,'claimId',claim);
end $$;

create function public.account_payment_retry(p_event text,p_claim uuid)
returns text language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
begin
 update billing_private.payment_events set claim_id=null,lease_until=null,retry_at=clock_timestamp()+interval '1 minute'
 where event_id=p_event and claim_id=p_claim and state='PENDING';
 return case when found then 'PENDING' else 'CONFLICT' end;
end $$;

create function public.account_payment_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare i billing_private.payment_intents%rowtype; e billing_private.payment_events%rowtype;
 before_value jsonb; grant_value uuid; removed bigint:=0; t timestamptz:=date_trunc('milliseconds',clock_timestamp()); action_value text:=p_evidence->>'action';
begin
 if jsonb_typeof(p_evidence) is distinct from 'object'
 or (p_evidence-array['action','intentId','orderId','paymentId','amount','currency','observedAt','refundId'])<>'{}'::jsonb
 or p_event is null or p_claim is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
 or p_account_digest is null or p_account_digest !~ '^[a-f0-9]{64}$'
 or p_evidence->>'observedAt' is null or p_evidence->>'paymentId' is null
 or action_value is null or action_value not in ('GRANT','REFUND') or p_evidence->>'amount' is distinct from '54900'
 or p_evidence->>'currency' is distinct from 'INR' or p_evidence->>'paymentId' !~ '^pay_[A-Za-z0-9]{8,64}$'
 or (p_evidence->>'observedAt')::timestamptz<t-interval '2 minutes' or (p_evidence->>'observedAt')::timestamptz>t+interval '5 seconds' then return jsonb_build_object('code','INVALID'); end if;
 select * into i from billing_private.payment_intents where id=(p_evidence->>'intentId')::uuid and provider='razorpay' and environment='test';
 if not found then return jsonb_build_object('code','UNBOUND'); end if;
 perform 1 from public.customer_accounts where user_id=i.user_id for update;
 select * into strict i from billing_private.payment_intents where id=i.id for update;
 select * into e from billing_private.payment_events where provider='razorpay' and environment='test' and event_id=p_event for update;
 if not found or e.state<>'PENDING' or e.claim_id is null or e.claim_id is distinct from p_claim or e.lease_until is null or e.lease_until<=t or e.digest<>p_digest
 or e.account_digest<>p_account_digest or i.account_digest<>p_account_digest or i.order_id is distinct from p_evidence->>'orderId'
 or e.payment_id is distinct from p_evidence->>'paymentId' or (e.order_id is not null and e.order_id<>i.order_id)
 or i.state not in ('BOUND','VERIFIED','REFUNDED')
 or (i.payment_id is not null and i.payment_id<>p_evidence->>'paymentId') then return jsonb_build_object('code','CONFLICT'); end if;
 if action_value='GRANT' and (e.event_type not in ('payment.captured','order.paid') or p_evidence->>'refundId' is not null)
 or action_value='REFUND' and (e.event_type<>'refund.processed' or e.resource_id is distinct from p_evidence->>'refundId') then return jsonb_build_object('code','INVALID'); end if;
 before_value:=to_jsonb(i);
 if action_value='GRANT' and i.state='BOUND' then
  if not exists(select 1 from public.customer_accounts a join auth.users u on u.id=a.user_id
   where a.user_id=i.user_id and a.state='ACTIVE' and u.email is not null and u.email_confirmed_at is not null) then return jsonb_build_object('code','PENDING'); end if;
  insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at)
  values(i.user_id,'razorpay-test:'||i.order_id,'PACK',10800000,t) returning id into grant_value;
  update billing_private.payment_intents set state='VERIFIED',grant_id=grant_value,payment_id=p_evidence->>'paymentId' where id=i.id;
 elsif action_value='REFUND' and i.state<>'REFUNDED' then
  if i.grant_id is not null then
   perform public.customer_recurring_stop_grant(i.user_id,i.grant_id,t);
   if exists(select 1 from public.customer_usage_grants where id=i.grant_id and reserved_ms<>0) then raise exception 'Refund settlement incomplete'; end if;
   select granted_ms-spent_ms into removed from public.customer_usage_grants where id=i.grant_id;
   update public.customer_usage_grants set state='REVOKED' where id=i.grant_id;
  end if;
  -- Full refund before completion is a tombstone; late captures cannot resurrect it.
  update billing_private.payment_intents set state='REFUNDED',payment_id=p_evidence->>'paymentId' where id=i.id;
 end if;
 insert into billing_private.payment_applications(provider,environment,event_id,intent_id,action,payment_id,refund_id,removed_ms,evidence,before_row,after_row)
 select 'razorpay','test',e.event_id,i.id,action_value,p_evidence->>'paymentId',p_evidence->>'refundId',removed,p_evidence,before_value,to_jsonb(x)
 from billing_private.payment_intents x where x.id=i.id;
 update billing_private.payment_events set state='PROCESSED',claim_id=null,lease_until=null where provider=e.provider and environment=e.environment and event_id=e.event_id;
 return jsonb_build_object('code',(select state from billing_private.payment_intents where id=i.id));
end $$;

-- Preserve the strict desktop contract; old histories remain, new gateway rows
-- join only the ten-row reporting projection. Balance already reads shared grants.
alter function public.customer_credits_read(uuid,uuid) rename to customer_credits_read_paddle_base;
revoke all on function public.customer_credits_read_paddle_base(uuid,uuid) from public,anon,authenticated,service_role;
create function public.customer_credits_read(p_user uuid,p_session uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare base jsonb; history jsonb;
begin
 base:=public.customer_credits_read_paddle_base(p_user,p_session);
 if base->>'userId' is distinct from p_user::text then return base; end if;
 select coalesce(jsonb_agg(value order by created desc),'[]') into history from (
  select value,(value->>'createdAt')::timestamptz created from jsonb_array_elements(base->'payments')
  union all select jsonb_build_object('offerCode',offer_code,'state',state,'createdAt',created_at),created_at
  from billing_private.payment_intents where user_id=p_user
  order by created desc limit 10
 ) h;
 return jsonb_set(base,'{payments}',history);
end $$;

revoke all on function public.account_payment_status(uuid,uuid),public.account_payment_prepare(uuid,uuid,uuid,text),
 public.account_payment_bind(uuid,uuid,text,text,jsonb),public.account_payment_binding(text,text),public.account_payment_receive(jsonb,text),
 public.account_payment_claim(text),public.account_payment_retry(text,uuid),public.account_payment_apply(text,uuid,text,text,jsonb),
 public.customer_credits_read(uuid,uuid) from public,anon,authenticated;
grant execute on function public.account_payment_status(uuid,uuid),public.account_payment_prepare(uuid,uuid,uuid,text),
 public.account_payment_bind(uuid,uuid,text,text,jsonb),public.account_payment_binding(text,text),public.account_payment_receive(jsonb,text),
 public.account_payment_claim(text),public.account_payment_retry(text,uuid),public.account_payment_apply(text,uuid,text,text,jsonb),
 public.customer_credits_read(uuid,uuid) to service_role;

-- Existing scheduler, secret and destination are retained. New durable gateway
-- work joins its wake condition; no new provider call or cron is executed here.
create or replace function billing_private.wake_worker() returns void language plpgsql set search_path='' as $$
declare cfg billing_private.worker_config%rowtype; credential text; request_id bigint; t timestamptz:=clock_timestamp();
begin
 select * into cfg from billing_private.worker_config where singleton for update;
 if not cfg.enabled or cfg.secret_id is null then return; end if;
 if cfg.last_sent_at is not null and cfg.last_sent_at>t-interval '55 seconds' then return; end if;
 if cfg.last_sent_at>t-interval '15 minutes'
 and not exists(select 1 from public.customer_billing_jobs where state in ('READY','RUNNING') and available_at<=t)
 and not exists(select 1 from public.customer_billing_outbox where state in ('READY','RUNNING') and available_at<=t)
 and not exists(select 1 from billing_private.payment_events where state='PENDING' and retry_at<=t and attempts<20
   and (lease_until is null or lease_until<t)) then return; end if;
 select decrypted_secret into credential from vault.decrypted_secrets where id=cfg.secret_id;
 if credential is null then return; end if;
 request_id:=net.http_post(url:='https://sigmaround-account-staging.vercel.app/api/internal/billing/tick',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||credential),body:='{}'::jsonb,timeout_milliseconds:=170000);
 update billing_private.worker_config set last_sent_at=t,last_request_id=request_id where singleton;
end $$;
revoke all on function billing_private.wake_worker() from public,anon,authenticated,service_role;
