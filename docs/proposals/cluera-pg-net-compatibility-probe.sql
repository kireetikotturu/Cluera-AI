-- UNAPPLIED ROLLBACK-ONLY PROPOSAL. A NEW explicit owner approval is required.
-- ONLY yhnqlfcgrmckhyjdxegg / cluera-ai-production: verify connector identity
-- externally immediately before execution; no reliable project-ref GUC exists.
-- Earlier approval of two frozen passive proposals does NOT authorize this probe.
-- Transient native DDL is intentional, but MUST NOT persist. Installation may
-- initialize platform infrastructure; it does not authorize any billing work.
-- One fixed, bounded metadata LOG followed by mandatory P0001 abort. Never
-- commit, install a cron, read a secret, call HTTP/wake/restart or write app data.
-- After the expected failure independently verify extension/schema absence,
-- original no-op/worker/CHECK, exactly two history rows and preservation digests.
begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

do $probe_preflight$
declare cfg billing_private.worker_config;owner_row cluera_billing_private.processing_owner;p pg_proc;pin text;
begin
 if current_user<>'postgres' or current_database()<>'postgres'
   or current_setting('session_replication_role')<>'origin'
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
 lock table billing_private.worker_config,cluera_billing_private.processing_owner in share mode;
 if (select count(*) from billing_private.worker_config)<>1
   or (select count(*) from cluera_billing_private.processing_owner)<>1
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
 select * into strict cfg from billing_private.worker_config;
 select * into strict owner_row from cluera_billing_private.processing_owner;
 select * into strict p from pg_proc where oid='billing_private.wake_worker()'::regprocedure;
 if not cfg.singleton or cfg.enabled or cfg.secret_id is not null
   or cfg.last_sent_at is not null or cfg.last_request_id is not null
   or not owner_row.singleton or owner_row.owner<>'cluera' or owner_row.epoch<>1 or owner_row.account_digest is not null
   or not exists(select 1 from pg_constraint where conrelid='billing_private.worker_config'::regclass
     and conname='clean_worker_stays_passive' and contype='c' and convalidated
     and pg_get_expr(conbin,conrelid)='((NOT enabled) AND (secret_id IS NULL))')
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
 if p.prosrc<>'begin return;end' or p.prosecdef or p.prorettype<>'void'::regtype
   or p.proretset or p.proisstrict or p.proleakproof or p.prokind<>'f' or p.provolatile<>'v' or p.proparallel<>'u'
   or p.prolang<>(select oid from pg_language where lanname='plpgsql')
   or p.proowner<>(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from array['search_path=""','lock_timeout=2s','statement_timeout=5s']::text[]
   or (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
 -- Baseline provenance: canonical tuple of worker(singleton,enabled,secret_id,
 -- last_sent_at,last_request_id), owner(singleton,owner,epoch,account_digest),
 -- then the exact no-op prosrc; NULL uses the literal sentinel, separated by ':'.
 -- Expected tuple is true:false:NULL:NULL:NULL:true:cluera:1:NULL:begin return;end.
 -- Operator must independently read/compare this same checksum before approval;
 -- it supplements, not replaces, the explicit guards and full business digests.
 pin:=md5(concat_ws(':',cfg.singleton::text,cfg.enabled::text,coalesce(cfg.secret_id::text,'NULL'),
   coalesce(cfg.last_sent_at::text,'NULL'),coalesce(cfg.last_request_id::text,'NULL'),owner_row.singleton::text,
   owner_row.owner,owner_row.epoch::text,coalesce(owner_row.account_digest,'NULL'),p.prosrc));
 if pin<>'590a02220f8d4eca28d2b9a2434851cf'
   or to_regnamespace('net') is not null or to_regnamespace('cron') is not null
   or exists(select 1 from pg_extension where extname in('pg_net','pg_cron'))
   or not exists(select 1 from pg_available_extensions where name='pg_net' and default_version='0.20.4')
   or not exists(select 1 from pg_available_extension_versions where name='pg_net' and version='0.20.4' and not installed)
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
 if to_regclass('supabase_migrations.schema_migrations') is null
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
 if (select array_agg(version::text order by version::text) from supabase_migrations.schema_migrations)
   is distinct from array['20261016014532','20261016015041']::text[]
 then raise exception 'CLUERA_PG_NET_COMPAT_PREFLIGHT';end if;
end $probe_preflight$;

-- Supabase ignores VERSION clauses; the preflight requires exact default0.20.4.
-- SINGLE TRANSIENT NATIVE INSTALL. It must be rolled back by the final exception.
create extension pg_net with schema extensions;

do $probe_inspect$
declare p pg_proc;e pg_extension;report jsonb;function_count bigint;relation_count bigint;
 queue_empty boolean:=false;response_empty boolean:=false;owner_class text:='OTHER';
begin
 select * into e from pg_extension where extname='pg_net';
 select * into p from pg_proc where oid=to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)');
 select count(*) into function_count from pg_proc where pronamespace=to_regnamespace('net');
 select count(*) into relation_count from pg_class where relnamespace=to_regnamespace('net');
 if p.proowner=(select oid from pg_roles where rolname='postgres') then owner_class:='postgres';
 elsif p.proowner=(select oid from pg_roles where rolname='supabase_admin') then owner_class:='supabase_admin';end if;
 if to_regclass('net.http_request_queue') is not null then
   execute 'select not exists(select 1 from net.http_request_queue)' into queue_empty;end if;
 if to_regclass('net._http_response') is not null then
   execute 'select not exists(select 1 from net._http_response)' into response_empty;end if;
 report:=jsonb_build_object(
   'component','CLUERA_PG_NET_COMPAT','rollbackOnly',true,'activationAuthorized',false,
   'inspectionCompleted',true,'mutationsCommitted',false,'httpCalls',0,'secretReads',0,
   'defaultVersionExpected',exists(select 1 from pg_available_extensions where name='pg_net' and default_version='0.20.4'),
   'extensionVersionExpected',coalesce(e.extversion='0.20.4',false),
   'extensionNamespaceExpected',coalesce(e.extnamespace='extensions'::regnamespace,false),
   'extensionNonRelocatable',coalesce(not e.extrelocatable,false),
   'functionCount',case when function_count between 0 and 64 then function_count else null end,
   'relationCount',case when relation_count between 0 and 16 then relation_count else null end,
   'functionCountExpected',function_count=12,'relationCountExpected',relation_count=6,
   'manifestCountsWithinBound',function_count between 0 and 64 and relation_count between 0 and 16,
   'queueEmpty',queue_empty,'responseEmpty',response_empty,
   'netSchemaOwner',case (select nspowner from pg_namespace where oid=to_regnamespace('net'))
     when (select oid from pg_roles where rolname='postgres') then 'postgres'
     when (select oid from pg_roles where rolname='supabase_admin') then 'supabase_admin' else 'OTHER' end,
   'currentRoleInSchemaOwner',coalesce(pg_has_role(current_user,(select nspowner from pg_namespace where oid=to_regnamespace('net')),'USAGE'),false),
   'currentRoleInPostOwner',coalesce(pg_has_role(current_user,p.proowner,'USAGE'),false),
   'currentRoleInQueueOwner',coalesce(pg_has_role(current_user,(select relowner from pg_class where oid=to_regclass('net.http_request_queue')),'USAGE'),false),
   'appNetAccessPresent',exists(select 1 from(values('anon'),('authenticated'),('service_role')) r(role_name)
     where has_schema_privilege(r.role_name,to_regnamespace('net'),'USAGE,CREATE')
       or exists(select 1 from pg_proc f where f.pronamespace=to_regnamespace('net') and has_function_privilege(r.role_name,f.oid,'EXECUTE'))),
   'postExists',p.oid is not null,'postOwner',owner_class,
   'postInvoker',coalesce(not p.prosecdef,false),'postSecurityDefiner',coalesce(p.prosecdef,false),
   'postReturnsBigint',coalesce(p.prorettype='bigint'::regtype,false),
   'postLanguagePlpgsql',coalesce(p.prolang=(select oid from pg_language where lanname='plpgsql'),false),
   'postArgCountExpected',coalesce(p.pronargs=5,false),
   'postArgNamesExpected',coalesce(p.proargnames=array['url','body','params','headers','timeout_milliseconds']::text[],false),
   'postExtensionMember',exists(select 1 from pg_depend where classid='pg_proc'::regclass and objid=p.oid
     and refclassid='pg_extension'::regclass and refobjid=e.oid and deptype='e'),
   'postSetReturning',coalesce(p.proretset,false),
   'postConfigEmpty',p.oid is not null and coalesce(cardinality(p.proconfig),0)=0,
   'postHasSearchPathSetting',coalesce(exists(select 1 from unnest(p.proconfig) setting where setting like 'search_path=%'),false),
   'postSearchPathEmpty',coalesce('search_path=""'=any(p.proconfig),false),
   'postBodyWithinBound',p.oid is not null and length(p.prosrc)<=65536,
   'postBodyLength',case when p.oid is not null and length(p.prosrc)<=65536 then length(p.prosrc) else null end,
   'postBodyMd5',case when p.oid is not null and length(p.prosrc)<=65536 then md5(p.prosrc) else null end);
 if octet_length('CLUERA_PG_NET_COMPAT '||report::text)>1900 then
   raise log 'CLUERA_PG_NET_COMPAT %','{"inspectionCompleted":false,"rollbackOnly":true,"reportBoundExceeded":true}';
 else raise log 'CLUERA_PG_NET_COMPAT %',report::text;end if;
 -- This unconditional exception is the safety boundary. It is NOT an error to
 -- suppress, retry automatically, catch-and-commit or turn into a successful migration.
 raise exception using errcode='P0001',message='CLUERA_PG_NET_COMPAT_ROLLBACK_ONLY';
end $probe_inspect$;
