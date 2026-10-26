-- UNAPPLIED REVIEW DRAFT. ONLY yhnqlfcgrmckhyjdxegg.
-- Requires separate owner approval and the exact reviewed pg_net prerequisite.
-- Replaces ONLY the clean no-op wake function. Keeps clean_worker_stays_passive
-- CHECK and disabled/null worker row byte-for-byte unchanged. No cron, secret,
-- merchant pin, payment flag, owner/epoch switch or network call occurs on apply.
-- Independently verify connector project identity and all preservation digests.
-- Future activation needs NEW approval/DDL for the CHECK, sealed worker secret,
-- matching server configuration, schedule and real delivery/lease acceptance.
begin;
set local lock_timeout='2s';
set local statement_timeout='8s';
do $passive_preflight$
declare p pg_proc;role_name text;nonempty boolean;
begin
 if current_user<>'postgres' or current_database()<>'postgres'
   or current_setting('session_replication_role')<>'origin'
 then raise exception 'Clean scheduler executor mismatch';end if;
 lock table billing_private.worker_config in share mode;
 select * into strict p from pg_proc where oid='billing_private.wake_worker()'::regprocedure;
 if p.prosrc<>'begin return;end' or p.prosecdef or p.prorettype<>'void'::regtype
   or p.proretset or p.proisstrict or p.proleakproof or p.prokind<>'f' or p.provolatile<>'v' or p.proparallel<>'u'
   or p.prolang<>(select oid from pg_language where lanname='plpgsql')
   or p.proowner<>(select oid from pg_roles where rolname='postgres')
   or p.proconfig is distinct from array['search_path=""','lock_timeout=2s','statement_timeout=5s']::text[]
   or (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
 then raise exception 'Reviewed clean scheduler function changed';end if;
 if (select count(*) from billing_private.worker_config)<>1
   or exists(select 1 from billing_private.worker_config where not singleton or enabled or secret_id is not null or last_sent_at is not null or last_request_id is not null)
   or not exists(select 1 from pg_constraint where conrelid='billing_private.worker_config'::regclass
     and conname='clean_worker_stays_passive' and contype='c' and convalidated
     and pg_get_expr(conbin,conrelid)='((NOT enabled) AND (secret_id IS NULL))')
 then raise exception 'Clean scheduler must remain passive';end if;
 if (select count(*) from cluera_billing_private.processing_owner)<>1
   or not exists(select 1 from cluera_billing_private.processing_owner where singleton and owner='cluera' and epoch=1
     and (account_digest is null or account_digest~'^[a-f0-9]{64}$'))
 then raise exception 'Clean scheduler ownership mismatch';end if;
 if to_regclass('cron.job') is not null then
   execute 'select exists(select 1 from cron.job)' into nonempty;
   if nonempty then raise exception 'Clean scheduler job already exists';end if;
 end if;
 if not exists(select 1 from pg_extension where extname='pgcrypto' and extversion='1.3' and extnamespace='extensions'::regnamespace)
   or not exists(select 1 from pg_extension where extname='supabase_vault' and extversion='0.3.1' and extnamespace='vault'::regnamespace)
   or not exists(select 1 from pg_extension where extname='pg_net' and extversion='0.20.4' and extnamespace='extensions'::regnamespace and not extrelocatable)
 then raise exception 'Reviewed scheduler extensions missing';end if;
 if to_regclass('vault.decrypted_secrets') is null or exists(select 1 from net.http_request_queue)
 then raise exception 'Reviewed scheduler resources unavailable';end if;
 if exists(select 1 from(values
   ('extensions.hmac(text,text,text)','pgcrypto','bytea'),
   ('extensions.digest(text,text)','pgcrypto','bytea'),
   ('net.http_post(text,jsonb,jsonb,jsonb,integer)','pg_net','bigint')
 ) expected(signature,extension_name,result_type)
 left join pg_proc f on f.oid=to_regprocedure(expected.signature)
 left join pg_extension e on e.extname=expected.extension_name
 where f.oid is null or f.prosecdef or f.proretset or f.prorettype<>to_regtype(expected.result_type)
   or not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=f.oid
     and d.refclassid='pg_extension'::regclass and d.refobjid=e.oid and d.deptype='e'))
 then raise exception 'Reviewed scheduler extension function mismatch';end if;
 foreach role_name in array array['anon','authenticated','service_role'] loop
   if has_schema_privilege(role_name,'net','USAGE,CREATE')
     or exists(select 1 from pg_proc where pronamespace='net'::regnamespace and has_function_privilege(role_name,oid,'EXECUTE'))
     or has_table_privilege(role_name,'net.http_request_queue','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege(role_name,'net._http_response','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     or has_sequence_privilege(role_name,'net.http_request_queue_id_seq','USAGE,SELECT,UPDATE')
   then raise exception 'Reviewed scheduler net access is not sealed';end if;
 end loop;
end $passive_preflight$;

create or replace function billing_private.wake_worker() returns void language plpgsql
security invoker set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $wake$
declare cfg billing_private.worker_config;owner_row cluera_billing_private.processing_owner;
 credential text;issued bigint;nonce uuid;proof text;request_id bigint;
 destination constant text:='https://cluera-ai-staging.vercel.app/api/internal/billing/cluera/tick';
begin
 -- This branch is unreachable while clean_worker_stays_passive is retained.
 -- Read/lock the disabled gate BEFORE touching Vault or any network resource.
 select * into cfg from billing_private.worker_config where singleton for update skip locked;
 if not found or not cfg.enabled or cfg.secret_id is null
   or (cfg.last_sent_at is not null and cfg.last_sent_at>clock_timestamp()-interval '50 seconds') then return;end if;
 select * into strict owner_row from cluera_billing_private.processing_owner where singleton for share;
 if owner_row.owner<>'cluera' or owner_row.epoch not between 1 and 9007199254740991
   or owner_row.account_digest is null or owner_row.account_digest!~'^[a-f0-9]{64}$' then return;end if;
 select decrypted_secret into credential from vault.decrypted_secrets where id=cfg.secret_id;
 if credential is null or length(credential) not between 32 and 256 then return;end if;
 issued:=floor(extract(epoch from clock_timestamp()))::bigint;nonce:=gen_random_uuid();
 proof:=encode(extensions.hmac(concat_ws(E'\n','CLUERA-BILLING-TICK','POST',destination,
   owner_row.epoch,issued,nonce,owner_row.account_digest,encode(extensions.digest('{}','sha256'),'hex')),credential,'sha256'),'hex');
 -- pg_net stores headers in plaintext. Queue ONLY this short-lived one-use
 -- nonce/epoch/body-bound HMAC proof, NEVER an API key, bearer or worker secret.
 select net.http_post(url:=destination,body:='{}'::jsonb,params:='{}'::jsonb,
   headers:=jsonb_build_object('Content-Type','application/json','X-Cluera-Billing-Time',issued::text,
     'X-Cluera-Billing-Nonce',nonce::text,'X-Cluera-Billing-Epoch',owner_row.epoch::text,'X-Cluera-Billing-Proof',proof),
   timeout_milliseconds:=170000) into request_id;
 update billing_private.worker_config set last_sent_at=clock_timestamp(),last_request_id=request_id where singleton;
end $wake$;
revoke all on function billing_private.wake_worker() from public,anon,authenticated,service_role;
commit;
-- NOT an execution/activation clearance: test hosted pg_net/background-worker
-- compatibility, exact HMAC/clock/nonce acceptance and delivery AFTER separate
-- activation approval. No cron/Vault/constraint change is part of this proposal.
