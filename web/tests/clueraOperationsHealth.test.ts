import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
const proposal=readFileSync('../supabase/migrations/20261019095014_cluera_operations_health.sql','utf8');
let db:PGlite;
const call=async()=>(await db.query<{value:any}>('select public.cluera_operations_health() value')).rows[0].value;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;");
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 await db.exec(proposal);
},60000);
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});
afterAll(async()=>{await db?.close();});
it('adds only bounded STABLE service-only SELECT; no financial mutation, trigger, table or provider call',async()=>{
 const definition=(await db.query<{definition:string}>("select pg_get_functiondef('public.cluera_operations_health()'::regprocedure) definition")).rows[0].definition;
 expect(definition).not.toMatch(/\b(insert|update|delete|truncate|perform|execute|refresh|customer_authorize|wake_worker)\b/i);
 expect(proposal).not.toMatch(/create\s+(table|policy|trigger)|grant\s+(all|select|insert|update|delete)/i);
 const access=(await db.query("select p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') browser,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p where p.oid='public.cluera_operations_health()'::regprocedure")).rows[0];
 expect(access).toEqual({prosecdef:true,provolatile:'s',proconfig:['search_path=""','TimeZone=UTC','lock_timeout=2s','statement_timeout=5s'],anon:false,browser:false,service:true});
 for(const role of ['anon','authenticated']){
  await db.exec('savepoint denied_call');
  await expect(db.exec('set local role '+role+';select public.cluera_operations_health();')).rejects.toThrow(/permission denied/);
  await db.exec('rollback to savepoint denied_call;release savepoint denied_call');
 }
});
it('empty clean snapshot exposes admission-only and bounded counts without identity or financial payloads',async()=>{
 const value=await call();
 expect(value).toMatchObject({version:1,owner:'cluera',epoch:1,merchantBound:false,lastAdmissionAt:null,pendingCount:0,oldestPendingAt:null,legacyPendingCount:0,expiredLeaseCount:0,quarantineCount:0,legacyQuarantineCount:0,uncertainCount:0,expiredUnsettledCount:0,countLimit:1000,processingEvidence:'NONCE_ADMISSION_ONLY'});
 expect(JSON.stringify(value)).not.toMatch(/account_digest|email|payment_id|order_id|user_id|"evidence"|secret/i);
});
it('reads existing current-epoch admission while excluding stale epochs; reads pending, quarantine and expired leases without mutating receipts',async()=>{
 await db.query("insert into cluera_billing_private.worker_nonces(nonce,epoch,issued_at) values($1,1,now())",[randomUUID()]);
 await db.query("insert into cluera_billing_private.worker_nonces(nonce,epoch,issued_at,consumed_at) values($1,2,now(),now()+interval '1 hour')",[randomUUID()]);
 await db.exec("insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,digest,occurred_at,received_at,lease_until,state) values('synthetic_pending',repeat('a',64),'payment.captured','pay_synthetic0001',repeat('b',64),now(),now()-interval '10 minutes',now()-interval '1 minute','PENDING'),('synthetic_quarantine',repeat('a',64),'payment.captured','pay_synthetic0002',repeat('b',64),now(),now(),null,'QUARANTINED');");
 const before=(await db.query('select to_jsonb(e) row from cluera_billing_private.events e order by event_id')).rows;
 const value=await call();expect(value).toMatchObject({pendingCount:1,quarantineCount:1,expiredLeaseCount:1});
 expect(Date.parse(value.lastAdmissionAt)).toBeLessThan(Date.now()+5000);
 expect(Date.parse(value.oldestPendingAt)).toBeLessThan(Date.now()-9*60000);
 expect((await db.query('select to_jsonb(e) row from cluera_billing_private.events e order by event_id')).rows).toEqual(before);
});
it('reports durable uncertain attempts and expired usage reservations; never settles or grants during reads',async()=>{
 const user=randomUUID(),session=randomUUID(),run=randomUUID(),grant=randomUUID();
 await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'synthetic-ops@example.invalid',now())",[user]);
 await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[session,user]);
 await db.query('select public.customer_authorize($1,$2)',[user,session]);
 const revision=(await db.query<{id:string}>("select id from cluera_billing_private.catalog_revisions where kind='PACK'")).rows[0].id;
 await db.query("insert into cluera_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state,created_at) values($1,$2,$3,repeat('a',64),1,'UNCERTAIN',now()-interval '10 minutes')",[user,randomUUID(),revision]);
 await db.query("insert into public.customer_usage_grants(id,user_id,source_key,kind,granted_ms,reserved_ms) values($1,$2,'synthetic-ops','PACK',30000,30000)",[grant,user]);
 await db.query("insert into public.customer_usage_runs(user_id,run_id,auth_session_id,state,sequence,last_action,last_result) values($1,$2,$3,'ACTIVE',0,'START','{}')",[user,run,session]);
 await db.query("insert into public.customer_usage_windows(user_id,run_id,sequence,grant_id,reserved_ms,starts_at,expires_at) values($1,$2,0,$3,30000,now()-interval '10 minutes',now()-interval '10 minutes'+interval '30 seconds')",[user,run,grant]);
 const snapshot=async()=>(await db.query("select jsonb_build_object('intents',(select jsonb_agg(to_jsonb(i)) from cluera_billing_private.intents i),'grants',(select jsonb_agg(to_jsonb(g)) from public.customer_usage_grants g),'runs',(select jsonb_agg(to_jsonb(r)) from public.customer_usage_runs r),'windows',(select jsonb_agg(to_jsonb(w)) from public.customer_usage_windows w),'settlements',(select jsonb_agg(to_jsonb(s)) from public.customer_usage_settlements s)) value")).rows[0].value;
 const before=await snapshot();expect(await call()).toMatchObject({uncertainCount:1,expiredUnsettledCount:1});
 expect(await snapshot()).toEqual(before);
 await db.query("insert into public.customer_usage_settlements(user_id,run_id,sequence,spent_ms,released_ms,reason) values($1,$2,0,1000,29000,'EXPIRED')",[user,run]);
 expect(await call()).toMatchObject({uncertainCount:1,expiredUnsettledCount:0});
});
it('caps counts at1001 and marks exact oldest evidence; does not claim a complete backlog count',async()=>{
 await db.exec("insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,digest,occurred_at,received_at) select 'synthetic_'||lpad(n::text,8,'0'),repeat('a',64),'payment.captured','pay_synthetic0001',repeat('b',64),now(),now()-n*interval '1 second' from generate_series(1,1005) n;");
 const value=await call();expect(value.pendingCount).toBe(1001);expect(value.countLimit).toBe(1000);
 expect(Date.parse(value.oldestPendingAt)).toBeLessThan(Date.now()-1004*1000);
 expect((await db.query('select count(*) n from cluera_billing_private.events')).rows[0].n).toBe(1005);
});
