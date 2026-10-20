-- Source fragment for the isolated Live proposal. No activation statements.
create schema cluera_billing_runtime_private;
revoke all on schema cluera_billing_runtime_private from public,anon,authenticated,service_role;
create table cluera_billing_runtime_private.active_bank(
 singleton boolean primary key default true check(singleton),mode text not null check(mode in('test','live'))
);
insert into cluera_billing_runtime_private.active_bank values(true,'test');
create table cluera_billing_runtime_private.live_profile(
 singleton boolean primary key default true check(singleton),
 account_digest text check(account_digest~'^[a-f0-9]{64}$'),
 origin text check(origin~'^https://[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
 checkout_enabled boolean not null default false,intake_enabled boolean not null default false,
 acceptance_digest text check(acceptance_digest~'^[a-f0-9]{64}$'),
 check(not checkout_enabled or(intake_enabled and account_digest is not null and origin is not null and acceptance_digest is not null)),
 check(not intake_enabled or(account_digest is not null and origin is not null))
);
insert into cluera_billing_runtime_private.live_profile(singleton)values(true);
create table cluera_billing_runtime_private.configuration_audit(
 id bigint generated always as identity primary key,changed_at timestamptz not null default clock_timestamp(),
 relation_name text not null,before_row jsonb not null,after_row jsonb not null
);
alter table cluera_billing_runtime_private.configuration_audit enable row level security;
alter table cluera_billing_runtime_private.active_bank enable row level security;
alter table cluera_billing_runtime_private.live_profile enable row level security;
revoke all on all tables in schema cluera_billing_runtime_private from public,anon,authenticated,service_role;
create function cluera_billing_runtime_private.audit_configuration()returns trigger
language plpgsql security invoker set search_path=''as $$begin
 insert into cluera_billing_runtime_private.configuration_audit(relation_name,before_row,after_row)
 values(tg_table_name,to_jsonb(old),to_jsonb(new));return new;end$$;
create trigger cluera_profile_audit after update on cluera_billing_runtime_private.live_profile
 for each row execute function cluera_billing_runtime_private.audit_configuration();
create trigger cluera_bank_audit after update on cluera_billing_runtime_private.active_bank
 for each row execute function cluera_billing_runtime_private.audit_configuration();
create function cluera_billing_runtime_private.immutable_audit()returns trigger
language plpgsql security invoker set search_path=''as $$begin raise exception 'Configuration audit is immutable';end$$;
create trigger cluera_config_audit_immutable before update or delete on cluera_billing_runtime_private.configuration_audit
 for each row execute function cluera_billing_runtime_private.immutable_audit();

-- Provenance determines the bank; a caller cannot supply or update a mode.
-- The original once-only trial remains one shared grant, never copied.
alter table public.customer_usage_grants add column billing_mode text generated always as(
 case when kind='TRIAL'and source_key='lifetime-trial'then 'shared'
 when source_key like 'razorpay-live:%'or source_key like 'razorpay-live-invoice:%'then 'live'
 else 'test'end
)stored;
create index customer_usage_grants_bank on public.customer_usage_grants(user_id,billing_mode,state);
create function cluera_billing_runtime_private.bank()returns text
language sql volatile security invoker set search_path=''as $$
 select mode from cluera_billing_runtime_private.active_bank where singleton for share
$$;
create function cluera_billing_runtime_private.immutable_grant_identity()returns trigger
language plpgsql security invoker set search_path=''as $$begin
 if(new.id,new.user_id,new.source_key,new.kind,new.granted_ms)is distinct from(old.id,old.user_id,old.source_key,old.kind,old.granted_ms)
 then raise exception 'Usage provenance is immutable';end if;return new;
end$$;
create trigger cluera_grant_identity before update on public.customer_usage_grants
 for each row execute function cluera_billing_runtime_private.immutable_grant_identity();
create function cluera_billing_runtime_private.live_grant()returns trigger
language plpgsql security invoker set search_path=''as $$begin
 if new.grant_id is not null and not exists(select 1 from public.customer_usage_grants
 where user_id=new.user_id and id=new.grant_id and billing_mode='live')
 then raise exception 'Live financial record requires Live grant provenance';end if;return new;
end$$;
create trigger cluera_live_grant before insert or update on cluera_live_billing_private.payments
 for each row execute function cluera_billing_runtime_private.live_grant();
create trigger cluera_live_term_grant before insert or update on cluera_live_billing_private.terms
 for each row execute function cluera_billing_runtime_private.live_grant();

create function public.cluera_live_billing_profile(p_account_digest text)returns jsonb
language plpgsql stable security definer set search_path=''as $$
declare p cluera_billing_runtime_private.live_profile;o cluera_live_billing_private.processing_owner;begin
 select *into strict p from cluera_billing_runtime_private.live_profile where singleton;
 select *into strict o from cluera_live_billing_private.processing_owner where singleton;
 if p.account_digest is null or p.account_digest is distinct from p_account_digest or o.account_digest is distinct from p_account_digest
 or o.owner<>'cluera'or p.origin is null then return jsonb_build_object('code','UNAVAILABLE');end if;
 return jsonb_build_object('mode','live','merchantDigest',p.account_digest,'origin',p.origin,
 'ledgerNamespace','cluera_live_billing_private','grantPrefix','razorpay-live:','workerAudience','cluera-billing-live-v1',
 'epoch',o.epoch,'checkoutEnabled',p.checkout_enabled and(select mode='live'from cluera_billing_runtime_private.active_bank where singleton),'intakeEnabled',p.intake_enabled);
end$$;
revoke all on function public.cluera_live_billing_profile(text)from public,anon,authenticated;
grant execute on function public.cluera_live_billing_profile(text)to service_role;

-- Independent DB enforcement: configuring a Live key cannot enable a sale.
alter function public.cluera_live_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)rename to cluera_live_billing_prepare_pre_modes;
create function public.cluera_live_billing_prepare(p_user uuid,p_session uuid,p_request uuid,p_revision uuid,p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$begin
 if cluera_billing_runtime_private.bank()<>'live'or not exists(select 1 from cluera_billing_runtime_private.live_profile
 where singleton and checkout_enabled and intake_enabled and account_digest=p_account_digest and acceptance_digest is not null)
 then return jsonb_build_object('code','DISABLED');end if;
 return public.cluera_live_billing_prepare_pre_modes(p_user,p_session,p_request,p_revision,p_account_digest,p_epoch);
end$$;
revoke all on function public.cluera_live_billing_prepare_pre_modes(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated,service_role;

alter function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)rename to cluera_billing_prepare_pre_modes;
create function public.cluera_billing_prepare(p_user uuid,p_session uuid,p_request uuid,p_revision uuid,p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$begin
 if cluera_billing_runtime_private.bank()<>'test'then return jsonb_build_object('code','DISABLED');end if;
 return public.cluera_billing_prepare_pre_modes(p_user,p_session,p_request,p_revision,p_account_digest,p_epoch);
end$$;
revoke all on function public.cluera_billing_prepare_pre_modes(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated,service_role;
revoke all on function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated;
grant execute on function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)to service_role;

-- Bank changes wait for active provider authorizations to drain. No active
-- account can carry a paid Test reservation into Live after promotion.
create function cluera_billing_runtime_private.bank_change_guard()returns trigger
language plpgsql security invoker set search_path=''as $$begin
 if new.mode is distinct from old.mode then
 if exists(select 1 from public.customer_usage_windows w join public.customer_usage_runs r using(user_id,run_id)
 where r.state='ACTIVE'and r.sequence=w.sequence and w.expires_at>clock_timestamp())
 then raise exception 'Active usage must drain before bank change';end if;
 if new.mode='live'and not exists(select 1 from cluera_billing_runtime_private.live_profile
 where singleton and checkout_enabled and intake_enabled and acceptance_digest is not null)
 then raise exception 'Live acceptance is required';end if;
 end if;return new;
end$$;
create trigger cluera_bank_change before update on cluera_billing_runtime_private.active_bank
 for each row execute function cluera_billing_runtime_private.bank_change_guard();
revoke all on all functions in schema cluera_billing_runtime_private from public,anon,authenticated,service_role;
