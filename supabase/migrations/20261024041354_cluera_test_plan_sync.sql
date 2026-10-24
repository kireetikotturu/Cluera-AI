-- Additive Test-only plan template synchronization. No catalog activation or financial writes.
create table cluera_billing_private.plan_sync_operations (
 operation_id uuid primary key,
 actor_id uuid not null references public.account_admin_profiles(user_id),
 session_id uuid not null, offer_code text not null,
 expected_revision uuid not null references cluera_billing_private.catalog_revisions(id),
 account_digest text not null check(account_digest ~ '^[a-f0-9]{64}$'), epoch bigint not null check(epoch>0),
 input jsonb not null, reason text not null check(length(trim(reason)) between 10 and 500),
 state text not null default 'CLAIMED' check(state in ('CLAIMED','BOUND','APPLIED')),
 razorpay_plan_id text unique check(razorpay_plan_id ~ '^plan_[A-Za-z0-9]{8,64}$'), result jsonb,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check((state='CLAIMED' and razorpay_plan_id is null and result is null)
   or(state='BOUND' and razorpay_plan_id is not null and result is null)
   or(state='APPLIED' and razorpay_plan_id is not null and result is not null))
);
create unique index plan_sync_one_unresolved_offer on cluera_billing_private.plan_sync_operations(offer_code) where state<>'APPLIED';
create index plan_sync_actor on cluera_billing_private.plan_sync_operations(actor_id,created_at);
create index plan_sync_revision on cluera_billing_private.plan_sync_operations(expected_revision);
alter table cluera_billing_private.plan_sync_operations enable row level security;
revoke all on cluera_billing_private.plan_sync_operations from public,anon,authenticated,service_role;

create function cluera_billing_private.plan_sync_authorized(p_actor uuid,p_session uuid,p_reauthenticated_at timestamptz,p_account_digest text,p_epoch bigint)
returns boolean language sql set search_path='' as $$
 select public.account_admin_check(p_actor,p_session,true) is true
 and p_reauthenticated_at is not null and isfinite(p_reauthenticated_at)
 and p_reauthenticated_at between clock_timestamp()-interval '2 minutes' and clock_timestamp()+interval '5 seconds'
 and exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera'
   and account_digest=p_account_digest and epoch=p_epoch)
$$;
revoke all on function cluera_billing_private.plan_sync_authorized(uuid,uuid,timestamptz,text,bigint) from public,anon,authenticated,service_role;

create function public.cluera_billing_plan_sync_read(p_actor uuid,p_session uuid,p_operation uuid default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare op cluera_billing_private.plan_sync_operations; value jsonb;begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null then
   select coalesce(jsonb_agg(jsonb_build_object('operationId',operation_id,'offerCode',offer_code,'expectedRevisionId',expected_revision,
     'state',state,'input',input,'reason',reason,'razorpayPlanId',razorpay_plan_id) order by created_at),'[]') into value
     from cluera_billing_private.plan_sync_operations where actor_id=p_actor and state<>'APPLIED';
   return jsonb_build_object('code','ACTIVE','catalog',public.cluera_billing_catalog(),'operations',value);
 end if;
 select * into op from cluera_billing_private.plan_sync_operations where operation_id=p_operation and actor_id=p_actor;
 if not found then return jsonb_build_object('code','NOT_FOUND');end if;
 if op.state='APPLIED' then return jsonb_build_object('code','APPLIED','revision',op.result);end if;
 return jsonb_build_object('code','PENDING','operation',jsonb_build_object('operationId',op.operation_id,'offerCode',op.offer_code,
   'expectedRevisionId',op.expected_revision,'state',op.state,'input',op.input,'reason',op.reason,'razorpayPlanId',op.razorpay_plan_id));
end$$;

create function public.cluera_billing_plan_sync_claim(p_actor uuid,p_session uuid,p_reauthenticated_at timestamptz,p_operation uuid,
 p_account_digest text,p_epoch bigint,p_offer text,p_expected_revision uuid,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare r cluera_billing_private.catalog_revisions;begin
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform 1 from cluera_billing_private.processing_owner where singleton for share;
 if cluera_billing_private.plan_sync_authorized(p_actor,p_session,p_reauthenticated_at,p_account_digest,p_epoch) is not true
 then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null or p_expected_revision is null or p_reason is null or length(trim(p_reason)) not between 10 and 500
 or jsonb_typeof(p_input) is distinct from 'object' or (p_input-array['name','amountPaise','allowanceSeconds','totalCount'])<>'{}'::jsonb
 or jsonb_typeof(p_input->'name') is distinct from 'string' or length(trim(p_input->>'name')) not between 2 and 80
 or jsonb_typeof(p_input->'amountPaise') is distinct from 'number' or coalesce(p_input->>'amountPaise','') !~ '^[0-9]{3,8}$'
 or jsonb_typeof(p_input->'allowanceSeconds') is distinct from 'number' or coalesce(p_input->>'allowanceSeconds','') !~ '^[0-9]{2,7}$'
 or jsonb_typeof(p_input->'totalCount') is distinct from 'number' or coalesce(p_input->>'totalCount','') !~ '^[0-9]{1,3}$'
 then return jsonb_build_object('code','INVALID');end if;
 if (p_input->>'amountPaise')::integer not between 100 and 10000000
 or (p_input->>'allowanceSeconds')::integer not between 60 and 3600000 or (p_input->>'totalCount')::integer not between 1 and 120
 then return jsonb_build_object('code','INVALID');end if;
 -- Head serialization plus the partial unique index also fences different operation IDs/admins.
 perform 1 from cluera_billing_private.catalog_heads where offer_code=p_offer and revision_id=p_expected_revision for update;
 if not found then return jsonb_build_object('code','CONFLICT');end if;
 select * into r from cluera_billing_private.catalog_revisions where id=p_expected_revision and offer_code=p_offer;
 if not found or r.kind<>'RECURRING' then return jsonb_build_object('code','INVALID');end if;
 if r.razorpay_plan_id is not null and r.name=trim(p_input->>'name') and r.amount_paise=(p_input->>'amountPaise')::integer
 and r.allowance_seconds=(p_input->>'allowanceSeconds')::integer and r.total_count=(p_input->>'totalCount')::integer
 then return jsonb_build_object('code','ALREADY_MAPPED');end if;
 if exists(select 1 from cluera_billing_private.plan_sync_operations where operation_id=p_operation or (offer_code=p_offer and state<>'APPLIED'))
 or exists(select 1 from cluera_billing_private.admin_audit where operation_id=p_operation)
 then return jsonb_build_object('code','PENDING');end if;
 insert into cluera_billing_private.plan_sync_operations(operation_id,actor_id,session_id,offer_code,expected_revision,account_digest,epoch,input,reason)
 values(p_operation,p_actor,p_session,p_offer,p_expected_revision,p_account_digest,p_epoch,p_input,trim(p_reason));
 return jsonb_build_object('code','CLAIMED');
end$$;

create function public.cluera_billing_plan_sync_bind(p_actor uuid,p_session uuid,p_reauthenticated_at timestamptz,p_operation uuid,
 p_account_digest text,p_epoch bigint,p_plan text) returns text
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare op cluera_billing_private.plan_sync_operations;begin
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform 1 from cluera_billing_private.processing_owner where singleton for share;
 if cluera_billing_private.plan_sync_authorized(p_actor,p_session,p_reauthenticated_at,p_account_digest,p_epoch) is not true then return 'FORBIDDEN';end if;
 if p_plan is null or p_plan !~ '^plan_[A-Za-z0-9]{8,64}$' then return 'INVALID';end if;
 select * into op from cluera_billing_private.plan_sync_operations where operation_id=p_operation and actor_id=p_actor
 and account_digest=p_account_digest and epoch=p_epoch for update;
 if not found or op.state='APPLIED' or (op.razorpay_plan_id is not null and op.razorpay_plan_id<>p_plan) then return 'CONFLICT';end if;
 update cluera_billing_private.plan_sync_operations set state='BOUND',razorpay_plan_id=p_plan,updated_at=clock_timestamp() where operation_id=p_operation;
 return 'BOUND';
end$$;

create function public.cluera_billing_plan_sync_finish(p_actor uuid,p_session uuid,p_reauthenticated_at timestamptz,p_operation uuid,
 p_account_digest text,p_epoch bigint,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare op cluera_billing_private.plan_sync_operations; value jsonb; rid uuid;begin
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform 1 from cluera_billing_private.processing_owner where singleton for share;
 if cluera_billing_private.plan_sync_authorized(p_actor,p_session,p_reauthenticated_at,p_account_digest,p_epoch) is not true
 then return jsonb_build_object('code','FORBIDDEN');end if;
 select * into op from cluera_billing_private.plan_sync_operations where operation_id=p_operation and actor_id=p_actor
 and account_digest=p_account_digest and epoch=p_epoch for update;
 if not found then return jsonb_build_object('code','CONFLICT');end if;
 if op.state='APPLIED' then return jsonb_build_object('code','APPLIED','revision',op.result);end if;
 if op.state<>'BOUND' then return jsonb_build_object('code','PENDING');end if;
 value:=public.cluera_billing_admin_mutate(p_actor,p_session,p_operation,'CREATE_REVISION',op.offer_code,op.expected_revision,
   p_reauthenticated_at,op.reason,op.input||jsonb_build_object('razorpayPlanId',op.razorpay_plan_id));
 if value->>'code' is distinct from 'APPLIED' then return value;end if;
 rid:=(value->'revision'->>'revisionId')::uuid;
 if public.cluera_billing_plan_verify(rid,p_account_digest,p_evidence) is distinct from 'VERIFIED'
 then raise exception 'Plan verification rejected';end if;
 select item into value from jsonb_array_elements(public.cluera_billing_catalog()) item where item->>'revisionId'=rid::text;
 update cluera_billing_private.plan_sync_operations set state='APPLIED',result=value,updated_at=clock_timestamp() where operation_id=p_operation;
 return jsonb_build_object('code','APPLIED','revision',value);
end$$;

revoke all on function public.cluera_billing_plan_sync_read(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.cluera_billing_plan_sync_claim(uuid,uuid,timestamptz,uuid,text,bigint,text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.cluera_billing_plan_sync_bind(uuid,uuid,timestamptz,uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.cluera_billing_plan_sync_finish(uuid,uuid,timestamptz,uuid,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.cluera_billing_plan_sync_read(uuid,uuid,uuid) to service_role;
grant execute on function public.cluera_billing_plan_sync_claim(uuid,uuid,timestamptz,uuid,text,bigint,text,uuid,text,jsonb) to service_role;
grant execute on function public.cluera_billing_plan_sync_bind(uuid,uuid,timestamptz,uuid,text,bigint,text) to service_role;
grant execute on function public.cluera_billing_plan_sync_finish(uuid,uuid,timestamptz,uuid,text,bigint,jsonb) to service_role;
