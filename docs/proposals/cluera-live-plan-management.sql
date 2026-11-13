-- REVIEW PROPOSAL ONLY. NOT APPLIED. Do not run until the owner approves it.
--
-- WHAT THIS DOES (plain English)
--   Lets the owner add, edit, switch On/Off and remove (hide) one-time credit packs
--   from the Admin "Plans" screen. Prices are in rupees, time is in hours.
--
-- WHAT IT CHANGES (Live ledger only: cluera_live_billing_private)
--   1. catalog_heads gets 3 new columns (plan_id, archived, created_at). A "plan" is one
--      head row. Several packs may now exist; each keeps offer_code 'cluera_pack_3h_v2'
--      because the installed Windows app only understands that code. The 3 monthly rows
--      are untouched and stay Off. The primary key moves from offer_code to plan_id.
--   2. New functions (service role only):
--        cluera_live_billing_plans_read   - list plans / verify an earlier change
--        cluera_live_billing_plan_change  - CREATE, EDIT, SET_ENABLED, ARCHIVE, RESTORE
--   3. cluera_live_billing_catalog() is replaced: it hides removed (archived) plans and
--      reports packs as validated (the original forgot this, so a Live pack could never be bought).
--   4. The old cluera_live_billing_admin_mutate() is wrapped so it can no longer touch packs
--      (it looks plans up by offer code, which is no longer unique for packs). Monthly
--      behaviour is unchanged.
--
-- WHAT IT NEVER CHANGES
--   No existing revision, intent, payment, grant, event, audit or ledger row is edited or deleted.
--   A price/hours change inserts a NEW immutable revision and moves the plan to it. Orders already
--   created keep pointing at the revision they were created with, so their amount and the time they
--   grant never change. The server still reads the price from this catalog and the database refuses
--   to start a purchase for a plan that is Off, archived or superseded.
--
-- SECURITY
--   Every change needs an active Admin profile, a verified email and a live session at assurance
--   level aal2 (the existing Admin MFA sign-in), checked INSIDE the database on every call.
--   There is no fresh-code requirement per change (owner decision). Every change writes one
--   immutable cluera_live_billing_private.admin_audit row: who, when, action, before, after, reason.
--
-- ROLLBACK (safe): see the commented block at the bottom. It refuses to run if more than the
--   original pack exists or anything was archived, so no plan or history is ever lost silently.
--
-- Monthly plans are out of scope. Razorpay monthly plans cannot be edited (a changed price needs a
-- brand-new Razorpay plan), so they stay hidden/disabled and no monthly code is removed.

begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(862117,20261101);

do $$begin
 if to_regclass('cluera_live_billing_private.catalog_heads') is null
 or to_regprocedure('public.cluera_live_billing_admin_mutate(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb)') is null
 or to_regprocedure('public.cluera_live_billing_catalog()') is null
 or exists(select 1 from information_schema.columns where table_schema='cluera_live_billing_private'
   and table_name='catalog_heads' and column_name='plan_id')
 then raise exception 'Plan management precondition requires review';end if;
 if (select count(*) from cluera_live_billing_private.catalog_heads)<>4 then
  raise exception 'Unexpected Live catalog shape; stop and review';end if;
end$$;

-- 1. One head row per plan.
alter table cluera_live_billing_private.catalog_heads
 add column plan_id uuid not null default gen_random_uuid(),
 add column archived boolean not null default false,
 add column created_at timestamptz not null default clock_timestamp();
do $$declare c text;begin
 select conname into strict c from pg_constraint
 where conrelid='cluera_live_billing_private.catalog_heads'::regclass and contype='p';
 execute format('alter table cluera_live_billing_private.catalog_heads drop constraint %I',c);
end$$;
alter table cluera_live_billing_private.catalog_heads add constraint catalog_heads_pkey primary key(plan_id);
alter table cluera_live_billing_private.catalog_heads add constraint catalog_heads_removed_is_off check(not archived or not enabled);
create index catalog_heads_offer_code on cluera_live_billing_private.catalog_heads(offer_code);
create index catalog_heads_revision on cluera_live_billing_private.catalog_heads(revision_id);
-- A monthly offer keeps exactly one head; only the pack offer may have several.
create unique index catalog_heads_one_monthly on cluera_live_billing_private.catalog_heads(offer_code)
 where offer_code<>'cluera_pack_3h_v2';

-- 2. Public (customer-safe) catalog: removed plans disappear; packs need no provider plan.
create or replace function public.cluera_live_billing_catalog() returns jsonb language sql security definer set search_path='' set statement_timeout='5s' as $$
 select coalesce(jsonb_agg(jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,'currency',r.currency,
 'allowanceSeconds',r.allowance_seconds,'kind',r.kind,'interval',r.interval_name,'razorpayPlanId',r.razorpay_plan_id,'totalCount',r.total_count,
 'testPlanValidated',(r.kind='PACK' or exists(select 1 from cluera_live_billing_private.plan_verifications v join cluera_live_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id)),
 'enabled',h.enabled,'version',r.version)
 order by r.amount_paise,h.created_at,h.plan_id),'[]')
 from cluera_live_billing_private.catalog_heads h join cluera_live_billing_private.catalog_revisions r on r.id=h.revision_id
 where not h.archived
$$;

-- 3. Admin view of one plan (includes removed plans and how many customers have an unpaid checkout open).
create function cluera_live_billing_private.plan_json(p_plan uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('planId',h.plan_id,'revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,
 'currency',r.currency,'allowanceSeconds',r.allowance_seconds,'kind',r.kind,'version',r.version,'enabled',h.enabled,'archived',h.archived,
 'createdAt',h.created_at,
 'openCheckouts',(select count(*) from cluera_live_billing_private.intents i where i.revision_id=r.id and i.state in('CREATING','BOUND','UNCERTAIN')))
 from cluera_live_billing_private.catalog_heads h join cluera_live_billing_private.catalog_revisions r on r.id=h.revision_id where h.plan_id=p_plan
$$;

create function public.cluera_live_billing_plans_read(p_actor uuid,p_session uuid,p_operation uuid default null) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$declare a cluera_live_billing_private.admin_audit;begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is not null then
  select * into a from cluera_live_billing_private.admin_audit where operation_id=p_operation and actor_id=p_actor and action like 'PLAN\_%';
  return case when found then jsonb_build_object('code','APPLIED','plan',a.after_row) else jsonb_build_object('code','NOT_FOUND') end;
 end if;
 return jsonb_build_object('code','ACTIVE','plans',coalesce((select jsonb_agg(cluera_live_billing_private.plan_json(h.plan_id)
  order by h.archived,r.amount_paise,h.created_at,h.plan_id)
  from cluera_live_billing_private.catalog_heads h join cluera_live_billing_private.catalog_revisions r on r.id=h.revision_id
  where r.kind='PACK'),'[]'),
  -- Who changed what and when (newest 20), straight from the immutable audit table.
  'history',coalesce((select jsonb_agg(jsonb_build_object('at',q.created_at,'by',coalesce(u.email,'unknown'),'action',q.action,'reason',q.reason,
    'before',q.before_row,'after',q.after_row) order by q.created_at desc,q.operation_id)
  from(select * from cluera_live_billing_private.admin_audit where action like 'PLAN\_%' order by created_at desc,operation_id limit 20)q
  left join auth.users u on u.id=q.actor_id),'[]'));
end$$;

-- 4. The single audited change function.
create function public.cluera_live_billing_plan_change(p_actor uuid,p_session uuid,p_operation uuid,p_action text,p_plan uuid,
 p_expected_revision uuid,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare h cluera_live_billing_private.catalog_heads;r cluera_live_billing_private.catalog_revisions;a cluera_live_billing_private.admin_audit;
 before_value jsonb;after_value jsonb;stored_reason text;audit_input jsonb;new_name text;new_amount integer;new_seconds integer;new_enabled boolean;
 next_version integer;plan uuid;begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null or p_action is null or p_action not in('CREATE','EDIT','SET_ENABLED','ARCHIVE','RESTORE')
 or jsonb_typeof(p_input) is distinct from 'object' or (p_reason is not null and length(trim(p_reason))>400)
 or (p_action='CREATE' and (p_plan is not null or p_expected_revision is not null))
 or (p_action<>'CREATE' and (p_plan is null or p_expected_revision is null)) then return jsonb_build_object('code','INVALID');end if;
 stored_reason:=case when nullif(trim(coalesce(p_reason,'')),'') is null then 'No reason given' else 'Reason given: '||trim(p_reason) end;
 audit_input:=jsonb_build_object('plan',p_plan,'expectedRevision',p_expected_revision,'input',p_input);
 -- One admin change at a time; the same operation id is idempotent.
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation::text,862117));
 select * into a from cluera_live_billing_private.admin_audit where operation_id=p_operation;
 if found then
  if a.actor_id<>p_actor or a.session_id<>p_session or a.action<>'PLAN_'||p_action or a.input is distinct from audit_input
  then return jsonb_build_object('code','CONFLICT');end if;
  return jsonb_build_object('code','APPLIED','plan',a.after_row);
 end if;
 if p_action in('CREATE','EDIT') then
  if (p_input-array['name','amountPaise','allowanceSeconds','enabled'])<>'{}'::jsonb
  or (p_action='EDIT' and p_input?'enabled') or (p_action='CREATE' and jsonb_typeof(p_input->'enabled') is distinct from 'boolean')
  or jsonb_typeof(p_input->'name') is distinct from 'string' or length(trim(p_input->>'name')) not between 2 and 80
  or coalesce(p_input->>'amountPaise','') !~ '^[0-9]{3,8}$' or coalesce(p_input->>'allowanceSeconds','') !~ '^[0-9]{2,7}$'
  or (p_input->>'amountPaise')::integer not between 100 and 10000000 or (p_input->>'allowanceSeconds')::integer not between 60 and 3600000
  then return jsonb_build_object('code','INVALID');end if;
  new_name:=trim(p_input->>'name');new_amount:=(p_input->>'amountPaise')::integer;new_seconds:=(p_input->>'allowanceSeconds')::integer;
 elsif p_action='SET_ENABLED' then
  if (p_input-array['enabled'])<>'{}'::jsonb or jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then return jsonb_build_object('code','INVALID');end if;
  new_enabled:=(p_input->>'enabled')::boolean;
 elsif p_input<>'{}'::jsonb then return jsonb_build_object('code','INVALID');
 end if;
 if p_action='CREATE' then
  if (select count(*) from cluera_live_billing_private.catalog_heads x join cluera_live_billing_private.catalog_revisions y on y.id=x.revision_id
      where y.kind='PACK' and not x.archived)>=20 then return jsonb_build_object('code','TOO_MANY_PLANS');end if;
  if exists(select 1 from cluera_live_billing_private.catalog_heads x join cluera_live_billing_private.catalog_revisions y on y.id=x.revision_id
      where y.kind='PACK' and not x.archived and lower(y.name)=lower(new_name)) then return jsonb_build_object('code','DUPLICATE_NAME');end if;
  before_value:='{}'::jsonb;
  select coalesce(max(version),0)+1 into next_version from cluera_live_billing_private.catalog_revisions where offer_code='cluera_pack_3h_v2';
  insert into cluera_live_billing_private.catalog_revisions(offer_code,version,name,amount_paise,allowance_seconds,kind)
   values('cluera_pack_3h_v2',next_version,new_name,new_amount,new_seconds,'PACK') returning * into r;
  insert into cluera_live_billing_private.catalog_heads(offer_code,revision_id,enabled) values(r.offer_code,r.id,(p_input->>'enabled')::boolean) returning * into h;
  plan:=h.plan_id;
 else
  select * into h from cluera_live_billing_private.catalog_heads where plan_id=p_plan for update;
  if not found then return jsonb_build_object('code','NOT_FOUND');end if;
  if h.revision_id<>p_expected_revision then return jsonb_build_object('code','CONFLICT');end if;
  select * into strict r from cluera_live_billing_private.catalog_revisions where id=h.revision_id;
  if r.kind<>'PACK' then return jsonb_build_object('code','INVALID');end if;
  plan:=h.plan_id;before_value:=cluera_live_billing_private.plan_json(plan);
  if p_action='EDIT' then
   if h.archived then return jsonb_build_object('code','ARCHIVED');end if;
   if new_name=r.name and new_amount=r.amount_paise and new_seconds=r.allowance_seconds then return jsonb_build_object('code','NO_CHANGE');end if;
   if exists(select 1 from cluera_live_billing_private.catalog_heads x join cluera_live_billing_private.catalog_revisions y on y.id=x.revision_id
      where y.kind='PACK' and not x.archived and x.plan_id<>h.plan_id and lower(y.name)=lower(new_name)) then return jsonb_build_object('code','DUPLICATE_NAME');end if;
   select coalesce(max(version),0)+1 into next_version from cluera_live_billing_private.catalog_revisions where offer_code=r.offer_code;
   insert into cluera_live_billing_private.catalog_revisions(offer_code,version,name,amount_paise,allowance_seconds,kind)
    values(r.offer_code,next_version,new_name,new_amount,new_seconds,'PACK') returning * into r;
   update cluera_live_billing_private.catalog_heads set revision_id=r.id where plan_id=h.plan_id;
  elsif p_action='SET_ENABLED' then
   if h.archived and new_enabled then return jsonb_build_object('code','ARCHIVED');end if;
   update cluera_live_billing_private.catalog_heads set enabled=new_enabled where plan_id=h.plan_id;
  elsif p_action='ARCHIVE' then
   update cluera_live_billing_private.catalog_heads set enabled=false,archived=true where plan_id=h.plan_id;
  else
   if not h.archived then return jsonb_build_object('code','NO_CHANGE');end if;
   if exists(select 1 from cluera_live_billing_private.catalog_heads x join cluera_live_billing_private.catalog_revisions y on y.id=x.revision_id
      where y.kind='PACK' and not x.archived and lower(y.name)=lower(r.name)) then return jsonb_build_object('code','DUPLICATE_NAME');end if;
   update cluera_live_billing_private.catalog_heads set archived=false where plan_id=h.plan_id;
  end if;
 end if;
 if public.account_admin_check(p_actor,p_session,true) is not true then raise exception 'Admin session changed';end if;
 after_value:=cluera_live_billing_private.plan_json(plan);
 insert into cluera_live_billing_private.admin_audit(operation_id,actor_id,session_id,action,reason,input,before_row,after_row)
  values(p_operation,p_actor,p_session,'PLAN_'||p_action,stored_reason,audit_input,before_value,after_value);
 return jsonb_build_object('code','APPLIED','plan',after_value);
end$$;

-- 5. The old by-offer-code mutation can no longer address a pack (several packs share the code).
alter function public.cluera_live_billing_admin_mutate(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb)
 rename to cluera_live_billing_admin_mutate_pre_plans;
create function public.cluera_live_billing_admin_mutate(p_actor uuid,p_session uuid,p_operation uuid,p_action text,p_offer text,
 p_expected_revision uuid,p_reauthenticated_at timestamptz,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin
 if p_offer is null or p_offer='cluera_pack_3h_v2' then return jsonb_build_object('code','INVALID');end if;
 return public.cluera_live_billing_admin_mutate_pre_plans(p_actor,p_session,p_operation,p_action,p_offer,p_expected_revision,p_reauthenticated_at,p_reason,p_input);
end$$;
revoke all on function public.cluera_live_billing_admin_mutate_pre_plans(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb) from public,anon,authenticated,service_role;

revoke all on function cluera_live_billing_private.plan_json(uuid) from public,anon,authenticated,service_role;
revoke all on function public.cluera_live_billing_plans_read(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.cluera_live_billing_plan_change(uuid,uuid,uuid,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.cluera_live_billing_admin_mutate(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.cluera_live_billing_plans_read(uuid,uuid,uuid) to service_role;
grant execute on function public.cluera_live_billing_plan_change(uuid,uuid,uuid,text,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.cluera_live_billing_admin_mutate(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb) to service_role;

-- Nothing may have been enabled or created by this change itself.
do $$begin
 if (select count(*) from cluera_live_billing_private.catalog_heads)<>4
 or (select count(*) from cluera_live_billing_private.catalog_revisions)<>4 then raise exception 'Plan management changed catalog rows';end if;
end$$;
commit;

-- ROLLBACK (review only). Run as a separate transaction. It stops if a plan was added or removed so that
-- no plan or audit history is lost; the audit rows are immutable and always remain.
--
-- begin;
-- set local lock_timeout='2s';
-- select pg_advisory_xact_lock(862117,20261101);
-- do $$begin
--  if (select count(*) from cluera_live_billing_private.catalog_heads)<>4
--  or exists(select 1 from cluera_live_billing_private.catalog_heads where archived)
--  or (select count(*) from cluera_live_billing_private.catalog_revisions where offer_code='cluera_pack_3h_v2')<>1
--  then raise exception 'Plans were added, edited or removed; roll back by hand after review';end if;
-- end$$;
-- drop function public.cluera_live_billing_admin_mutate(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb);
-- alter function public.cluera_live_billing_admin_mutate_pre_plans(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb)
--  rename to cluera_live_billing_admin_mutate;
-- grant execute on function public.cluera_live_billing_admin_mutate(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb) to service_role;
-- drop function public.cluera_live_billing_plan_change(uuid,uuid,uuid,text,uuid,uuid,text,jsonb);
-- drop function public.cluera_live_billing_plans_read(uuid,uuid,uuid);
-- drop function cluera_live_billing_private.plan_json(uuid);
-- create or replace function public.cluera_live_billing_catalog() returns jsonb language sql security definer set search_path='' set statement_timeout='5s' as $f$
--  select coalesce(jsonb_agg(jsonb_build_object('revisionId',r.id,'offerCode',r.offer_code,'name',r.name,'amountPaise',r.amount_paise,'currency',r.currency,
--  'allowanceSeconds',r.allowance_seconds,'kind',r.kind,'interval',r.interval_name,'razorpayPlanId',r.razorpay_plan_id,'totalCount',r.total_count,
--  'testPlanValidated',exists(select 1 from cluera_live_billing_private.plan_verifications v join cluera_live_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id),'enabled',h.enabled,'version',r.version)
--  order by r.amount_paise),'[]') from cluera_live_billing_private.catalog_heads h join cluera_live_billing_private.catalog_revisions r on r.id=h.revision_id
-- $f$;
-- drop index cluera_live_billing_private.catalog_heads_one_monthly;
-- drop index cluera_live_billing_private.catalog_heads_revision;
-- drop index cluera_live_billing_private.catalog_heads_offer_code;
-- alter table cluera_live_billing_private.catalog_heads drop constraint catalog_heads_removed_is_off;
-- alter table cluera_live_billing_private.catalog_heads drop constraint catalog_heads_pkey;
-- alter table cluera_live_billing_private.catalog_heads add primary key(offer_code);
-- alter table cluera_live_billing_private.catalog_heads drop column plan_id,drop column archived,drop column created_at;
-- commit;
