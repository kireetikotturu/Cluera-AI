import {readFileSync} from 'node:fs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {schedulerHeaders,WEB_DISPATCH_URL} from '../../shared/billingDispatch';
import {handleClueraExternalDispatch} from '../lib/payments/cluera/externalScheduler';
import {clueraRazorpayAdapter} from '../lib/payments/cluera/adapter';
import {createClueraCheckout,verifyClueraCallback} from '../lib/payments/cluera/checkout';
import {handleClueraWebhook} from '../lib/payments/cluera/events';
import {reconcileClueraPayment} from '../lib/payments/cluera/reconciliation';
import {merchantDigest} from '../lib/payments/cluera/config';
import type {PaymentRpc} from '../lib/payments/core/types';
import type {Revision} from '../lib/payments/cluera/contracts';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

// Exact frozen clean SQL and synthetic provider only; no hosted/network/secret use.
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true',
 SIGMAROUND_BILLING_WORKER_SECRET:'synthetic-clean-external-worker-key-00000000',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
 VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc'};
const digest=merchantDigest(env),userId=randomUUID(),sessionId=randomUUID(),account={userId,sessionId};
const testEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:userId},orderId='order_cleanexternal01',paymentId='pay_cleanexternal001';
let db:PGlite;
async function call(name:string,args:unknown[]=[]):Promise<any>{
 if(!/^[a-z_]+$/.test(name))throw Error('Unexpected synthetic function');
 return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;
}
const rpc:PaymentRpc=async(name,args)=>{
 if(!/^cluera_billing_[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('Unexpected synthetic RPC');
 const entries=Object.entries(args);
 try{return {data:(await db.query<{value:any}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>v))).rows[0].value,error:null};}
 catch{return {data:null,error:{code:'SYNTHETIC_RPC_FAILURE'}};}
};
async function rows(table:string):Promise<any[]>{
 if(!/^(public|cluera_billing_private)\.[a-z_]+$/.test(table))throw Error('Unexpected synthetic table');
 return (await db.query(`select * from ${table} order by 1`)).rows;
}
async function revision():Promise<Revision>{return (await call('cluera_billing_catalog')).find((item:Revision)=>item.offerCode==='cluera_pack_3h_v2');}
beforeAll(async()=>{
 db=new PGlite();await db.waitReady;
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.identities(user_id uuid);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);`);
 const foundation=readFileSync('../docs/proposals/cluera-clean-foundation.sql','utf8');
 expect(createHash('sha256').update(foundation).digest('hex')).toBe('ae0f1eeef39e9d988386c1c36b3150cee8b10895b38e7d270d373f4b9009379e');
 expect(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8')).toBe(foundation);await db.exec(foundation);
 await db.query('insert into auth.users values($1,$2,now())',[userId,'clean-dispatch@example.invalid']);
 await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[sessionId,userId]);
 expect((await call('customer_authorize',[userId,sessionId])).code).toBe('ACTIVE');
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[userId]);
},60000);
beforeEach(async()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');vi.unstubAllGlobals();});
afterAll(async()=>{await db?.close();});
function dispatch(time:number){return new Request(WEB_DISPATCH_URL,{method:'POST',body:'{}',headers:schedulerHeaders('DISPATCH',env.SIGMAROUND_BILLING_WORKER_SECRET,time)});}
function gateway(r:Revision){
 let captured=false,receipt:string|null=null,notes:Record<string,unknown>={};
 const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input));expect(url.origin).toBe('https://api.razorpay.com');expect(init?.redirect).toBe('error');
  if(init?.method==='POST'){
   expect(url.pathname).toBe('/v1/orders');const body=JSON.parse(init.body as string);
   expect(body.amount).toBe(54900);expect(body.currency).toBe('INR');expect(body.partial_payment).toBe(false);receipt=body.receipt;notes=body.notes;
   return Response.json({id:orderId,entity:'order',amount:r.amountPaise,currency:'INR',status:'created',amount_paid:0,amount_due:r.amountPaise,attempts:0,receipt,notes,partial_payment:false,offer_id:null});
  }
  expect(init?.method).toBe('GET');
  if(url.pathname==='/v1/payments/'+paymentId)return Response.json({id:paymentId,entity:'payment',order_id:orderId,invoice_id:null,amount:r.amountPaise,currency:'INR',status:captured?'captured':'authorized',captured,amount_refunded:0,refund_status:null,international:false,method:'card',card:{network:'Visa'}});
  if(url.pathname==='/v1/orders/'+orderId)return Response.json({id:orderId,entity:'order',amount:r.amountPaise,currency:'INR',status:captured?'paid':'created',amount_paid:captured?r.amountPaise:0,amount_due:captured?0:r.amountPaise,attempts:captured?1:0,receipt,notes,partial_payment:false,offer_id:null});
  throw Error('Unexpected synthetic provider path');
 }) as typeof fetch;return {provider,capture:()=>{captured=true;}};
}
function signedEvent(eventId:string,eventType:'payment.captured'|'order.paid'){
 const payload={payment:{entity:{id:paymentId,order_id:orderId,invoice_id:null}},...(eventType==='order.paid'?{order:{entity:{id:orderId}}}:{})};
 const body=Buffer.from(JSON.stringify({entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event:eventType,created_at:Math.floor(Date.now()/1000),payload}));
 const signature=createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(body).digest('hex');
 return ()=>new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',{method:'POST',body,headers:{'content-type':'application/json','x-razorpay-event-id':eventId,'x-razorpay-signature':signature}});
}
async function fixturePinAndEnable(){
 // PGlite fixture ONLY; not a hosted audited bootstrap or financial activation.
 await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);
 const r=await revision();expect((await call('cluera_billing_admin_mutate',[userId,sessionId,randomUUID(),'SET_ENABLED',r.offerCode,r.revisionId,new Date().toISOString(),'Synthetic isolated acceptance only',{enabled:true}])).code).toBe('APPLIED');return revision();
}
it('refuses unbound clean merchant before nonce or financial mutation despite future enabled gates',async()=>{
 const names=['cluera_billing_private.processing_owner','cluera_billing_private.worker_nonces','cluera_billing_private.events','cluera_billing_private.applications','public.customer_trial_grants','public.customer_usage_grants'];
 const before=await Promise.all(names.map(rows)),now=Date.now(),reconcile=vi.fn(async()=> 'EMPTY');
 const response=await handleClueraExternalDispatch(dispatch(now),env,{rpc,now:()=>now,reconcile});
 expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'Worker unavailable.'});
 expect(reconcile).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(await Promise.all(names.map(rows))).toEqual(before);
});
it('clean signed capture/order receipts yield exactly one non-expiring10800s pack with trial intact',async()=>{
 const r=await fixturePinAndEnable(),g=gateway(r),trialBefore=await rows('public.customer_trial_grants');
 expect(await createClueraCheckout(rpc,account,randomUUID(),r.revisionId,testEnv,clueraRazorpayAdapter(testEnv,g.provider))).toMatchObject({code:'BOUND',orderId,amountPaise:54900,currency:'INR'});
 const signature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(orderId+'|'+paymentId).digest('hex');
 expect(await verifyClueraCallback(rpc,account,{expectedAccountId:userId,orderId,subscriptionId:null,paymentId,signature},testEnv,clueraRazorpayAdapter(testEnv,g.provider))).toEqual({code:'AWAITING_WEBHOOK'});
 expect(await rows('cluera_billing_private.events')).toHaveLength(0);expect(await rows('public.customer_usage_grants')).toHaveLength(0);
 g.capture();const captured=signedEvent('evt_clean_external_capture','payment.captured');expect((await handleClueraWebhook(captured(),testEnv,rpc)).status).toBe(200);
 const reconcile=vi.fn((r:PaymentRpc,e=process.env)=>reconcileClueraPayment(r,e,g.provider)),now=Date.now();
 expect((await handleClueraExternalDispatch(dispatch(now),testEnv,{rpc,now:()=>now,reconcile})).status).toBe(200);
 expect(await rows('cluera_billing_private.worker_nonces')).toHaveLength(1);
 expect((await rows('cluera_billing_private.events'))[0]).toMatchObject({state:'PROCESSED',claim_id:null,attempts:1});
 const grants=await rows('public.customer_usage_grants');expect(grants).toHaveLength(1);
 expect(grants[0]).toMatchObject({user_id:userId,kind:'PACK',granted_ms:10800000,expires_at:null,spent_ms:0,reserved_ms:0});
 expect((await call('cluera_credits_read',[userId,sessionId])).availableMilliseconds).toBe(11700000);expect(await rows('public.customer_trial_grants')).toEqual(trialBefore);
 expect((await handleClueraWebhook(captured(),testEnv,rpc)).status).toBe(200);
 expect((await handleClueraExternalDispatch(dispatch(now),testEnv,{rpc,now:()=>now,reconcile})).status).toBe(401);expect(reconcile).toHaveBeenCalledTimes(1);
 const paid=signedEvent('evt_clean_external_paid','order.paid');expect((await handleClueraWebhook(paid(),testEnv,rpc)).status).toBe(200);
 // A distinct minute remains inside REAL SQL clock bounds; no SQL/clock relaxation.
 const actual=Date.now(),minute=Math.floor(actual/60000)*60000,firstMinute=Math.floor(now/60000);
 const next=[actual,minute-1000,minute+60000].find(value=>Math.floor(value/60000)!==firstMinute&&value>=actual-58000&&value<=actual+4000);expect(next).toBeDefined();
 expect((await handleClueraExternalDispatch(dispatch(next!),testEnv,{rpc,now:()=>next!,reconcile})).status).toBe(200);
 expect(await rows('public.customer_usage_grants')).toEqual(grants);expect(await rows('public.customer_trial_grants')).toEqual(trialBefore);
 expect(await rows('cluera_billing_private.worker_nonces')).toHaveLength(2);expect(await rows('cluera_billing_private.applications')).toHaveLength(2);
 expect((await rows('cluera_billing_private.events')).every(row=>row.state==='PROCESSED'&&row.claim_id===null)).toBe(true);
 expect(vi.mocked(g.provider).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(fetch).not.toHaveBeenCalled();
});
