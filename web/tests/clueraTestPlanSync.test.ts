import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,beforeEach,afterEach,afterAll,it,expect,vi } from 'vitest';
import { syncTestPlan } from '../lib/payments/cluera/planSync';
import { merchantDigest } from '../lib/payments/cluera/config';
import { clueraRazorpayTransport,clueraTestPlanTransport } from '../lib/payments/cluera/transport';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import type { PaymentRpc } from '../lib/payments/core/types';

const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'},digest=merchantDigest(env);
const actor=randomUUID(),session=randomUUID(),other=randomUUID(),otherSession=randomUUID(),id='plan_syntheticSync0001';
let db:PGlite,revision:string,admin:{p_actor:string;p_session:string;p_reauthenticated_at:string},input:any;
const rpc:PaymentRpc=async(name,args)=>{
 if(!/^cluera_billing_[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Unexpected RPC');
 const entries=Object.entries(args);try{return{data:(await db.query<{value:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value,error:null};}catch(error){return{data:null,error};}
};
async function sql(name:string,args:Record<string,unknown>){const result=await rpc(name,args);if(result.error)throw result.error;return result.data as any;}
const opArgs=()=>({...admin,p_operation:input.operationId,p_account_digest:digest,p_epoch:1});
const claim=()=>sql('cluera_billing_plan_sync_claim',{...opArgs(),p_offer:input.offerCode,p_expected_revision:revision,p_reason:input.reason,p_input:input.input});
const read=()=>sql('cluera_billing_plan_sync_read',{p_actor:actor,p_session:session,p_operation:input.operationId});
const plan=()=>({id,entity:'plan',period:'monthly',interval:1,item:{name:input.input.name,amount:input.input.amountPaise,currency:'INR',active:true},
 notes:{cluera_operation:input.operationId,cluera_revision:revision,cluera_environment:'test'}});
const recovery=()=>({action:'RECONCILE_TEST_PLAN' as const,operationId:input.operationId,input:{razorpayPlanId:id}});
const provider=()=>vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json(plan()));
async function financial(){const out:unknown[]=[];for(const table of ['intents','events','payments','subscriptions','terms','applications'])out.push((await db.query(`select coalesce(jsonb_agg(to_jsonb(t)),'[]') value from cluera_billing_private.${table} t`)).rows[0].value);return out;}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 for(const name of ['20261019085323_cluera_customer_billing_history','20261020080539_cluera_recurring_dependencies_disabled','20261021075249_cluera_live_infrastructure_disabled'])
  await db.exec(readFileSync('../supabase/migrations/'+name+'.sql','utf8'));
 const original=(await db.query("select oid::text id,md5(pg_get_functiondef(oid)) digest from pg_proc where pronamespace in ('public'::regnamespace,'cluera_billing_private'::regnamespace,'cluera_live_billing_private'::regnamespace) and prokind='f' order by oid")).rows;
 const migrations=readdirSync('../supabase/migrations').filter(name=>name.endsWith('_cluera_test_plan_sync.sql'));expect(migrations).toHaveLength(1);
 await db.exec(readFileSync('../supabase/migrations/'+migrations[0],'utf8'));
 expect((await db.query("select oid::text id,md5(pg_get_functiondef(oid)) digest from pg_proc where oid=any($1::oid[]) order by oid",[original.map(row=>row.id)])).rows).toEqual(original);
},60000);
beforeEach(async()=>{
 await db.exec('begin');vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Real network prohibited');}));
 for(const [user,sid] of [[actor,session],[other,otherSession]]){
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[user,user+'@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[sid,user]);
  await db.query('insert into public.account_admin_profiles(user_id) values($1)',[user]);
 }
 await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);
 const catalog=await sql('cluera_billing_catalog',{});revision=catalog.find((r:any)=>r.offerCode==='cluera_monthly_40h_v2').revisionId;
 admin={p_actor:actor,p_session:session,p_reauthenticated_at:new Date().toISOString()};
 input={action:'CREATE_TEST_PLAN',operationId:randomUUID(),offerCode:'cluera_monthly_40h_v2',expectedRevisionId:revision,
  reason:'Create the reviewed Test monthly plan',input:{name:'Cluera Pro 40 Hours Monthly',amountPaise:549900,allowanceSeconds:144000,totalCount:120}};
});
afterEach(async()=>{await db.exec('rollback');vi.unstubAllGlobals();});afterAll(async()=>{await db?.close();});

it.each([['cluera_monthly_40h_v2',549900,144000],['cluera_monthly_100h_v2',959900,360000],['cluera_monthly_200h_v2',1954900,720000]])('one provider POST plus canonical GET maps %s with unchanged financial state and Live disabled',async(offer,amount,seconds)=>{
 const row=(await sql('cluera_billing_catalog',{})).find((r:any)=>r.offerCode===offer);revision=row.revisionId;
 input={...input,offerCode:offer,expectedRevisionId:revision,input:{...input.input,name:row.name,amountPaise:amount,allowanceSeconds:seconds}};
 const liveBefore=(await db.query("select public.cluera_live_billing_operations_health()-'observedAt' value")).rows[0].value;
 const request=provider(),before=await financial();const result=await syncTestPlan(rpc,admin,input,env,request);
 expect(result).toMatchObject({code:'APPLIED',revision:{amountPaise:amount,allowanceSeconds:seconds,totalCount:120,razorpayPlanId:id,testPlanValidated:true,enabled:false,version:2}});
 expect(request.mock.calls.map(([,init])=>init?.method)).toEqual(['POST','GET']);
 expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({period:'monthly',interval:1,item:{amount,currency:'INR'}});
 expect(await financial()).toEqual(before);expect((await read()).code).toBe('APPLIED');expect(fetch).not.toHaveBeenCalled();
 expect((await db.query("select public.cluera_live_billing_operations_health()-'observedAt' value")).rows[0].value).toEqual(liveBefore);
});
it('a lost response retains the durable claim and fences same/different operation IDs and another Admin',async()=>{
 const request=vi.fn(async()=>{throw Error('Response lost after creation');});
 await expect(syncTestPlan(rpc,admin,input,env,request)).rejects.toThrow();
 expect((await read()).operation.state).toBe('CLAIMED');
 expect(await syncTestPlan(rpc,admin,input,env,request)).toEqual({code:'PENDING'});
 expect(await syncTestPlan(rpc,admin,{...input,operationId:randomUUID()},env,request)).toEqual({code:'PENDING'});
 expect(await syncTestPlan(rpc,{...admin,p_actor:other,p_session:otherSession},{...input,operationId:randomUUID()},env,request)).toEqual({code:'PENDING'});
 expect(request).toHaveBeenCalledTimes(1);
});
it('recovery after reload uses canonical reads only and duplicate recovery grants/creates nothing',async()=>{
 expect((await claim()).code).toBe('CLAIMED');const request=provider();
 expect((await syncTestPlan(rpc,admin,recovery(),env,request)).code).toBe('APPLIED');
 expect((await syncTestPlan(rpc,admin,recovery(),env,request)).code).toBe('APPLIED');
 expect(request.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
 expect((await db.query('select count(*)::integer n from cluera_billing_private.admin_audit')).rows[0].n).toBe(1);
});
it.each(['price','interval','notes','name','tax','id','active'])('rejects mismatched canonical %s without mapping or a second create',async failure=>{
 await claim();const value:any=plan();
 if(failure==='price')value.item.amount++;if(failure==='interval')value.interval=2;if(failure==='notes')value.notes.cluera_operation=randomUUID();
 if(failure==='name')value.item.name='Foreign plan';if(failure==='tax')value.item.tax_rate=18;if(failure==='id')value.id='plan_otherPlan0001';if(failure==='active')value.item.active=false;
 const request=vi.fn(async()=>Response.json(value));await expect(syncTestPlan(rpc,admin,recovery(),env,request)).rejects.toThrow();
 expect((await read()).operation.state).toBe('CLAIMED');expect(request.mock.calls.every((args:any[])=>args[1]?.method==='GET')).toBe(true);
 expect((await sql('cluera_billing_catalog',{})).find((r:any)=>r.offerCode===input.offerCode).revisionId).toBe(revision);
});
it('binds a returned ID before a verification timeout so recovery does not need another create',async()=>{
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{if(init?.method==='POST')return Response.json(plan());throw Error('GET failed');});
 await expect(syncTestPlan(rpc,admin,input,env,request)).rejects.toThrow();expect((await read()).operation).toMatchObject({state:'BOUND',razorpayPlanId:id});
 const reads=provider();expect((await syncTestPlan(rpc,admin,{...recovery(),input:{razorpayPlanId:null}},env,reads)).code).toBe('APPLIED');
 expect(reads.mock.calls.map(([,init])=>init?.method)).toEqual(['GET']);
});
it('head changes during the provider call preserve the original bound ID without overwriting the new catalog',async()=>{
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='POST')await sql('cluera_billing_admin_mutate',{...admin,p_operation:randomUUID(),p_action:'CREATE_REVISION',p_offer:input.offerCode,p_expected_revision:revision,p_reason:'Separate audited future revision',p_input:{...input.input,amountPaise:600000,razorpayPlanId:null}});
  return Response.json(plan());
 });
 expect(await syncTestPlan(rpc,admin,input,env,request)).toEqual({code:'PENDING'});expect((await read()).operation.state).toBe('BOUND');
 expect((await sql('cluera_billing_catalog',{})).find((r:any)=>r.offerCode===input.offerCode).amountPaise).toBe(600000);
});
it.each(['stale-mfa','revoked-session','foreign-merchant','null-merchant','pack','string-amount'])('SQL rejects %s before a claim',async failure=>{
 if(failure==='stale-mfa')admin.p_reauthenticated_at='2020-01-01T00:00:00Z';
 if(failure==='revoked-session')await db.query("update auth.sessions set not_after=now()-interval '1 day' where id=$1",[session]);
 if(failure==='foreign-merchant')await db.exec("update cluera_billing_private.processing_owner set account_digest=repeat('f',64)");
 if(failure==='null-merchant')await db.exec('update cluera_billing_private.processing_owner set account_digest=null');
 if(failure==='pack'){const pack=(await sql('cluera_billing_catalog',{}))[0];input.offerCode=pack.offerCode;revision=pack.revisionId;}
 if(failure==='string-amount')input.input.amountPaise='549900';
 expect((await claim()).code).not.toBe('CLAIMED');
 expect((await db.query('select count(*)::integer n from cluera_billing_private.plan_sync_operations')).rows[0].n).toBe(0);
});
it('revocation during canonical verification leaves no catalog mapping',async()=>{
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='GET')await db.query("update auth.sessions set not_after=now()-interval '1 day' where id=$1",[session]);
  return Response.json(plan());
 });
 expect(await syncTestPlan(rpc,admin,input,env,request)).toEqual({code:'PENDING'});
 expect((await db.query('select state from cluera_billing_private.plan_sync_operations')).rows[0].state).toBe('BOUND');
});
it('RLS denies direct access even to service_role and only service_role can invoke the checking RPCs',async()=>{
 const rows=(await db.query<{role:string;direct:boolean;invoke:boolean}>(`select r role,has_table_privilege(r,'cluera_billing_private.plan_sync_operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') direct,
 has_function_privilege(r,'public.cluera_billing_plan_sync_read(uuid,uuid,uuid)','EXECUTE') invoke from unnest(array['anon','authenticated','service_role']) r`)).rows;
 expect(rows).toEqual([{role:'anon',direct:false,invoke:false},{role:'authenticated',direct:false,invoke:false},{role:'service_role',direct:false,invoke:true}]);
 expect((await db.query("select relrowsecurity value from pg_class where oid='cluera_billing_private.plan_sync_operations'::regclass")).rows[0].value).toBe(true);
});
it('standard transport cannot create plans; the dedicated Test transport cannot create orders or accept Live settings',async()=>{
 const request=provider();await expect(clueraRazorpayTransport(env,request)('/plans',{})).rejects.toThrow();
 await expect(clueraTestPlanTransport(env,request)('/orders',{})).rejects.toThrow();
 expect(()=>clueraTestPlanTransport({...env,RAZORPAY_ENVIRONMENT:'live'},request)).toThrow();expect(request).not.toHaveBeenCalled();
});
it('invalid final evidence rolls back the revision and audit while preserving the previously committed binding',async()=>{
 await claim();expect(await sql('cluera_billing_plan_sync_bind',{...opArgs(),p_plan:id})).toBe('BOUND');
 await db.exec('savepoint evidence');await expect(sql('cluera_billing_plan_sync_finish',{...opArgs(),p_evidence:{}})).rejects.toThrow();await db.exec('rollback to savepoint evidence');
 expect((await read()).operation.state).toBe('BOUND');expect((await sql('cluera_billing_catalog',{})).find((r:any)=>r.offerCode===input.offerCode).revisionId).toBe(revision);
 expect((await db.query('select count(*)::integer n from cluera_billing_private.admin_audit')).rows[0].n).toBe(0);
});
it('a second explicit creation for identical mapped terms is refused without provider calls',async()=>{
 await syncTestPlan(rpc,admin,input,env,provider());const mapped=(await read()).revision,request=provider();
 expect(await syncTestPlan(rpc,admin,{...input,operationId:randomUUID(),expectedRevisionId:mapped.revisionId},env,request)).toEqual({code:'NOT_CREATED'});
 expect(request).not.toHaveBeenCalled();
});
