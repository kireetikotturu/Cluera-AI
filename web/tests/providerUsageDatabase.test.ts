import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {providerUsageReportSchema} from '../lib/aiProviders/usageMetadata';
let db:PGlite;const actor=randomUUID(),session=randomUUID(),credential=randomUUID(),run=randomUUID();
const proposal=readFileSync('../docs/proposals/cluera-provider-usage.sql','utf8');
const migration=readFileSync('../supabase/migrations/20261019095939_cluera_provider_usage_metadata.sql','utf8');
let businessTables:string[]=[],preservedFunctions=0;
async function businessSnapshot(){
 const result:Record<string,string>={};for(const table of businessTables)result[table]=(await db.query<any>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text) digest from ${table} t`)).rows[0].digest;
 return result;
}
async function start(operation=randomUUID(),revision=1){return (await db.query<any>('select public.cluera_provider_usage_start($1,$2,$3,$4,$5,$6) value',[operation,run,'gemini','gemini-3.5-flash',credential,revision])).rows[0].value;}
async function finish(operation:string,usage:object={},outcome='SUCCEEDED'){return (await db.query<any>('select public.cluera_provider_usage_finish($1,$2,12,$3) value',[operation,outcome,usage])).rows[0].value;}
async function report(who=actor){return (await db.query<any>('select public.cluera_provider_usage_admin_read($1,$2) value',[who,session])).rows[0].value;}
beforeAll(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 // Exact clean foundation and vault used by the target, not historical fragments.
 for(const name of ['20261016014532_cluera_clean_foundation','20261016015041_cluera_clean_provider_vault'])await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
 await db.query('insert into auth.users values($1,$2,now())',[actor,'usage-admin@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,actor]);
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[actor]);
 await db.query('select public.customer_usage_command($1,$2,$3,0,\'START\')',[actor,session,run]);
 await db.query("insert into cluera_private.ai_providers(provider,revision,credential_id,sealed,enabled,default_model,probe_status,models,complete) values('gemini',1,$1,'{}',true,'gemini-3.5-flash','VERIFIED','[]',true)",[credential]);
 businessTables=(await db.query<any>("select n.nspname||'.'||c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','billing_private','cluera_billing_private','cluera_private') order by 1")).rows.map(row=>row.name);
 const before=await businessSnapshot();
 const functions=await db.query<any>("select p.oid::int oid,pg_get_function_identity_arguments(p.oid) signature,md5(pg_get_functiondef(p.oid)) body,p.proacl::text acl,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','billing_private','cluera_billing_private','cluera_private') order by p.oid");
 expect(migration.replace(/\r\n/g,'\n')).toContain(proposal.replace(/\r\n/g,'\n').trim());
 await db.exec(migration);expect(await businessSnapshot()).toEqual(before);
 for(const row of functions.rows){const after=(await db.query<any>('select oid::int oid,pg_get_function_identity_arguments(oid) signature,md5(pg_get_functiondef(oid)) body,proacl::text acl,proconfig from pg_proc where oid=$1',[row.oid])).rows[0];expect(after).toEqual(row);}
 preservedFunctions=functions.rows.length;
},60000);
beforeEach(async()=>{await db.query("update public.customer_usage_windows set starts_at=now(),expires_at=now()+reserved_ms*interval '1 millisecond' where run_id=$1",[run]);});
afterAll(async()=>db?.close());
it('records idempotent metadata only and never alters grants, runs or settlement balances',async()=>{
 expect(preservedFunctions).toBeGreaterThan(80);expect(businessTables.length).toBeGreaterThan(40);
 const before=await businessSnapshot(),operation=randomUUID();expect((await start(operation)).code).toBe('RECORDED');expect((await start(operation)).code).toBe('RECORDED');
 expect((await start(operation,2)).code).toBe('CONFLICT');expect((await finish(operation,{inputTokens:8,totalTokens:11})).code).toBe('RECORDED');
 expect((await finish(operation,{inputTokens:8,totalTokens:11})).code).toBe('RECORDED');expect((await finish(operation,{totalTokens:99})).code).toBe('CONFLICT');
 expect(await businessSnapshot()).toEqual(before);expect((await db.query('select * from public.customer_usage_settlements')).rows).toHaveLength(0);
 const data=providerUsageReportSchema.parse(await report()),row=data.rows.find(r=>r.operationId===operation)!;
 expect(row.totalTokens).toBe(11);expect(row.cost).toBeNull();expect(row.costStatus).toBe('UNAVAILABLE');expect(row.requestHash).toBeNull();
});
it('reports a durable start without a terminal receipt as unconfirmed with unavailable counters/cost',async()=>{
 const operation=randomUUID();await start(operation);const row=(await report()).rows.find((r:any)=>r.operationId===operation);
 expect(row).toMatchObject({outcome:'UNCONFIRMED',finishedAt:null,totalTokens:null,cost:null,costStatus:'UNAVAILABLE'});
});
it('rejects content, raw IDs, secrets, cost guesses and malformed numeric receipts',async()=>{
 const operation=randomUUID();await start(operation);
 for(const usage of [{prompt:'private'},{transcript:'private'},{apiKey:'private'},{requestId:'raw'},{cost:0},{totalTokens:-1},{inputTokens:1.2},{audioWindowMilliseconds:1000000001},{requestHash:'bad'},{outputTokens:null}])expect((await finish(operation,usage)).code).toBe('INVALID');
 expect((await db.query('select * from cluera_private.ai_provider_usage_finishes where operation_id=$1',[operation])).rows).toHaveLength(0);
});
it('requires an active matching usage run/provider revision and live Admin AAL2 for reads',async()=>{
 expect((await start(randomUUID(),2)).code).toBe('DENIED');
 expect((await report(randomUUID())).code).toBe('FORBIDDEN');await db.exec("update auth.sessions set aal='aal1'");expect((await report()).code).toBe('FORBIDDEN');await db.exec("update auth.sessions set aal='aal2'");
 await db.query("update public.customer_usage_windows set starts_at=starts_at-interval '1 hour',expires_at=expires_at-interval '1 hour' where run_id=$1",[run]);expect((await start()).code).toBe('DENIED');
});
it('denies direct table CRUD and browser RPC execution, with ALWAYS immutable triggers',async()=>{
 for(const table of ['ai_provider_usage_starts','ai_provider_usage_finishes']){
  expect((await db.query<any>("select relrowsecurity from pg_class where oid=$1::regclass",[`cluera_private.${table}`])).rows[0].relrowsecurity).toBe(true);
  for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed",[role,`cluera_private.${table}`])).rows[0].allowed).toBe(false);
  for(const action of [`update cluera_private.${table} set operation_id=operation_id`,`delete from cluera_private.${table}`,`truncate cluera_private.${table} cascade`])await expect(db.exec(action)).rejects.toThrow('immutable');
  expect((await db.query<any>('select tgenabled from pg_trigger where tgname=$1',[table+'_immutable'])).rows[0].tgenabled).toBe('A');
 }
 for(const fn of ['cluera_provider_usage_start','cluera_provider_usage_finish','cluera_provider_usage_admin_read']){
  const row=(await db.query<any>('select oid,prosecdef,proconfig from pg_proc where proname=$1',[fn])).rows[0];expect(row.prosecdef).toBe(true);expect(row.proconfig).toContain('search_path=""');
  for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,row.oid])).rows[0].allowed).toBe(role==='service_role');
 }
});
it('bounds the Admin report to the latest 50 without pretending it is an invoice aggregate',async()=>{
 for(let index=0;index<52;index++)await start();const data=providerUsageReportSchema.parse(await report());
 expect(data.rows).toHaveLength(50);expect(data.scope).toBe('LATEST_REQUESTS');expect(data.costStatus).toBe('UNAVAILABLE');
 expect(JSON.stringify(data)).not.toMatch(/usage_metadata|credential_id|user_id|sealed/);
});
