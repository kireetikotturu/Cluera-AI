-- A customer who closes the payment window and tries again a few times must not be locked out for an hour.
-- The hourly cap on new checkout attempts goes from 5 to 12. Nothing else in this function changes.
begin;
CREATE OR REPLACE FUNCTION public.cluera_live_billing_prepare_pre_native(p_user uuid, p_session uuid, p_request uuid, p_revision uuid, p_account_digest text, p_epoch bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '5s'
AS $function$
declare a jsonb;i cluera_live_billing_private.intents;r cluera_live_billing_private.catalog_revisions;rev jsonb;begin
 if p_epoch is null or p_request is null or p_revision is null or cluera_live_billing_private.owns(p_account_digest,'cluera',p_epoch) is not true then return jsonb_build_object('code','UNAVAILABLE');end if;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 a:=public.customer_authorize(p_user,p_session);if a->>'code' is distinct from 'ACTIVE' then return jsonb_build_object('code',a->>'code');end if;
 select * into i from cluera_live_billing_private.intents where user_id=p_user and request_id=p_request;
 if found then
 if i.revision_id<>p_revision or i.account_digest<>p_account_digest then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code',i.state,'intentId',i.id,'orderId',i.order_id,'subscriptionId',i.subscription_id);end if;
 -- Fence concurrent Admin revision/disable while taking the immutable checkout
 -- snapshot; no network request occurs under this short shared-head lock.
 perform 1 from cluera_live_billing_private.catalog_heads where revision_id=p_revision and enabled for share;
 if not found then return jsonb_build_object('code','DISABLED');end if;
 select * into strict r from cluera_live_billing_private.catalog_revisions where id=p_revision;
 if exists(select 1 from cluera_live_billing_private.intents where user_id=p_user and state in ('CREATING','BOUND','UNCERTAIN'))
 or false then return jsonb_build_object('code','PENDING');end if;
 if r.kind='RECURRING' and (false
 or exists(select 1 from cluera_live_billing_private.subscriptions where user_id=p_user and not cancel_future and state in ('ACTIVE','PAST_DUE','PAUSED'))
 or exists(select 1 from cluera_live_billing_private.terms where user_id=p_user and state in ('ACTIVE','QUEUED','PAUSED') and ends_at>clock_timestamp())) then return jsonb_build_object('code','COMPETING_SUBSCRIPTION');end if;
 if r.kind='RECURRING' and not exists(select 1 from cluera_live_billing_private.plan_verifications where revision_id=r.id and account_digest=p_account_digest) then return jsonb_build_object('code','PLAN_UNVERIFIED');end if;
 if (select count(*) from cluera_live_billing_private.intents where user_id=p_user and created_at>clock_timestamp()-interval '1 hour')>=12 then return jsonb_build_object('code','RATE_LIMITED');end if;
 insert into cluera_live_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state) values(p_user,p_request,r.id,p_account_digest,p_epoch,'CREATING') returning * into i;
 select value into rev from jsonb_array_elements(public.cluera_live_billing_catalog()) where value->>'revisionId'=r.id::text;
 return jsonb_build_object('code','CLAIMED','intentId',i.id,'attemptId',i.attempt_id,'revision',rev);
end$function$;
commit;
