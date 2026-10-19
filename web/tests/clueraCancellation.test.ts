import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cancelClueraSubscription, readClueraCancellation, clueraCancellationEnabled } from '../lib/payments/cluera/cancellation';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { clueraRazorpayTransport } from '../lib/payments/cluera/transport';
import { merchantDigest } from '../lib/payments/cluera/config';
import type { PaymentRpc } from '../lib/payments/core/types';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

// Actual clean PostgreSQL foundation + UNAPPLIED additive command proposal.
// Provider HTTP is synthetic; this suite cannot create a hosted subscription.
const account={userId:paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:randomUUID()};
const foreign={userId:randomUUID(),sessionId:randomUUID()};
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:'true'};
const digest=merchantDigest(env),subscriptionId='sub_canceltest0001',planId='plan_canceltest0001',intentId=randomUUID(),revisionId=randomUUID();
let db:PGlite;
const proposal=readFileSync('../docs/proposals/cluera-subscription-cancellation.sql','utf8');
const rpc:PaymentRpc=async(name,args)=>{
 if(!/^cluera_billing_[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Unexpected synthetic RPC');
 const entries=Object.entries(args);
 try{return {data:(await db.query<{value:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value,error:null};}
 catch(error){return {data:null,error};}
};
async function call(name:string,args:Record<string,unknown>){const result=await rpc(name,args);if(result.error)throw result.error;return result.data as any;}
const args=(operationId=randomUUID(),owner=account)=>({p_user:owner.userId,p_session:owner.sessionId,p_operation:operationId,p_subscription:subscriptionId,p_account_digest:digest,p_epoch:1});
const input=(operationId=randomUUID())=>({expectedAccountId:account.userId,operationId,subscriptionId});
const evidence=(providerState='active')=>({subscriptionId,providerState,observedAt:new Date().toISOString()});
async function rows(relation:string){return (await db.query(`select to_jsonb(t) value from ${relation} t order by to_jsonb(t)::text`)).rows.map(row=>row.value);}
async function finances(){const result:Record<string,unknown>={};for(const name of ['public.customer_trial_grants','public.customer_usage_grants','cluera_billing_private.intents','cluera_billing_private.subscriptions','cluera_billing_private.payments','cluera_billing_private.terms','cluera_billing_private.events','cluera_billing_private.applications'])result[name]=await rows(name);return result;}
function provider(){
 let state='active',failPost=false;
 const resource=()=>({id:subscriptionId,entity:'subscription',plan_id:planId,status:state,quantity:1,
  notes:{cluera_intent:intentId,cluera_revision:revisionId,cluera_environment:'test'},paid_count:1,total_count:120,customer_id:'cust_canceltest0001',has_scheduled_changes:false,ended_at:state==='cancelled'?Math.floor(Date.now()/1000):null});
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(String(url).endsWith('/cancel')){expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({cancel_at_cycle_end:true});if(failPost)throw Error('Synthetic unknown provider outcome');return Response.json(resource());}
  expect(init?.method).toBe('GET');
  if(String(url).includes('/plans/'))return Response.json({id:planId,entity:'plan',period:'monthly',interval:1,item:{amount:549900,currency:'INR',active:true}});
  return Response.json(resource());
 });
 return {request:request as typeof fetch,setState:(value:string)=>{state=value;},fail:()=>{failPost=true;}};
}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 await db.exec(proposal);
},60_000);
beforeEach(async()=>{
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));await db.exec('begin');
 for(const value of [account,foreign]){
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[value.userId,value.userId+'@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[value.sessionId,value.userId]);await db.query('select public.customer_authorize($1,$2)',[value.userId,value.sessionId]);
 }
 await db.query("update cluera_billing_private.processing_owner set account_digest=$1 where singleton",[digest]);
 await db.query("insert into cluera_billing_private.catalog_revisions(id,offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,razorpay_plan_id,total_count) values($1,'cluera_monthly_40h_v2',2,'Cancellation Test monthly',549900,144000,'RECURRING','MONTH',$2,120)",[revisionId,planId]);
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id) values($1,$2,$3,$4,$5,1,'VERIFIED',$6)",[intentId,account.userId,randomUUID(),revisionId,digest,subscriptionId]);
 await db.query("insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at,paid_through) values($1,$2,$3,$4,$5,'ACTIVE',now(),now()+interval '30 days')",[subscriptionId,account.userId,intentId,revisionId,digest]);
 const grantId=randomUUID();
 await db.query("insert into public.customer_usage_grants(id,user_id,source_key,kind,granted_ms,spent_ms,starts_at,expires_at,state) values($1,$2,'synthetic-cancellation-paid-cycle','RECURRING',144000000,60000,now(),now()+interval '30 days','ACTIVE')",[grantId,account.userId]);
 await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,grant_id,state,period_start,period_end,paid_at) values('pay_canceltest0001','order_canceltest0001',$1,$2,'inv_canceltest0001',$3,549900,$4,$5,'VERIFIED',now(),now()+interval '30 days',now())",[intentId,account.userId,subscriptionId,revisionId,grantId]);
 await db.query("insert into cluera_billing_private.terms values('inv_canceltest0001',$1,$2,$3,'ACTIVE',now(),now()+interval '30 days',now()+interval '30 days')",[account.userId,subscriptionId,grantId]);
});
afterEach(async()=>{await db.exec('rollback');vi.unstubAllGlobals();});
afterAll(async()=>{await db?.close();});

it('one durable SQL claim sends one cancel-at-cycle-end POST, ACK preserves every financial row and all UUID replays are read-only',async()=>{
 const before=await finances(),p=provider(),gateway=clueraRazorpayAdapter(env,p.request),operation=input();
 expect(await cancelClueraSubscription(rpc,account,operation,env,gateway)).toEqual({code:'RECORDED',command:{operationId:operation.operationId,subscriptionId,state:'ACCEPTED'}});
 await cancelClueraSubscription(rpc,account,operation,env,gateway);await cancelClueraSubscription(rpc,account,input(),env,gateway);
 expect(vi.mocked(p.request).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(await finances()).toEqual(before);expect(await rows('cluera_billing_private.cancellation_commands')).toHaveLength(1);expect(await rows('cluera_billing_private.cancellation_audit')).toHaveLength(2);
 const publicValue=JSON.stringify(await readClueraCancellation(rpc,account,operation.operationId,env,gateway));
 expect(publicValue).not.toMatch(/claimId|keyId|plan_|accountDigest|binding|intentId/);
});
it('an unknown POST remains UNCERTAIN across repeated and new operations, then GET alone can independently confirm terminal state',async()=>{
 const before=await finances(),p=provider();p.fail();const gateway=clueraRazorpayAdapter(env,p.request),operation=input();
 expect((await cancelClueraSubscription(rpc,account,operation,env,gateway)).command.state).toBe('UNCERTAIN');
 await cancelClueraSubscription(rpc,account,operation,env,gateway);await cancelClueraSubscription(rpc,account,input(),env,gateway);
 expect((await readClueraCancellation(rpc,account,operation.operationId,env,gateway)).command.state).toBe('UNCERTAIN');
 p.setState('cancelled');expect((await readClueraCancellation(rpc,account,operation.operationId,env,gateway)).command.state).toBe('CONFIRMED');
 expect(vi.mocked(p.request).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(await finances()).toEqual(before);
});
it('a terminal preflight never sends a cancellation and preserves the paid ledger',async()=>{
 const before=await finances(),p=provider();p.setState('cancelled');
 expect((await cancelClueraSubscription(rpc,account,input(),env,clueraRazorpayAdapter(env,p.request))).command.state).toBe('CONFIRMED');
 expect(vi.mocked(p.request).mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);expect(await finances()).toEqual(before);
});
it('foreign or malformed provider acknowledgement remains locked and is never re-posted',async()=>{
 const p=provider(),operation=input();
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  const response=await p.request(url,init);
  if(init?.method==='POST')return Response.json({...await response.json(),id:'sub_foreign0001',private:'never-expose'});
  return response;
 });
 const gateway=clueraRazorpayAdapter(env,request as typeof fetch);
 const result=await cancelClueraSubscription(rpc,account,operation,env,gateway);expect(result.command.state).toBe('UNCERTAIN');
 await cancelClueraSubscription(rpc,account,input(),env,gateway);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(JSON.stringify(result)).not.toContain('never-expose');
});
it('terminal status without a trustworthy end timestamp cannot be reported as confirmed',async()=>{
 const p=provider();p.setState('cancelled');const operation=input();
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  const response=await p.request(url,init);return Response.json({...await response.json(),ended_at:null});
 });
 const gateway=clueraRazorpayAdapter(env,request as typeof fetch);
 expect((await cancelClueraSubscription(rpc,account,operation,env,gateway)).command.state).toBe('UNCERTAIN');
 expect((await readClueraCancellation(rpc,account,operation.operationId,env,gateway)).command.state).toBe('UNCERTAIN');
 expect(request.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
it('concurrent different operation UUIDs acquire at most one fresh lease',async()=>{
 const results=await Promise.all([call('cluera_billing_cancel_prepare',args()),call('cluera_billing_cancel_prepare',args())]);
 expect(results.filter(value=>value.code==='CLAIMED')).toHaveLength(1);expect(await rows('cluera_billing_private.cancellation_commands')).toHaveLength(1);
});
it('owner/session/digest/epoch and operation binding cannot be substituted to obtain a provider lease or foreign command',async()=>{
 const operation=randomUUID();expect((await call('cluera_billing_cancel_prepare',args(operation,foreign))).code).toBe('FORBIDDEN');
 expect((await call('cluera_billing_cancel_prepare',{...args(operation),p_session:foreign.sessionId})).code).not.toBe('CLAIMED');
 expect((await call('cluera_billing_cancel_prepare',{...args(operation),p_account_digest:'b'.repeat(64)})).code).toBe('UNAVAILABLE');
 expect((await call('cluera_billing_cancel_prepare',{...args(operation),p_epoch:2})).code).toBe('UNAVAILABLE');
 await call('cluera_billing_cancel_prepare',args(operation));
 const read={p_user:foreign.userId,p_session:foreign.sessionId,p_operation:operation,p_account_digest:digest,p_epoch:1};
 expect((await call('cluera_billing_cancel_read',read)).code).toBe('FORBIDDEN');
 expect((await call('cluera_billing_cancel_prepare',{...args(operation),p_subscription:'sub_foreign0001'})).code).toBe('CONFLICT');
});
it('expired claims cannot attest success, forged/stale evidence cannot settle a command, and active GET cannot confirm cancellation',async()=>{
 const common=args(),claim=await call('cluera_billing_cancel_prepare',common),finish={...common,p_claim:claim.claimId};
 for(const invalid of [{...evidence(),subscriptionId:'sub_foreign0001'},{...evidence(),providerState:'created'},{...evidence(),observedAt:'2000-01-01T00:00:00Z'},{...evidence(),secret:'never-accepted'}])
  expect((await call('cluera_billing_cancel_finish',{...finish,p_evidence:invalid})).code).toBe('INVALID');
 const {p_subscription:_subscription,...observe}=common;
 expect((await call('cluera_billing_cancel_observe',{...observe,p_evidence:evidence()})).code).toBe('INVALID');
 await db.exec("update cluera_billing_private.cancellation_commands set lease_until=now()-interval '1 second'");
 expect((await call('cluera_billing_cancel_finish',{...finish,p_evidence:evidence()})).command.state).toBe('UNCERTAIN');
 expect((await call('cluera_billing_cancel_prepare',common)).code).toBe('RECORDED');
});
it('immutable auditing is atomic: audit failure rolls back a claim, command evidence and state are never publicly writable',async()=>{
 await db.exec("create function cluera_billing_private.reject_cancel_audit() returns trigger language plpgsql as $$begin raise exception 'Synthetic audit failure';end$$;create trigger fail before insert on cluera_billing_private.cancellation_audit for each row execute function cluera_billing_private.reject_cancel_audit();");
 await db.exec('savepoint expected_audit_failure');
 await expect(call('cluera_billing_cancel_prepare',args())).rejects.toThrow('Synthetic audit failure');await db.exec('rollback to savepoint expected_audit_failure');
 expect(await rows('cluera_billing_private.cancellation_commands')).toHaveLength(0);
 for(const table of ['cancellation_commands','cancellation_audit'])for(const role of ['anon','authenticated','service_role'])
  expect((await db.query<{ok:boolean}>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') ok",[role,'cluera_billing_private.'+table])).rows[0].ok).toBe(false);
 const privileges=(await db.query("select p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') browser,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p where p.proname like 'cluera_billing_cancel_%'")).rows;
 expect(privileges).toHaveLength(4);for(const value of privileges){expect(value).toMatchObject({anon:false,browser:false,service:true});expect(value.proconfig).toContain('search_path=""');}
});
it.each([{CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:undefined},{CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:'false'},{RAZORPAY_ENVIRONMENT:'live'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'},{VERCEL_ENV:'preview'}])('disabled/wrong target cannot admit a command %j',async patch=>{
 const p=provider(),testEnv={...env,...patch};expect(clueraCancellationEnabled(testEnv)).toBe(false);
 await expect(cancelClueraSubscription(rpc,account,input(),testEnv,{cancelFuture:vi.fn(),cancellationStatus:vi.fn()})).rejects.toThrow();expect(p.request).not.toHaveBeenCalled();expect(await rows('cluera_billing_private.cancellation_commands')).toHaveLength(0);
});
it('pausing NEW checkout does not block the separately approved cancellation facility',()=>{
 expect(clueraCancellationEnabled({...env,SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false'})).toBe(true);
});
it('fixed transport refuses immediate cancel, arbitrary payloads, GET cancellation and every other mutation path before HTTP',async()=>{
 const request=vi.fn(),api=clueraRazorpayTransport(env,request),path=`/subscriptions/${subscriptionId}/cancel`;
 for(const [resource,body]of [[path,undefined],[path,{cancel_at_cycle_end:false}],[path,{cancel_at_cycle_end:true,amount:1}],[`/subscriptions/${subscriptionId}/pause`,{pause_at:'now'}]] as const)
  await expect(api(resource,body)).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
