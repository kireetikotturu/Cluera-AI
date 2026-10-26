-- UNAPPLIED REVIEW DRAFT. Separate owner approval is required.
-- ONLY yhnqlfcgrmckhyjdxegg / cluera-ai-production; independently verify the
-- connector target before execution. PostgreSQL has no reliable project-ref GUC.
-- Exact source reviewed: https://github.com/supabase/pg_net/tree/v0.20.4
-- Creates pg_net0.20.4 in extensions, its net schema,2 unlogged tables,
-- queue sequence,response index,4 named types/domain and12 functions.
-- Replaces upstream PUBLIC grants with owner-only access. No cron installation,
-- job, credential, HTTP request, wake/restart call or application-data write.
-- Extension installation may start platform infrastructure, not billing.
-- Supabase ignores VERSION clauses since2026-08-05. Do NOT request a version
-- or auto-upgrade: require reviewed default0.20.4 BEFORE CREATE and installed
-- version0.20.4 afterward, atomically aborting on a platform default change.
begin;
set local lock_timeout='2s';
set local statement_timeout='8s';
do $prerequisite$
declare installed_version text;nonempty boolean;
begin
 if current_user<>'postgres' or current_database()<>'postgres'
   or current_setting('session_replication_role')<>'origin'
 then raise exception 'Clean scheduler executor mismatch';end if;
 lock table billing_private.worker_config in share mode;
 if (select count(*) from billing_private.worker_config)<>1
   or exists(select 1 from billing_private.worker_config where not singleton or enabled or secret_id is not null or last_sent_at is not null or last_request_id is not null)
   or not exists(select 1 from pg_constraint where conrelid='billing_private.worker_config'::regclass
     and conname='clean_worker_stays_passive' and contype='c' and convalidated
     and pg_get_expr(conbin,conrelid)='((NOT enabled) AND (secret_id IS NULL))')
 then raise exception 'Clean scheduler must remain passive';end if;
 if (select count(*) from cluera_billing_private.processing_owner)<>1
   or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera' and epoch=1)
 then raise exception 'Clean scheduler ownership mismatch';end if;
 if to_regclass('cron.job') is not null then
   execute 'select exists(select 1 from cron.job)' into nonempty;
   if nonempty then raise exception 'Clean scheduler job already exists';end if;
 end if;
 select extversion into installed_version from pg_extension where extname='pg_net';
 if not exists(select 1 from pg_available_extensions where name='pg_net' and default_version='0.20.4')
 then raise exception 'Reviewed pg_net default version mismatch';end if;
 if installed_version is not null and installed_version<>'0.20.4' then raise exception 'Reviewed pg_net version mismatch';end if;
 if installed_version is null then
   if to_regnamespace('net') is not null then raise exception 'Unexpected existing net schema';end if;
   if not exists(select 1 from pg_available_extension_versions where name='pg_net' and version='0.20.4' and not installed)
   then raise exception 'Reviewed pg_net version unavailable';end if;
 end if;
end $prerequisite$;

-- IF NOT EXISTS supports a separately preinstalled exact version only; all
-- identities/security/empty-state checks below still run and fail atomically.
create extension if not exists pg_net with schema extensions;
do $extension_identity$
declare extension_id oid;signature text;
begin
 select oid into strict extension_id from pg_extension where extname='pg_net'
   and extversion='0.20.4' and extnamespace='extensions'::regnamespace and not extrelocatable;
 if (select count(*) from pg_proc where pronamespace='net'::regnamespace)<>12
   -- Composite http_response/http_response_result also have pg_class rows.
   or (select count(*) from pg_class where relnamespace='net'::regnamespace)<>6
 then raise exception 'Reviewed pg_net object manifest mismatch';end if;
 foreach signature in array array['net.check_worker_is_up()','net._await_response(bigint)',
   'net._urlencode_string(character varying)','net._encode_url_with_params_array(text,text[])',
   'net.worker_restart()','net.wait_until_running()','net.wake()',
   'net.http_get(text,jsonb,jsonb,integer)','net.http_post(text,jsonb,jsonb,jsonb,integer)',
   'net.http_delete(text,jsonb,jsonb,integer,jsonb)',
   'net._http_collect_response(bigint,boolean)','net.http_collect_response(bigint,boolean)'] loop
   if to_regprocedure(signature) is null or not exists(select 1 from pg_depend
     where classid='pg_proc'::regclass and objid=to_regprocedure(signature)
       and refclassid='pg_extension'::regclass and refobjid=extension_id and deptype='e')
   then raise exception 'Reviewed pg_net function membership mismatch';end if;
 end loop;
 if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang
   where p.oid='net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure
     and p.prorettype='bigint'::regtype and not p.prosecdef and not p.proretset
     and l.lanname='plpgsql' and p.proowner=(select oid from pg_roles where rolname='postgres')
     and p.proargnames=array['url','body','params','headers','timeout_milliseconds']::text[])
 then raise exception 'Reviewed pg_net POST signature mismatch';end if;
 if not exists(select 1 from pg_class where oid='net.http_request_queue'::regclass and relkind='r' and relpersistence='u')
   or not exists(select 1 from pg_class where oid='net._http_response'::regclass and relkind='r' and relpersistence='u')
   or to_regclass('net.http_request_queue_id_seq') is null or to_regclass('net._http_response_created_idx') is null
   or to_regtype('net.http_method') is null or to_regtype('net.request_status') is null
   or to_regtype('net.http_response') is null or to_regtype('net.http_response_result') is null
 then raise exception 'Reviewed pg_net relation or type mismatch';end if;
 if exists(select 1 from net.http_request_queue) or exists(select 1 from net._http_response)
 then raise exception 'Clean pg_net queue must be empty';end if;
end $extension_identity$;

-- PostgreSQL owners retain implicit rights. Do not change platform roles,
-- pgcrypto/Vault ACLs or any global default privileges.
revoke all on schema net from public,anon,authenticated,service_role;
revoke all on all tables in schema net from public,anon,authenticated,service_role;
revoke all on all sequences in schema net from public,anon,authenticated,service_role;
revoke all on all functions in schema net from public,anon,authenticated,service_role;
revoke all on type net.http_method,net.request_status,net.http_response,net.http_response_result from public,anon,authenticated,service_role;
do $closed_access$
declare role_name text;
begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
   if has_schema_privilege(role_name,'net','USAGE,CREATE')
     or exists(select 1 from pg_proc where pronamespace='net'::regnamespace and has_function_privilege(role_name,oid,'EXECUTE'))
     or has_table_privilege(role_name,'net.http_request_queue','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege(role_name,'net._http_response','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_sequence_privilege(role_name,'net.http_request_queue_id_seq','USAGE,SELECT,UPDATE')
   then raise exception 'Clean pg_net privilege mismatch';end if;
 end loop;
end $closed_access$;
commit;
