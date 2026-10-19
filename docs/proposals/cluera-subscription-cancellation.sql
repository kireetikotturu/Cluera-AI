-- UNAPPLIED additive proposal. Review and schema acceptance are required before
-- CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED may be enabled. No provider call,
-- entitlement mutation, scheduler, existing row rewrite or activation occurs.
-- The web service alone may claim one Test cancel-at-cycle-end POST. An unknown
-- response is never retried; a later same-owner GET can prove terminal state.
begin;

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
commit;
