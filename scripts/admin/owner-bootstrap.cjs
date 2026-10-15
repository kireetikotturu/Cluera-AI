'use strict';

// One-off operator SQL preparation, NOT an application endpoint or role API.
// No network, credentials, execution, Auth/session/MFA mutation or schema change.
const EMAIL = 'clueraaisupport@gmail.com';
const ACTION = 'OWNER_AUTHORIZED_ADMIN_BOOTSTRAP';
const REASON = 'Owner-authorized operator bootstrap; actor UUID is the recipient anchor, not an authenticated grantor.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identity = "jsonb_build_object('id',u.id,'email',u.email,'email_confirmed_at',u.email_confirmed_at,'created_at',u.created_at,'deleted_at',u.deleted_at,'banned_until',u.banned_until,'is_anonymous',u.is_anonymous,'account',to_jsonb(c))";

function prepareOwnerBootstrap(input) {
  if (!input || typeof input!=='object') throw new Error('Invalid bootstrap pins.');
  const {targetId,operationId,identityDigest,evidenceAt}=input;
  if (Object.keys(input).sort().join(',') !== 'evidenceAt,identityDigest,operationId,targetId'
    || ![targetId,operationId,identityDigest,evidenceAt].every(value => typeof value === 'string')
    || !uuid.test(targetId) || !uuid.test(operationId)
    || !/^[a-f0-9]{32}$/.test(identityDigest)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidenceAt)
    || !Number.isFinite(Date.parse(evidenceAt))) throw new Error('Invalid bootstrap pins.');
  const detail=after=>`jsonb_build_object(
  'actorSemantics','bootstrap_subject_not_authenticated_grantor',
  'authorization','Direct owner request to grant clueraaisupport@gmail.com Admin, October 15 2026',
  'executor',current_user,'sessionExecutor',session_user,
  'scope','Retained Account allowlist shared by Cluera and temporary old Account Admin; excludes License Edition',
  'noAuthenticatedSession',true,'noMfaClaim',true,'identityDigest',expected,
  'evidenceAt',observed,'before',null,'after',${after})`;
  return `begin isolation level serializable;
set local lock_timeout='2s';
set local statement_timeout='8s';
set local timezone='UTC';
do $owner_bootstrap$
declare
 target uuid:='${targetId}'; operation uuid:='${operationId}';
 observed timestamptz:='${evidenceAt}'; expected text:='${identityDigest}';
 actual text; before_role jsonb; after_role jsonb; prior public.account_admin_audit%rowtype;
 role_name text; table_name text;
begin
 if current_setting('session_replication_role')<>'origin' then raise exception 'Bootstrap audit mode mismatch'; end if;
 if clock_timestamp()<observed or clock_timestamp()>observed+interval '2 minutes' then
  raise exception 'Bootstrap evidence expired'; end if;
 -- All role grants use this operator lock; no lock on the unrelated Admin.
 perform pg_advisory_xact_lock(7918206);
 lock table public.account_admin_profiles,public.account_admin_audit in share row exclusive mode;
 perform 1 from auth.users where id=target for update;
 perform 1 from public.customer_accounts where user_id=target for update;
 if (select count(*) from auth.users where lower(email)='${EMAIL}')<>1 then raise exception 'Bootstrap identity mismatch'; end if;
 select md5(${identity}::text) into actual
 from auth.users u join public.customer_accounts c on c.user_id=u.id
 where u.id=target and lower(u.email)='${EMAIL}' and u.email_confirmed_at is not null
 and u.deleted_at is null and u.is_anonymous is false
 and (u.banned_until is null or u.banned_until<=now()) and c.state='ACTIVE';
 if actual is distinct from expected then raise exception 'Bootstrap identity mismatch'; end if;
 foreach table_name in array array['public.account_admin_profiles','public.account_admin_audit'] loop
  if not (select relrowsecurity from pg_class where oid=table_name::regclass)
    or exists(select 1 from pg_policy where polrelid=table_name::regclass) then raise exception 'Bootstrap security mismatch'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
   if has_table_privilege(role_name,table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then raise exception 'Bootstrap security mismatch'; end if;
  end loop;
 end loop;
 if exists(select 1 from pg_trigger where tgrelid='public.account_admin_profiles'::regclass and not tgisinternal)
  or (select count(*) from pg_trigger where tgrelid='public.account_admin_audit'::regclass and not tgisinternal)<>1
  or exists(select 1 from pg_rewrite where ev_class in ('public.account_admin_profiles'::regclass,'public.account_admin_audit'::regclass))
  then raise exception 'Bootstrap trigger or rule mismatch'; end if;
 if not exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
   where t.tgrelid='public.account_admin_audit'::regclass and not t.tgisinternal
   and t.tgname='account_audit_immutable' and t.tgenabled='O' and t.tgtype=27
   and not p.prosecdef and p.proconfig=array['search_path=""']::text[]
   and md5(p.prosrc)='319ee53685648ef376669223385c6657') then raise exception 'Bootstrap audit mismatch'; end if;
 select to_jsonb(a) into before_role from public.account_admin_profiles a where user_id=target for update;
 select * into prior from public.account_admin_audit where operation_id=operation;
 if found then
  if prior.actor_id<>target or prior.subject_id is distinct from target or prior.action<>'${ACTION}'
   or prior.reason<>'${REASON}' or before_role->>'active' is distinct from 'true'
   or prior.detail is distinct from ${detail('before_role')}
   then raise exception 'Bootstrap replay conflict'; end if;
  return;
 end if;
 if before_role is not null then raise exception 'Bootstrap role already exists'; end if;
 if clock_timestamp()>observed+interval '2 minutes' then raise exception 'Bootstrap evidence expired'; end if;
 insert into public.account_admin_profiles(user_id,active) values(target,true);
 select to_jsonb(a) into after_role from public.account_admin_profiles a where user_id=target;
 insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
 values(operation,target,target,'${ACTION}','${REASON}',${detail('after_role')});
 if not exists(select 1 from public.account_admin_profiles where user_id=target and active)
  or (select count(*) from public.account_admin_audit where operation_id=operation)<>1 then raise exception 'Bootstrap verification failed'; end if;
end $owner_bootstrap$;
commit;`;
}

module.exports = { prepareOwnerBootstrap };
