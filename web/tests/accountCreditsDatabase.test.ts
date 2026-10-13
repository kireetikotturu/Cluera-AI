import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db:PGlite;const uid=randomUUID(),sid=randomUUID(),other=randomUUID(),otherSession=randomUUID();
const migration='20261009120157_account_credits_snapshot';
async function call(name:string,args:unknown[]){return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;}
beforeAll(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 for(const name of ['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations',
 '20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle',
 '20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls',migration])await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
 for(const [u,s] of [[uid,sid],[other,otherSession]]){
  await db.query('insert into auth.users values($1,$2,now())',[u,`${u}@example.invalid`]);await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[s,u]);await call('customer_authorize',[u,s]);}
},60000);
afterAll(async()=>db?.close());
it('reports fresh trial without spending or creating a provider run',async()=>{
 const a=await call('customer_credits_read',[uid,sid]);expect(a.availableMilliseconds).toBe(900000);expect(a.buckets).toEqual([{kind:'TRIAL',grantedMilliseconds:900000,spentMilliseconds:0,reservedMilliseconds:0,availableMilliseconds:900000}]);
 await call('customer_credits_read',[uid,sid]);expect((await db.query('select * from public.customer_usage_runs')).rows).toHaveLength(0);
 expect(a).not.toHaveProperty('sessionId');expect(a).not.toHaveProperty('accessToken');
});
it('excludes old/paused/refunded/future time from percentages but retains lifetime spent',async()=>{
 for(const [source,kind,state,granted,spent,start,expiry] of [
  ['pack-1','PACK','ACTIVE',10800000,3600000,'now()-interval \'1 day\'',null],['pack-2','PACK','ACTIVE',10800000,0,'now()',null],
  ['old-term','RECURRING','ACTIVE',1000000,500000,'now()-interval \'3 days\'',"now()-interval '1 day'"],
  ['paused-term','RECURRING','PAUSED',1000000,0,'now()',"now()+interval '1 day'"],
  ['future','RECURRING','ACTIVE',1000000,0,"now()+interval '1 day'","now()+interval '2 days'"],
  ['refund','PACK','REVOKED',1000000,500000,'now()',null],
  ['admin-test:fixture','RECURRING','ACTIVE',60000,0,'now()',"now()+interval '1 day'"],
 ] as const)await db.query(`insert into public.customer_usage_grants(user_id,source_key,kind,state,granted_ms,spent_ms,starts_at,expires_at) values($1,$2,$3,$4,$5,$6,${start},${expiry??'null'})`,[uid,source,kind,state,granted,spent]);
 const a=await call('customer_credits_read',[uid,sid]);expect(a.spentMilliseconds).toBe(4600000);
 expect(a.buckets.find((x:any)=>x.kind==='PACK')).toMatchObject({grantedMilliseconds:21600000,spentMilliseconds:3600000,availableMilliseconds:18000000});
 expect(a.buckets.some((x:any)=>x.kind==='RECURRING')).toBe(false);expect(a.buckets.find((x:any)=>x.kind==='TEST').grantedMilliseconds).toBe(60000);
});
it('reservations and concurrent account reads cannot create a double charge',async()=>{
 const run=randomUUID();await call('customer_usage_command',[uid,sid,run,0,'START']);
 const a=await call('customer_credits_read',[uid,sid]);await call('customer_credits_read',[uid,sid]);
 expect(a.reservedMilliseconds).toBe(30000);expect(a.spentMilliseconds).toBe(4600000);
 await call('customer_usage_command',[uid,sid,run,1,'STOP']);const b=await call('customer_credits_read',[uid,sid]);expect(b.reservedMilliseconds).toBe(0);
 expect(b.spentMilliseconds-a.spentMilliseconds).toBeLessThan(30000);
});
it('preserves UNCERTAIN checkout and never fabricates paid success',async()=>{
 const id=randomUUID();await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state) values($1,$2,'pro_3_hours','UNCERTAIN')",[uid,id]);
 expect((await call('customer_credits_read',[uid,sid])).payments[0].state).toBe('UNCERTAIN');
 expect((await db.query('select * from public.customer_pack_purchases')).rows).toHaveLength(0);
});
it('requires live owned sessions, denies suspension and restricts RPC execution',async()=>{
 expect((await call('customer_credits_read',[uid,otherSession])).code).toBe('UNAUTHENTICATED');
 expect((await call('customer_credits_read',[other,otherSession])).buckets).toHaveLength(1);
 await db.query("update public.customer_accounts set state='SUSPENDED' where user_id=$1",[other]);expect((await call('customer_credits_read',[other,otherSession])).code).toBe('SUSPENDED');
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'public.customer_credits_read(uuid,uuid)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(role==='service_role');
 const info=(await db.query<{prosecdef:boolean;proconfig:string[]}>("select prosecdef,proconfig from pg_proc where oid='public.customer_credits_read(uuid,uuid)'::regprocedure")).rows[0];expect(info.prosecdef).toBe(true);expect(info.proconfig).toContain('search_path=""');
});
it('reports exhausted time and the actual provider ledger refuses new usage',async()=>{
 await db.query('update public.customer_usage_grants set spent_ms=granted_ms,reserved_ms=0 where user_id=$1',[uid]);
 const a=await call('customer_credits_read',[uid,sid]);expect(a.availableMilliseconds).toBe(0);
 expect((await call('customer_usage_command',[uid,sid,randomUUID(),0,'START'])).code).toBe('EXHAUSTED');
 expect((await call('customer_credits_read',[uid,sid])).spentMilliseconds).toBe(a.spentMilliseconds);
});
