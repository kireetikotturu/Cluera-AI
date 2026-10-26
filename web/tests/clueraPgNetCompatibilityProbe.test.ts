import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it} from 'vitest';

const proposal=readFileSync('../docs/proposals/cluera-pg-net-compatibility-probe.sql','utf8');
const foundation=readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8');
const installation='create extension pg_net with schema extensions;';
let db:PGlite;const notices:string[]=[];

// SYNTHETIC CATALOG SIMULATION ONLY. PGlite cannot install Supabase's native
// pg_net/C worker. Replace ONLY the single native CREATE with explicit temporary
// in-memory catalog/object fixtures. All proposal guards, fixed reporting and
// mandatory exception execute unchanged. This is NOT native/hosted acceptance.
function catalogMock({owner='postgres',definer=false,language='plpgsql',argumentNames=true,missing=false,body='begin return 0;end',config=''}={}){
 const post=missing?'':`create function net.http_post(${argumentNames?'url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds integer':'a text,b jsonb,c jsonb,d jsonb,e integer'})
 returns bigint language ${language} ${definer?'security definer':'security invoker'} ${config} as $post$${body}$post$;
 alter function net.http_post(text,jsonb,jsonb,jsonb,integer) owner to ${owner};`;
 return `create schema net;create domain net.http_method as text;
 create unlogged table net.http_request_queue(id bigserial,method net.http_method,url text,headers jsonb,body bytea,timeout_milliseconds integer);
 create unlogged table net._http_response(id bigint,status_code integer,content_type text,headers jsonb,content text,timed_out boolean,error_msg text,created timestamptz default now());
 create index _http_response_created_idx on net._http_response(created);
 create type net.request_status as enum('PENDING','SUCCESS','ERROR');
 create type net.http_response as(status_code integer,headers jsonb,body text);
 create type net.http_response_result as(status net.request_status,message text,response net.http_response);
 create function net.check_worker_is_up() returns void language plpgsql as $$begin raise exception 'SYNTHETIC_NETWORK_FORBIDDEN';end$$;
 create function net._await_response(bigint) returns boolean language sql as $$select false$$;
 create function net._urlencode_string(character varying) returns text language sql as $$select $1::text$$;
 create function net._encode_url_with_params_array(text,text[]) returns text language sql as $$select $1$$;
 create function net.worker_restart() returns boolean language plpgsql as $$begin raise exception 'SYNTHETIC_NETWORK_FORBIDDEN';end$$;
 create function net.wait_until_running() returns void language plpgsql as $$begin raise exception 'SYNTHETIC_NETWORK_FORBIDDEN';end$$;
 create function net.wake() returns void language plpgsql as $$begin raise exception 'SYNTHETIC_NETWORK_FORBIDDEN';end$$;
 create function net.http_get(text,jsonb,jsonb,integer) returns bigint language plpgsql as $$begin raise exception 'SYNTHETIC_NETWORK_FORBIDDEN';end$$;
 ${post}
 create function net.http_delete(text,jsonb,jsonb,integer,jsonb) returns bigint language plpgsql as $$begin raise exception 'SYNTHETIC_NETWORK_FORBIDDEN';end$$;
 create function net._http_collect_response(bigint,boolean) returns net.http_response_result language sql as $$select null::net.http_response_result$$;
 create function net.http_collect_response(bigint,boolean) returns net.http_response_result language sql as $$select null::net.http_response_result$$;
 insert into pg_extension(oid,extname,extowner,extnamespace,extrelocatable,extversion)
 values(90001,'pg_net',(select oid from pg_roles where rolname='postgres'),'extensions'::regnamespace,false,'0.20.4');
 insert into pg_depend(classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype)
 select 'pg_proc'::regclass,oid,0,'pg_extension'::regclass,90001,0,'e' from pg_proc where pronamespace='net'::regnamespace;`;
}
function simulated(mock=catalogMock()){
 expect(proposal.split(installation)).toHaveLength(2);return proposal.replace(installation,()=>mock);
}
async function snapshot(){
 const state=(await db.query(`select
  (select jsonb_agg(to_jsonb(w) order by singleton) from billing_private.worker_config w) worker,
  (select jsonb_agg(to_jsonb(o) order by singleton) from cluera_billing_private.processing_owner o) owner,
  (select jsonb_agg(jsonb_build_object('name',conname,'validated',convalidated,'definition',pg_get_constraintdef(oid)) order by conname)
    from pg_constraint where conrelid='billing_private.worker_config'::regclass) constraints,
  (select jsonb_build_object('source',prosrc,'definer',prosecdef,'configuration',proconfig,'acl',proacl::text)
    from pg_proc where oid='billing_private.wake_worker()'::regprocedure) wake,
  (select array_agg(version order by version) from supabase_migrations.schema_migrations) migrations,
  to_regnamespace('net') is null net_absent,
  not exists(select 1 from pg_extension where extname='pg_net') extension_absent`)).rows;
 const tables=(await db.query<{schema:string;name:string}>(`select n.nspname schema,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind='r' and n.nspname in('public','billing_private','cluera_billing_private') order by n.nspname,c.relname`)).rows;
 const business=[];
 for(const row of tables){
  // Names originate only from this isolated synthetic fixture's system catalog.
  expect(row.schema).toMatch(/^[a-z_]+$/);expect(row.name).toMatch(/^[a-z_]+$/);
  business.push({table:row.schema+'.'+row.name,rows:(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${row.schema}.${row.name} t`)).rows});
 }
 return {state,business};
}
async function reject(sql:string,pattern=/CLUERA_PG_NET_COMPAT_ROLLBACK_ONLY/){
 try{await expect(db.exec(sql,{onNotice:notice=>notices.push(notice.message)})).rejects.toThrow(pattern);}finally{await db.exec('rollback');}
}
function reports(){return notices.filter(line=>line.startsWith('CLUERA_PG_NET_COMPAT ')).map(line=>{
 const body=line.slice('CLUERA_PG_NET_COMPAT '.length);expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1900);return JSON.parse(body);
});}

beforeAll(async()=>{
 db=new PGlite();await db.waitReady;
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_admin;create role hidden_fixture_owner;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);`);
 await db.exec(foundation);
 await db.exec(`create schema extensions;create schema probe_fixture;create schema supabase_migrations;
 create table supabase_migrations.schema_migrations(version text primary key);
 insert into supabase_migrations.schema_migrations values('20261016014532'),('20261016015041');
 create table probe_fixture.availability(name text,default_version text);
 insert into probe_fixture.availability values('pg_net','0.20.4');
 drop view pg_catalog.pg_available_extensions;
 create view pg_catalog.pg_available_extensions as select name::name collate "C",default_version,null::text installed_version,null::text comment from probe_fixture.availability;
 drop view pg_catalog.pg_available_extension_versions;
 create view pg_catalog.pg_available_extension_versions as select name::name collate "C",default_version as version,false installed from probe_fixture.availability;
 set client_min_messages='log';`);
 // Existing trial/customer state is synthetic; the probe never calls this API.
 await db.exec(`insert into auth.users values('00000000-0000-4000-8000-000000001001','synthetic@example.invalid',now());
 insert into auth.sessions values('00000000-0000-4000-8000-000000001002','00000000-0000-4000-8000-000000001001',null,'aal2');
 select public.customer_authorize('00000000-0000-4000-8000-000000001001','00000000-0000-4000-8000-000000001002');`);
});
afterAll(async()=>{if(db)await db.close();});

it('is a separate-approval, fixed-target, single-install probe with no commit or financial/network/secret operation',()=>{
 expect(proposal).toContain('UNAPPLIED ROLLBACK-ONLY');expect(proposal).toContain('NEW explicit owner approval');expect(proposal).toContain('yhnqlfcgrmckhyjdxegg');
 expect(createHash('sha256').update(foundation).digest('hex')).toBe('ae0f1eeef39e9d988386c1c36b3150cee8b10895b38e7d270d373f4b9009379e');
 const sql=proposal.replace(/--[^\n]*/g,'');expect(sql.match(/create\s+extension/gi)).toHaveLength(1);
 expect(sql).toContain(installation);expect(sql).not.toMatch(/\bcommit\b|\b(?:insert|update|delete|truncate|grant|revoke|alter)\b/i);
 expect(sql).not.toMatch(/(?:select|perform|call)\s+(?:net\.|vault\.|billing_private\.wake_worker|public\.)/i);
 expect(sql).not.toMatch(/cron\.schedule|cron\.unschedule|decrypted_secret|https:\/\/|sb_secret_|rzp_test_|Authorization|Bearer/i);
 expect(sql).toContain("message='CLUERA_PG_NET_COMPAT_ROLLBACK_ONLY'");expect(sql).not.toMatch(/exception\s+when|when\s+others/i);
 expect(sql).toContain("default_version='0.20.4'");expect(sql).toContain("'590a02220f8d4eca28d2b9a2434851cf'");
});

it('fixed metadata report is logged then mandatory failure rolls back every transient object/history/data change',async()=>{
 notices.length=0;const before=await snapshot();await reject(simulated());expect(await snapshot()).toEqual(before);
 const [report]=reports();expect(reports()).toHaveLength(1);
 expect(report).toMatchObject({component:'CLUERA_PG_NET_COMPAT',rollbackOnly:true,activationAuthorized:false,inspectionCompleted:true,mutationsCommitted:false,
  httpCalls:0,secretReads:0,defaultVersionExpected:true,extensionVersionExpected:true,extensionNamespaceExpected:true,extensionNonRelocatable:true,
  functionCount:12,relationCount:6,functionCountExpected:true,relationCountExpected:true,manifestCountsWithinBound:true,queueEmpty:true,responseEmpty:true,
  netSchemaOwner:'postgres',currentRoleInSchemaOwner:true,currentRoleInPostOwner:true,currentRoleInQueueOwner:true,appNetAccessPresent:true,
  postExists:true,postOwner:'postgres',postInvoker:true,postSecurityDefiner:false,postReturnsBigint:true,postLanguagePlpgsql:true,
  postArgCountExpected:true,postArgNamesExpected:true,postExtensionMember:true,postSetReturning:false,postConfigEmpty:true,
  postHasSearchPathSetting:false,postSearchPathEmpty:false,postBodyWithinBound:true,postBodyLength:'begin return 0;end'.length});
 expect(report.postBodyMd5).toBe(createHash('md5').update('begin return 0;end').digest('hex'));
 const worst={...report,postOwner:'supabase_admin',netSchemaOwner:'supabase_admin',postBodyLength:65536,functionCount:64,relationCount:16};
 for(const key of Object.keys(worst))if(typeof worst[key]==='boolean')worst[key]=false;
 // jsonb text includes spaces after separators; bound the FULL prefix plus the
 // longest permitted enum/counter/body-length/boolean representation as well.
 expect(Buffer.byteLength('CLUERA_PG_NET_COMPAT '+JSON.stringify(worst).replace(/,/g,', ').replace(/:/g,': '))).toBeLessThanOrEqual(1900);
 expect((await db.query('select * from public.customer_trial_grants')).rows).toHaveLength(1);
});

it('observes owner/security/argument/config drift without granting access or leaking metadata text',async()=>{
 notices.length=0;const before=await snapshot();
 await reject(simulated(catalogMock({owner:'supabase_admin',definer:true,argumentNames:false,config:`set search_path=''`})));expect(await snapshot()).toEqual(before);
 const [report]=reports();expect(report.postOwner).toBe('supabase_admin');expect(report.postSecurityDefiner).toBe(true);expect(report.postInvoker).toBe(false);
 expect(report.postArgNamesExpected).toBe(false);expect(report.postConfigEmpty).toBe(false);expect(report.postHasSearchPathSetting).toBe(true);expect(report.postSearchPathEmpty).toBe(true);
 notices.length=0;const privateBody="begin raise exception 'SYNTHETIC_PRIVATE_BODY_MUST_NOT_ECHO';end";
 await reject(simulated(catalogMock({owner:'hidden_fixture_owner',body:privateBody})));expect(await snapshot()).toEqual(before);
 const out=JSON.stringify(reports());expect(reports()[0].postOwner).toBe('OTHER');expect(out).not.toContain('hidden_fixture_owner');expect(out).not.toContain(privateBody);
 expect(out).not.toContain('SYNTHETIC_PRIVATE_BODY_MUST_NOT_ECHO');expect(reports()[0].postBodyMd5).toBe(createHash('md5').update(privateBody).digest('hex'));
});

it('missing metadata or an unavailable native installer still aborts without a successful migration',async()=>{
 notices.length=0;const before=await snapshot();await reject(simulated(catalogMock({missing:true})));expect(await snapshot()).toEqual(before);
 const [report]=reports();expect(report.postExists).toBe(false);expect(report.postOwner).toBe('OTHER');expect(report.postBodyMd5).toBeNull();expect(report.functionCountExpected).toBe(false);
 notices.length=0;await reject(simulated(`do $$begin raise exception 'SYNTHETIC_NATIVE_INSTALL_UNAVAILABLE';end$$;`),/SYNTHETIC_NATIVE_INSTALL_UNAVAILABLE/);
 expect(await snapshot()).toEqual(before);expect(reports()).toHaveLength(0);
});

it('rejects default/absence/history/passivity/owner/noop/ACL drift before any transient install',async()=>{
 const before=await snapshot();
 for(const drift of[
  "update probe_fixture.availability set default_version='0.20.5'",
  'create schema net','create schema cron',
  "insert into supabase_migrations.schema_migrations values('20990101000000')",
  'alter table billing_private.worker_config drop constraint clean_worker_stays_passive',
  "update cluera_billing_private.processing_owner set owner='account'",
  "update cluera_billing_private.processing_owner set account_digest=repeat('a',64)",
  "create or replace function billing_private.wake_worker() returns void language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$begin perform 1;end$$",
  'grant execute on function billing_private.wake_worker() to service_role',
 ]){
  notices.length=0;await db.exec('begin;'+drift+';');await reject(simulated(),/CLUERA_PG_NET_COMPAT_PREFLIGHT/);
  expect(await snapshot()).toEqual(before);expect(reports()).toHaveLength(0);
 }
});

it('caps oversized native body metadata without outputting source or manufacturing successful compatibility',async()=>{
 notices.length=0;const before=await snapshot(),body='begin /*'+'PRIVATE'.repeat(11000)+'*/ return 0;end';
 await reject(simulated(catalogMock({body})));expect(await snapshot()).toEqual(before);
 const [report]=reports();expect(report.postBodyWithinBound).toBe(false);expect(report.postBodyLength).toBeNull();expect(report.postBodyMd5).toBeNull();
 expect(JSON.stringify(report)).not.toContain('PRIVATE');expect(report.rollbackOnly).toBe(true);expect(report.activationAuthorized).toBe(false);
});
