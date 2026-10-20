-- Source fragment for prepare-cluera-live-schema.cjs; never install separately.
-- No fallback to a Test or historical Paddle inbox/binding is permitted.
create function public.cluera_live_billing_event_accept(p_event jsonb,p_account_digest text)returns text
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare e cluera_live_billing_private.events;occurred timestamptz;begin
 if not exists(select 1 from cluera_live_billing_private.processing_owner where singleton and owner='cluera'and account_digest=p_account_digest)
 then return 'UNAVAILABLE';end if;
 if jsonb_typeof(p_event)is distinct from 'object'
 or(p_event-array['eventId','eventType','resourceId','paymentId','orderId','subscriptionId','invoiceId','digest','occurredAt'])<>'{}'::jsonb
 or p_event->>'eventId'is null or p_event->>'digest'is null or p_event->>'resourceId'is null then return 'INVALID';end if;
 begin occurred:=(p_event->>'occurredAt')::timestamptz;exception when others then return 'INVALID';end;
 if occurred is null or not isfinite(occurred)then return 'INVALID';end if;
 insert into cluera_live_billing_private.events(event_id,account_digest,event_type,resource_id,payment_id,order_id,subscription_id,invoice_id,digest,occurred_at)
 values(p_event->>'eventId',p_account_digest,p_event->>'eventType',p_event->>'resourceId',p_event->>'paymentId',p_event->>'orderId',
 p_event->>'subscriptionId',p_event->>'invoiceId',p_event->>'digest',occurred)on conflict do nothing;
 if found then return 'STORED';end if;
 select *into strict e from cluera_live_billing_private.events where event_id=p_event->>'eventId'for update;
 if e.account_digest<>p_account_digest or e.event_type is distinct from p_event->>'eventType'or e.resource_id is distinct from p_event->>'resourceId'
 or e.payment_id is distinct from p_event->>'paymentId'or e.order_id is distinct from p_event->>'orderId'
 or e.subscription_id is distinct from p_event->>'subscriptionId'or e.invoice_id is distinct from p_event->>'invoiceId'
 or e.digest is distinct from p_event->>'digest'or e.occurred_at is distinct from occurred then
 update cluera_live_billing_private.events set state='QUARANTINED'where event_id=e.event_id;return 'CONFLICT';end if;
 return case when e.state='QUARANTINED'then 'CONFLICT'else 'DUPLICATE'end;
end$$;
create function public.cluera_live_billing_event_claim(p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare e cluera_live_billing_private.events;c uuid:=gen_random_uuid();begin
 if p_epoch is null or cluera_live_billing_private.owns(p_account_digest,'cluera',p_epoch)is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 select *into e from cluera_live_billing_private.events where account_digest=p_account_digest and state='PENDING'
 and retry_at<=clock_timestamp()and(lease_until is null or lease_until<clock_timestamp())and attempts<20
 order by received_at,event_id limit 1 for update skip locked;
 if not found then return jsonb_build_object('code','EMPTY');end if;
 update cluera_live_billing_private.events set claim_id=c,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 where event_id=e.event_id;
 return jsonb_build_object('code','CLAIMED','legacy',false,'eventId',e.event_id,'claimId',c,'eventType',e.event_type,
 'resourceId',e.resource_id,'paymentId',e.payment_id,'orderId',e.order_id,'subscriptionId',e.subscription_id,
 'invoiceId',e.invoice_id,'digest',e.digest,'occurredAt',e.occurred_at);
end$$;
create function public.cluera_live_billing_event_finish(p_event text,p_claim uuid,p_epoch bigint,p_retry boolean)returns text
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare d text;begin
 if p_claim is null or p_epoch is null or p_retry is distinct from true then return 'INVALID';end if;
 select account_digest into d from cluera_live_billing_private.events where event_id=p_event;
 if not found or cluera_live_billing_private.owns(d,'cluera',p_epoch)is not true then return 'UNAVAILABLE';end if;
 update cluera_live_billing_private.events set claim_id=null,lease_until=null,retry_at=clock_timestamp()+interval '1 minute'
 where event_id=p_event and claim_id=p_claim and state='PENDING';
 return case when found then 'PENDING'else 'CONFLICT'end;
end$$;
create function public.cluera_live_billing_status(p_user uuid,p_session uuid)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare a jsonb;pending jsonb;orders jsonb;subscriptions jsonb;begin
 a:=public.customer_authorize(p_user,p_session);if a->>'code'is distinct from 'ACTIVE'then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code'is distinct from 'ACTIVE'then return jsonb_build_object('code',a->>'code');end if;
 select jsonb_build_object('legacy',false,'intentId',i.id,'state',i.state,'kind',r.kind,'revisionId',r.id,'offerCode',r.offer_code,
 'orderId',i.order_id,'subscriptionId',i.subscription_id)into pending
 from cluera_live_billing_private.intents i join cluera_live_billing_private.catalog_revisions r on r.id=i.revision_id
 where i.user_id=p_user and i.state in('CREATING','BOUND','UNCERTAIN')order by i.created_at,i.id limit 1;
 select coalesce(jsonb_agg(order_id order by created_at desc),'[]')into orders from(
 select order_id,created_at from cluera_live_billing_private.intents where user_id=p_user and state in('VERIFIED','REFUNDED')
 and order_id is not null order by created_at desc limit 50)q;
 select coalesce(jsonb_agg(subscription_id order by created_at desc),'[]')into subscriptions from(
 select subscription_id,created_at from cluera_live_billing_private.intents where user_id=p_user and state in('VERIFIED','REFUNDED')
 and subscription_id is not null order by created_at desc limit 50)q;
 return jsonb_build_object('code',case when pending is null then 'AVAILABLE'else 'PENDING'end,
 'userId',p_user,'pending',pending,'resolvedOrderIds',orders,'resolvedSubscriptionIds',subscriptions);
end$$;
