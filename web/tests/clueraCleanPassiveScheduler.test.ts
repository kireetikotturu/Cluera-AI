import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {expect,it} from 'vitest';
import {CLUERA_WORKER_URL,workerProofMessage} from '../lib/payments/cluera/scheduler';

const foundation=readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8');
const prerequisite=readFileSync('../docs/proposals/cluera-clean-pg-net-prerequisite.sql','utf8');
const passive=readFileSync('../docs/proposals/cluera-clean-passive-scheduler.sql','utf8');
const signatures=['net.check_worker_is_up()','net._await_response(bigint)',
 'net._urlencode_string(character varying)','net._encode_url_with_params_array(text,text[])',
 'net.worker_restart()','net.wait_until_running()','net.wake()',
 'net.http_get(text,jsonb,jsonb,integer)','net.http_post(text,jsonb,jsonb,jsonb,integer)',
 'net.http_delete(text,jsonb,jsonb,integer,jsonb)',
 'net._http_collect_response(bigint,boolean)','net.http_collect_response(bigint,boolean)'];

// Synthetic ONLY: PGlite cannot load Supabase's native pg_net/Vault extensions.
// These explicit in-memory catalog rows/functions/availability view model their reviewed identity
// and queue API; no network is available. Exact proposal bytes are then executed.
// CREATE EXTENSION IF NOT EXISTS sees the simulated installed extension and
// skips installation. This is NOT hosted extension-install/C-worker acceptance.
async function fixture(harden=true){
 const db=new PGlite();await db.waitReady;
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);`);
 await db.exec(foundation);
 await db.exec(`create schema extensions;create schema vault;create schema net;
 create table extensions.synthetic_availability(name text,default_version text);
 insert into extensions.synthetic_availability values('pg_net','0.20.4');
 create or replace view pg_catalog.pg_available_extensions as select a.name::name collate "C" as name,a.default_version,
   (select e.extversion from pg_extension e where e.extname=a.name) as installed_version,null::text as comment
   from extensions.synthetic_availability a;
 create table vault.synthetic_secrets(id uuid primary key,decrypted_secret text);
 create view vault.decrypted_secrets as select * from vault.synthetic_secrets;
 create table extensions.proofs(message text,credential text);
 create function extensions.digest(text,text) returns bytea language sql as $$select decode('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a','hex')$$;
 create function extensions.hmac(message text,credential text,algorithm text) returns bytea language plpgsql as $$begin insert into extensions.proofs values(message,credential);return decode(repeat('a',64),'hex');end$$;
 create domain net.http_method as text;
 create unlogged table net.http_request_queue(id bigserial,method net.http_method not null,url text not null,headers jsonb,body bytea,timeout_milliseconds integer not null);
 create unlogged table net._http_response(id bigint,status_code integer,content_type text,headers jsonb,content text,timed_out boolean,error_msg text,created timestamptz not null default now());
 create index _http_response_created_idx on net._http_response(created);
 create type net.request_status as enum('PENDING','SUCCESS','ERROR');
 create type net.http_response as(status_code integer,headers jsonb,body text);
 create type net.http_response_result as(status net.request_status,message text,response net.http_response);
 create function net.check_worker_is_up() returns void language plpgsql as $$begin return;end$$;
 create function net._await_response(bigint) returns boolean language sql as $$select false$$;
 create function net._urlencode_string(character varying) returns text language sql as $$select $1::text$$;
 create function net._encode_url_with_params_array(text,text[]) returns text language sql as $$select $1$$;
 create function net.worker_restart() returns boolean language sql as $$select false$$;
 create function net.wait_until_running() returns void language plpgsql as $$begin return;end$$;
 create function net.wake() returns void language plpgsql as $$begin return;end$$;
 create function net.http_get(text,jsonb,jsonb,integer) returns bigint language sql as $$select 0::bigint$$;
 create function net.http_post(url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$declare request_id bigint;begin
 insert into net.http_request_queue(method,url,headers,body,timeout_milliseconds) values('POST',url,headers,convert_to(body::text,'UTF8'),timeout_milliseconds) returning id into request_id;return request_id;end$$;
 create function net.http_delete(text,jsonb,jsonb,integer,jsonb) returns bigint language sql as $$select 0::bigint$$;
 create function net._http_collect_response(bigint,boolean) returns net.http_response_result language sql as $$select null::net.http_response_result$$;
 create function net.http_collect_response(bigint,boolean) returns net.http_response_result language sql as $$select null::net.http_response_result$$;
 insert into pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion) values
 (90001,'pg_net',(select oid from pg_roles where rolname='postgres'),'extensions'::regnamespace,false,'0.20.4'),
 (90002,'pgcrypto',(select oid from pg_roles where rolname='postgres'),'extensions'::regnamespace,true,'1.3'),
 (90003,'supabase_vault',(select oid from pg_roles where rolname='postgres'),'vault'::regnamespace,false,'0.3.1');
 insert into pg_depend(classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype)
 select 'pg_proc'::regclass,oid,0,'pg_extension'::regclass,90001,0,'e' from pg_proc where pronamespace='net'::regnamespace;
 insert into pg_depend(classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype)
 select 'pg_proc'::regclass,oid,0,'pg_extension'::regclass,90002,0,'e' from pg_proc where pronamespace='extensions'::regnamespace and proname in('hmac','digest');
 grant usage on schema net to public;grant all on all tables in schema net to public;grant all on all sequences in schema net to public;`);
 if(harden)await db.exec(prerequisite);
 return db;
}
async function rejected(db:PGlite,sql:string,pattern:RegExp){
 await expect(db.exec(sql)).rejects.toThrow(pattern);await db.exec('rollback');
}
async function state(db:PGlite){return(await db.query(`select * from(select 'worker' as name,to_jsonb(w) as value from billing_private.worker_config w
 union all select 'owner',to_jsonb(o) from cluera_billing_private.processing_owner o
 union all select 'constraint',to_jsonb(c) from pg_constraint c where conrelid='billing_private.worker_config'::regclass
 union all select 'customers',jsonb_agg(to_jsonb(c)) from public.customer_accounts c
 union all select 'trials',jsonb_agg(to_jsonb(c)) from public.customer_trial_grants c
 union all select 'grants',jsonb_agg(to_jsonb(c)) from public.customer_usage_grants c
 union all select 'events',jsonb_agg(to_jsonb(c)) from cluera_billing_private.events c
 union all select 'applications',jsonb_agg(to_jsonb(c)) from cluera_billing_private.applications c) snapshot
 order by name,value::text`)).rows;}

it('pins applied foundation and keeps old proposals/activation operations out of the new drafts',()=>{
 expect(createHash('sha256').update(foundation).digest('hex')).toBe('ae0f1eeef39e9d988386c1c36b3150cee8b10895b38e7d270d373f4b9009379e');
 for(const sql of[prerequisite,passive]){
  expect(sql).toContain('yhnqlfcgrmckhyjdxegg');
  expect(sql).not.toMatch(/dwqltsqumiwsxtkzdoaa|sigmaround-account-staging|wake_worker_account_base|cron\.schedule|cron\.unschedule|vault\.create_secret|drop\s+constraint|alter\s+table/i);
  // Future dispatch is defined inside the function, never invoked on apply.
  const applicationSql=sql.replace(/\$wake\$[\s\S]*?\$wake\$/,'$wake$FUNCTION_BODY$wake$');
  expect(applicationSql).not.toMatch(/(?:select|perform)\s+(?:net\.(?:wake|worker_restart|http_post)|billing_private\.wake_worker)\s*\(/i);
 }
 expect(prerequisite).toContain('create extension if not exists pg_net with schema extensions;');
 expect(prerequisite).toContain("name='pg_net' and default_version='0.20.4'");
 expect(prerequisite).not.toMatch(/create extension[^;]*version\s|'alter extension'/i);
 expect(passive).not.toMatch(/create\s+extension|insert\s+into|delete\s+from/i);
});

it('seals every native net function/table/sequence/browser privilege without changing passive worker or ledger',async()=>{
 const db=await fixture(false);try{
  await db.exec("update extensions.synthetic_availability set default_version='0.20.5'");await rejected(db,prerequisite,/default version mismatch/);
  await db.exec("update extensions.synthetic_availability set default_version='0.20.4'");
  const before=await state(db);await db.exec(prerequisite);expect(await state(db)).toEqual(before);
  for(const role of['anon','authenticated','service_role']){
   const access=(await db.query<{schema:boolean;table:boolean;sequence:boolean}>('select has_schema_privilege($1,\'net\',\'USAGE,CREATE\') schema,has_table_privilege($1,\'net.http_request_queue\',\'SELECT,INSERT,UPDATE,DELETE,TRUNCATE\') as table,has_sequence_privilege($1,\'net.http_request_queue_id_seq\',\'USAGE,SELECT,UPDATE\') sequence',[role])).rows[0];
   expect(access).toEqual({schema:false,table:false,sequence:false});
   for(const signature of signatures)expect((await db.query<{allowed:boolean}>('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).rows[0].allowed).toBe(false);
  }
  expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(0);
 }finally{await db.close();}
},30000);

it('requires exact extension version, membership and an empty queue before hardening',async()=>{
 const db=await fixture(false);try{
  await db.exec("update pg_extension set extversion='0.20.3' where extname='pg_net'");
  await rejected(db,prerequisite,/version mismatch/);
  await db.exec("update pg_extension set extversion='0.20.4' where extname='pg_net';delete from pg_depend where classid='pg_proc'::regclass and objid='net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure and deptype='e'");
  await rejected(db,prerequisite,/membership mismatch/);
  await db.exec("insert into pg_depend(classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype) values('pg_proc'::regclass,'net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure,0,'pg_extension'::regclass,90001,0,'e');insert into net.http_request_queue(method,url,timeout_milliseconds) values('POST','https://synthetic.invalid',1)");
  await rejected(db,prerequisite,/queue must be empty/);
 }finally{await db.close();}
},30000);

it('installs only the wake body while original passive CHECK,row,customers,trials,history and all grants stay unchanged',async()=>{
 const db=await fixture();try{
  const user=crypto.randomUUID(),session=crypto.randomUUID();
  await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,user]);
  await db.query('select public.customer_authorize($1,$2)',[user,session]);
  const before=await state(db);await db.exec(passive);await db.exec('select billing_private.wake_worker();select billing_private.wake_worker()');
  expect(await state(db)).toEqual(before);expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(0);
  expect((await db.query('select * from extensions.proofs')).rows).toHaveLength(0);
  for(const role of['anon','authenticated','service_role'])expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'billing_private.wake_worker()','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
  await expect(db.exec('update billing_private.worker_config set enabled=true')).rejects.toThrow(/clean_worker_stays_passive/);
  await expect(db.exec("update billing_private.worker_config set secret_id='00000000-0000-4000-8000-000000000001'")).rejects.toThrow(/clean_worker_stays_passive/);
 }finally{await db.close();}
},30000);

it('rejects extension/prior-body/security/constraint/ownership drift and a nonsealed network API',async()=>{
 const db=await fixture();try{
  await db.exec("update pg_extension set extversion='0.20.3' where extname='pg_net'");await rejected(db,passive,/extensions missing/);
  await db.exec("update pg_extension set extversion='0.20.4' where extname='pg_net';alter function billing_private.wake_worker() security definer");await rejected(db,passive,/function changed/);
  await db.exec("alter function billing_private.wake_worker() security invoker;grant execute on function net.http_post(text,jsonb,jsonb,jsonb,integer) to public");await rejected(db,passive,/not sealed/);
  await db.exec("revoke all on function net.http_post(text,jsonb,jsonb,jsonb,integer) from public;update cluera_billing_private.processing_owner set owner='account'");await rejected(db,passive,/ownership mismatch/);
  await db.exec("update cluera_billing_private.processing_owner set owner='cluera';alter table billing_private.worker_config drop constraint clean_worker_stays_passive");await rejected(db,passive,/must remain passive/);
  expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(0);
 }finally{await db.close();}
},30000);

it('future-activation SIMULATION matches actual route proof only after removing CHECK locally, never queues long-lived credentials',async()=>{
 const db=await fixture();try{
  await db.exec(passive);
  // This test-only removal is NOT in either proposal and is NOT authorization.
  await db.exec("alter table billing_private.worker_config drop constraint clean_worker_stays_passive;insert into vault.synthetic_secrets values('00000000-0000-4000-8000-000000000900','synthetic-worker-key-00000000000000000');update billing_private.worker_config set enabled=true,secret_id='00000000-0000-4000-8000-000000000900';select billing_private.wake_worker()");
  expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(0);
  await db.exec("update cluera_billing_private.processing_owner set account_digest=repeat('b',64);select billing_private.wake_worker();select billing_private.wake_worker()");
  const rows=(await db.query<{url:string;headers:Record<string,string>;body:Uint8Array;timeout_milliseconds:number}>('select * from net.http_request_queue')).rows;
  expect(rows).toHaveLength(1);const request=rows[0];
  expect(request.url).toBe(CLUERA_WORKER_URL);expect(Buffer.from(request.body).toString()).toBe('{}');expect(request.timeout_milliseconds).toBe(170000);
  expect(Object.keys(request.headers).sort()).toEqual(['Content-Type','X-Cluera-Billing-Epoch','X-Cluera-Billing-Nonce','X-Cluera-Billing-Proof','X-Cluera-Billing-Time'].sort());
  expect(request.headers['X-Cluera-Billing-Proof']).toBe('a'.repeat(64));expect(request.headers['X-Cluera-Billing-Epoch']).toBe('1');
  const input=(await db.query<{message:string;credential:string}>('select * from extensions.proofs')).rows[0];
  expect(input.message).toBe(workerProofMessage(1,Number(request.headers['X-Cluera-Billing-Time']),request.headers['X-Cluera-Billing-Nonce'],'b'.repeat(64)));
  expect(input.credential).toBe('synthetic-worker-key-00000000000000000');expect(JSON.stringify(request)).not.toMatch(/Bearer|synthetic-worker-key|sb_secret_|SUPABASE/);
 }finally{await db.close();}
},30000);
