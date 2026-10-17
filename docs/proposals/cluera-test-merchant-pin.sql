-- UNAPPLIED OPERATOR TEMPLATE: clean Cluera yhnqlfcgrmckhyjdxegg ONLY.
-- Deliberately unexecutable placeholders. Separate explicit owner approval and
-- fresh authenticated Test merchant evidence are required by the offline helper.
-- Connector target identity must be checked independently before any execution.
-- No financial activation, provider mutation, ownership/epoch change or grant.
begin isolation level serializable;
set local lock_timeout='2s';
set local statement_timeout='8s';
set local timezone='UTC';
do $merchant_pin$
declare
 operation uuid:='__OPERATION_ID__'; expected text:='__MERCHANT_DIGEST__';
 observed timestamptz:='__OBSERVED_AT__'; deadline timestamptz:='__DEADLINE__';
 detail jsonb:='__PROVENANCE_JSON__'::jsonb;
 owner_row cluera_billing_private.processing_owner;prior cluera_billing_private.cutover_audit;
 before_value jsonb;after_value jsonb;relation_name text;role_name text;nonempty boolean;
begin
 if current_setting('session_replication_role')<>'origin' then raise exception 'Merchant pin audit mode mismatch';end if;
 perform pg_advisory_xact_lock(7918217);
 select * into strict owner_row from cluera_billing_private.processing_owner where singleton for update;
 -- Exact existing implementation/audit pins, not a new privileged RPC.
 if (select md5(prosrc) from pg_proc where oid='public.cluera_billing_owner(text)'::regprocedure) is distinct from '__OWNER_MD5__'
 or (select md5(prosrc) from pg_proc where oid='public.cluera_billing_cutover(uuid,text,bigint,text,text,text)'::regprocedure) is distinct from '__CUTOVER_MD5__'
 or (select md5(prosrc) from pg_proc where oid='cluera_billing_private.owns(text,text,bigint)'::regprocedure) is distinct from '__OWNS_MD5__'
 then raise exception 'Merchant pin implementation mismatch';end if;
 -- Body equality alone does not establish SECURITY DEFINER, safe configuration
 -- or exact owner/service ACLs. Full85-function inventory still needs fresh
 -- independent operator comparison before approving this one-off execution.
 if exists(select 1 from(values
   ('public.cluera_billing_owner(text)',true,array['search_path=""','statement_timeout=5s']::text[],true,'jsonb'::regtype),
   ('public.cluera_billing_cutover(uuid,text,bigint,text,text,text)',true,array['search_path=""','lock_timeout=2s','statement_timeout=5s']::text[],true,'jsonb'::regtype),
   ('cluera_billing_private.owns(text,text,bigint)',false,array['search_path=""']::text[],false,'boolean'::regtype)
 ) expected(signature,definer,configuration,service_execute,result_type)
 left join pg_proc p on p.oid=to_regprocedure(expected.signature)
 left join pg_language l on l.oid=p.prolang
 where p.oid is null or p.prosecdef is distinct from expected.definer or p.proconfig is distinct from expected.configuration
   or p.proowner is distinct from (select oid from pg_roles where rolname='postgres') or l.lanname is distinct from 'plpgsql'
   or p.prorettype is distinct from expected.result_type or p.proretset or p.proisstrict or p.proleakproof
   or p.prokind<>'f' or p.provolatile<>'v' or p.proparallel<>'u'
   or (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>case when expected.service_execute then 2 else 1 end
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
   or (expected.service_execute and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee=(select oid from pg_roles where rolname='service_role') and a.privilege_type='EXECUTE' and not a.is_grantable))
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.privilege_type<>'EXECUTE' or a.is_grantable or (a.grantee<>p.proowner
       and (not expected.service_execute or a.grantee<>(select oid from pg_roles where rolname='service_role'))))
 ) then raise exception 'Merchant pin function metadata mismatch';end if;
 if not exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
   where t.tgrelid='cluera_billing_private.cutover_audit'::regclass and not t.tgisinternal
   and t.tgname='immutable' and t.tgenabled='A' and t.tgtype=58
   and not p.prosecdef and p.proconfig=array['search_path=""']::text[] and md5(p.prosrc)='__IMMUTABLE_MD5__')
 or (select count(*) from pg_trigger where tgrelid='cluera_billing_private.cutover_audit'::regclass and not tgisinternal)<>1
 then raise exception 'Merchant pin immutable audit mismatch';end if;
 if exists(select 1 from pg_trigger where tgrelid='cluera_billing_private.processing_owner'::regclass and not tgisinternal)
   or exists(select 1 from pg_rewrite where ev_class in
     ('cluera_billing_private.processing_owner'::regclass,'cluera_billing_private.cutover_audit'::regclass))
 then raise exception 'Merchant pin trigger or rule mismatch';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='cluera_billing_private' or (n.nspname='public' and p.proname like 'cluera_billing_%'))
   and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')))
 then raise exception 'Merchant pin function privilege mismatch';end if;
 foreach relation_name in array array[__GUARDED_RELATIONS__] loop
   execute format('lock table %s in share mode',relation_name::regclass);
   if not (select relrowsecurity from pg_class where oid=relation_name::regclass)
     or exists(select 1 from pg_policy where polrelid=relation_name::regclass)
   then raise exception 'Merchant pin table security mismatch';end if;
   foreach role_name in array array['anon','authenticated','service_role'] loop
     if has_table_privilege(role_name,relation_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     then raise exception 'Merchant pin table privilege mismatch';end if;
   end loop;
 end loop;
 detail:=detail||jsonb_build_object('executor',current_user,'sessionExecutor',session_user);
 select * into prior from cluera_billing_private.cutover_audit where operation_id=operation;
 if found then
   if prior.reason<>'OWNER_AUTHORIZED_CLEAN_TEST_MERCHANT_PIN'
     or prior.before_row->>'owner' is distinct from 'cluera' or prior.before_row->>'epoch' is distinct from '1'
     or prior.before_row->>'account_digest' is not null or prior.before_row->'_merchantPin' is distinct from detail
     or prior.after_row->>'owner' is distinct from 'cluera' or prior.after_row->>'epoch' is distinct from '1'
     or prior.after_row->>'account_digest' is distinct from expected or prior.after_row->'_merchantPin' is distinct from detail
     or to_jsonb(owner_row) is distinct from (prior.after_row-'_merchantPin')
   then raise exception 'Merchant pin replay conflict';end if;
   return;
 end if;
 if clock_timestamp()<observed or clock_timestamp()>deadline then raise exception 'Merchant pin evidence expired';end if;
 if owner_row.owner<>'cluera' or owner_row.epoch<>1 or owner_row.account_digest is not null
 then raise exception 'Merchant pin clean standby mismatch';end if;
 if exists(select 1 from cluera_billing_private.catalog_heads where enabled)
   or exists(select 1 from billing_private.worker_config where enabled or secret_id is not null)
   or (select count(*) from billing_private.worker_config)<>1
   or exists(select 1 from public.customer_usage_grants where kind<>'TRIAL')
 then raise exception 'Merchant pin activation or paid allowance exists';end if;
 if to_regclass('cron.job') is not null then
   execute 'select exists(select 1 from cron.job where active)' into nonempty;
   if nonempty then raise exception 'Merchant pin active scheduler exists';end if;
 end if;
 foreach relation_name in array array[__EMPTY_RELATIONS__] loop
   execute format('select exists(select 1 from %s)',relation_name::regclass) into nonempty;
   if nonempty then raise exception 'Merchant pin financial evidence already exists';end if;
 end loop;
 before_value:=to_jsonb(owner_row)||jsonb_build_object('_merchantPin',detail);
 update cluera_billing_private.processing_owner set account_digest=expected,changed_at=clock_timestamp()
   where singleton and owner='cluera' and epoch=1 and account_digest is null returning * into strict owner_row;
 after_value:=to_jsonb(owner_row)||jsonb_build_object('_merchantPin',detail);
 insert into cluera_billing_private.cutover_audit(operation_id,reason,before_row,after_row,created_at)
 values(operation,'OWNER_AUTHORIZED_CLEAN_TEST_MERCHANT_PIN',before_value,after_value,clock_timestamp());
end $merchant_pin$;
commit;
