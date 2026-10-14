import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { createClueraCheckout, verifyClueraCallback } from '../lib/payments/cluera/checkout';
import { handleClueraWebhook } from '../lib/payments/cluera/events';
import { reconcileClueraPayment } from '../lib/payments/cluera/reconciliation';
import { merchantDigest } from '../lib/payments/cluera/config';
import type { PaymentRpc } from '../lib/payments/core/types';
import type { Revision } from '../lib/payments/cluera/contracts';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

// Full synthetic server -> actual PostgreSQL RPC -> HTTP test-double -> raw signed
// receipt -> independent reads -> shared ledger. No hosted query or provider call.
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'};
const accountDigest=merchantDigest(env),admin=randomUUID(),adminSession=randomUUID(),legacyUser=randomUUID(),legacySession=randomUUID();
const oldOrder='order_originalflow0001',oldPayment='pay_originalflow0001',oldRefund='rfnd_originalflow0001';
const baseline=['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations',
  '20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle',
  '20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls','20261008100006_account_admin_catalog_controls',
  '20261009120157_account_credits_snapshot','20261011014422_account_checkout_unresolved_bound_guard'];
let db:PGlite,oldIntent:any,counter=0;
async function call(name:string,args:unknown[]=[]):Promise<any> { return (await db.query<{value:any}>(`select public.${name}(${args.map((_,index)=>'$'+(index+1)).join(',')}) value`,args)).rows[0].value; }
const rpc:PaymentRpc=async(name,args)=>{
  if(!/^(cluera_billing_|account_payment_)[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Unexpected synthetic RPC');
  const entries=Object.entries(args);
  try { return {data:(await db.query<{value:any}>(`select public.${name}(${entries.map(([key],index)=>`${key}=>$${index+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value,error:null}; }
  catch { return {data:null,error:{code:'SYNTHETIC_RPC_FAILURE'}}; }
};
async function rows(table:string) { return (await db.query<any>(`select * from ${table}`)).rows; }
async function newAccount(userId=randomUUID(),sessionId=randomUUID()) {
  await db.query('insert into auth.users values($1,$2,now())',[userId,userId+'@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[sessionId,userId]);
  expect((await call('customer_authorize',[userId,sessionId])).code).toBe('ACTIVE');
  return {userId,sessionId};
}
async function catalog(code='cluera_pack_3h_v2'):Promise<Revision> { return (await call('cluera_billing_catalog')).find((revision:Revision)=>revision.offerCode===code); }
async function edit(action:string,offer:string,input:unknown) {
  return call('cluera_billing_admin_mutate',[admin,adminSession,randomUUID(),action,offer,(await catalog(offer)).revisionId,
    new Date().toISOString(),'Synthetic explicitly approved future policy',input]);
}
beforeAll(async()=>{
  db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
  for(const migration of baseline)await db.exec(readFileSync(`../supabase/migrations/${migration}.sql`,'utf8'));
  await db.exec('create schema if not exists billing_private;create table billing_private.worker_config(singleton boolean primary key,secret_id uuid,enabled boolean,last_sent_at timestamptz,last_request_id bigint);');
  await db.exec(readFileSync('../supabase/migrations/20261004093908_checkout_recovery_audit.sql','utf8'));
  await db.exec(readFileSync('../supabase/migrations/20261012013828_account_gateway_test_pack.sql','utf8'));
  await newAccount(admin,adminSession);await db.query('insert into public.account_admin_profiles(user_id) values($1)',[admin]);
  await newAccount(legacyUser,legacySession);
  oldIntent=await call('account_payment_prepare',[legacyUser,legacySession,randomUUID(),accountDigest]);
  expect(await call('account_payment_bind',[oldIntent.intentId,oldIntent.attemptId,accountDigest,oldOrder])).toBe('BOUND');
  const customersBefore=await rows('public.customer_accounts'),trialsBefore=await rows('public.customer_trial_grants'),oldBefore=await rows('billing_private.payment_intents');
  await db.exec(readFileSync('../docs/proposals/cluera-billing.sql','utf8'));
  expect(await rows('public.customer_accounts')).toEqual(customersBefore);expect(await rows('public.customer_trial_grants')).toEqual(trialsBefore);expect(await rows('billing_private.payment_intents')).toEqual(oldBefore);
  expect((await call('cluera_billing_cutover',[randomUUID(),'account',1,'cluera',accountDigest,'Synthetic explicitly approved isolated cutover'])).code).toBe('APPLIED');
  expect((await edit('SET_ENABLED','cluera_pack_3h_v2',{enabled:true})).code).toBe('APPLIED');
  const recurring=await catalog('cluera_monthly_40h_v2');
  expect((await edit('CREATE_REVISION',recurring.offerCode,{name:recurring.name,amountPaise:recurring.amountPaise,allowanceSeconds:recurring.allowanceSeconds,razorpayPlanId:'plan_flowmonthly0001',totalCount:120})).code).toBe('APPLIED');
  const revision=await catalog(recurring.offerCode);
  expect(await call('cluera_billing_plan_verify',[revision.revisionId,accountDigest,{planId:revision.razorpayPlanId,period:'monthly',interval:1,amountPaise:revision.amountPaise,currency:'INR',observedAt:new Date().toISOString()}])).toBe('VERIFIED');
  expect((await edit('SET_ENABLED',revision.offerCode,{enabled:true})).code).toBe('APPLIED');
},60000);
afterAll(async()=>db?.close());

function gateway(revision:Revision) {
  const serial=(++counter).toString().padStart(8,'0'),subscriptionId='sub_flowtest'+serial;
  const start=new Date();start.setUTCDate(1);start.setUTCHours(0,0,0,0);const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  const makeCycle=(number:number,periodStart:Date,periodEnd:Date,paidAt:number)=>({orderId:'order_flowtest'+serial+'c'+number,paymentId:'pay_flowtest'+serial+'c'+number,
    invoiceId:'inv_flowtest'+serial+'c'+number,start:new Date(periodStart),end:new Date(periodEnd),paidAt,captured:false});
  const cycles=[makeCycle(1,start,end,Math.floor(Date.now()/1000))];let cycle=cycles[0];
  let notes:Record<string,unknown>={},receipt:string|null=null,authenticated=false,cancellationAt:number|null=null;
  const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));expect(url.origin).toBe('https://api.razorpay.com');expect(init?.redirect).toBe('error');
    if(init?.method==='POST') {
      const body=JSON.parse(init.body as string);notes=body.notes;
      if(url.pathname==='/v1/orders') { receipt=body.receipt;return Response.json({id:cycle.orderId,entity:'order',amount:revision.amountPaise,currency:'INR',status:'created',amount_paid:0,amount_due:revision.amountPaise,attempts:0,receipt,notes,partial_payment:false,offer_id:null}); }
      expect(url.pathname).toBe('/v1/subscriptions');expect(body.total_count).toBe(120);expect(body.quantity).toBe(1);
      return Response.json({id:subscriptionId,entity:'subscription',plan_id:revision.razorpayPlanId,status:'created',quantity:1,total_count:120,notes,paid_count:0,customer_id:null,has_scheduled_changes:false,ended_at:null});
    }
    expect(init?.method).toBe('GET');
    if(url.pathname.startsWith('/v1/plans/'))return Response.json({id:revision.razorpayPlanId,entity:'plan',period:'monthly',interval:1,item:{amount:revision.amountPaise,currency:'INR',active:true}});
    const paidCount=cycles.filter(value=>value.captured).length;
    if(url.pathname.startsWith('/v1/subscriptions/'))return Response.json({id:subscriptionId,entity:'subscription',plan_id:revision.razorpayPlanId,status:cancellationAt!==null?'cancelled':paidCount?'active':authenticated?'authenticated':'created',quantity:1,total_count:120,notes,paid_count:paidCount,customer_id:paidCount||authenticated?'cust_flowtest0001':null,has_scheduled_changes:false,ended_at:cancellationAt});
    if(url.pathname.startsWith('/v1/orders/')) {const item=cycles.find(value=>url.pathname.endsWith('/'+value.orderId));if(!item)throw Error('Unknown synthetic order');return Response.json({id:item.orderId,entity:'order',amount:revision.amountPaise,currency:'INR',status:item.captured?'paid':'created',amount_paid:item.captured?revision.amountPaise:0,amount_due:item.captured?0:revision.amountPaise,attempts:item.captured?1:0,receipt,notes,partial_payment:false,offer_id:null});}
    if(url.pathname.startsWith('/v1/payments/')) {const item=cycles.find(value=>url.pathname.endsWith('/'+value.paymentId));if(!item)throw Error('Unknown synthetic payment');return Response.json({id:item.paymentId,entity:'payment',order_id:item.orderId,invoice_id:revision.kind==='PACK'?null:item.invoiceId,amount:revision.amountPaise,currency:'INR',status:item.captured?'captured':'authorized',captured:item.captured,amount_refunded:0,refund_status:null,international:false,method:'card',card:{network:'Visa'}});}
    if(url.pathname==='/v1/invoices') { expect(url.searchParams.get('subscription_id')).toBe(subscriptionId);return Response.json({entity:'collection',count:cycles.length,items:cycles.map(item=>({id:item.invoiceId,subscription_id:subscriptionId}))}); }
    if(url.pathname.startsWith('/v1/invoices/')) {const item=cycles.find(value=>url.pathname.endsWith('/'+value.invoiceId));if(!item)throw Error('Unknown synthetic invoice');return Response.json({id:item.invoiceId,entity:'invoice',subscription_id:subscriptionId,order_id:item.orderId,payment_id:item.paymentId,customer_id:'cust_flowtest0001',status:item.captured?'paid':'issued',currency:'INR',amount:revision.amountPaise,amount_paid:item.captured?revision.amountPaise:0,amount_due:item.captured?0:revision.amountPaise,gross_amount:revision.amountPaise,tax_amount:0,partial_payment:false,billing_start:item.start.getTime()/1000,billing_end:item.end.getTime()/1000,paid_at:item.paidAt,line_items:[{type:'plan',amount:revision.amountPaise,unit_amount:revision.amountPaise,gross_amount:revision.amountPaise,net_amount:revision.amountPaise,tax_amount:0,currency:'INR',quantity:1,taxes:[]}]});}
    throw Error('Unexpected synthetic provider path');
  }) as typeof fetch;
  return {provider,subscriptionId,get orderId(){return cycle.orderId;},get paymentId(){return cycle.paymentId;},get invoiceId(){return cycle.invoiceId;},
    get start(){return cycle.start;},get end(){return cycle.end;},capture:()=>{cycle.captured=true;},authenticate:()=>{authenticated=true;},
    cancelAt:(value:number)=>{cancellationAt=value;},setPaidAt:(value:number)=>{cycle.paidAt=value;},
    setPeriod:(periodStart:Date,periodEnd:Date)=>{cycle.start=new Date(periodStart);cycle.end=new Date(periodEnd);},
    nextInvoice:(periodStart:Date,periodEnd:Date,paidAt:number)=>{cycle=makeCycle(cycles.length+1,periodStart,periodEnd,paidAt);cycles.push(cycle);}};
}
async function deliver(eventId:string,eventType:string,payload:Record<string,unknown>,testEnv=env) {
  const raw=Buffer.from(JSON.stringify({entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event:eventType,created_at:Math.floor(Date.now()/1000),payload}));
  const signature=createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex');
  const make=()=>new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',{method:'POST',headers:{'content-type':'application/json','x-razorpay-signature':signature,'x-razorpay-event-id':eventId},body:raw});
  const response=await handleClueraWebhook(make(),testEnv,rpc);expect(response.status).toBe(200);expect(await response.json()).toEqual({received:true});
  return {repeat:()=>handleClueraWebhook(make(),testEnv,rpc)};
}
const paymentPayload=(g:ReturnType<typeof gateway>,recurring=false)=>({payment:{entity:{id:g.paymentId,order_id:g.orderId,invoice_id:recurring?g.invoiceId:null}}});

it('one real SQL claimed pack order, callback-only authentication, two signed event types and duplicate deliver exactly10800s once without expiry',async()=>{
  const account=await newAccount(),testEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:account.userId},revision=await catalog(),g=gateway(revision),requestId=randomUUID();
  const trialBefore=await rows('public.customer_trial_grants');
  const checkout=await createClueraCheckout(rpc,account,requestId,revision.revisionId,testEnv,clueraRazorpayAdapter(testEnv,g.provider));
  expect(checkout).toMatchObject({code:'BOUND',amountPaise:54900,currency:'INR',orderId:g.orderId});
  expect(await createClueraCheckout(rpc,account,requestId,revision.revisionId,testEnv,clueraRazorpayAdapter(testEnv,g.provider))).toEqual({code:'PENDING'});
  expect(vi.mocked(g.provider).mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
  const signature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(`${g.orderId}|${g.paymentId}`).digest('hex');
  expect(await verifyClueraCallback(rpc,account,{expectedAccountId:account.userId,orderId:g.orderId,subscriptionId:null,paymentId:g.paymentId,signature},testEnv,clueraRazorpayAdapter(testEnv,g.provider))).toEqual({code:'AWAITING_WEBHOOK'});
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId)).toHaveLength(0);
  expect((await rows('cluera_billing_private.events')).filter(row=>row.order_id===g.orderId)).toHaveLength(0);
  g.capture();const first=await deliver('evt_pack_flow_captured','payment.captured',paymentPayload(g),testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('VERIFIED');
  expect((await first.repeat()).status).toBe(200);expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('EMPTY');
  await deliver('evt_pack_flow_paid','order.paid',{...paymentPayload(g),order:{entity:{id:g.orderId}}},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('VERIFIED');
  const grants=(await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId);
  expect(grants).toHaveLength(1);expect(grants[0]).toMatchObject({kind:'PACK',granted_ms:10800000,expires_at:null,spent_ms:0,reserved_ms:0});
  expect((await call('cluera_credits_read',[account.userId,account.sessionId])).availableMilliseconds).toBe(11700000);
  expect(await rows('public.customer_trial_grants')).toEqual(trialBefore);
  const intent=(await rows('cluera_billing_private.intents')).find(row=>row.user_id===account.userId&&row.order_id===g.orderId);
  const applications=(await rows('cluera_billing_private.applications')).filter(row=>['evt_pack_flow_captured','evt_pack_flow_paid'].includes(row.event_id));
  expect(applications).toHaveLength(2);expect(applications.every(row=>row.intent_id===intent.id)).toBe(true);
});
it('finite monthly server subscription: mandate creates zero, canonical callback zero, independently paid invoice/capture grant one144000s bounded cycle',async()=>{
  const account=await newAccount(),testEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:account.userId},revision=await catalog('cluera_monthly_40h_v2'),g=gateway(revision);
  const otherGrantsBefore=(await rows('public.customer_usage_grants')).filter(row=>row.user_id!==account.userId);
  const checkout=await createClueraCheckout(rpc,account,randomUUID(),revision.revisionId,testEnv,clueraRazorpayAdapter(testEnv,g.provider));
  expect(checkout).toMatchObject({code:'BOUND',subscriptionId:g.subscriptionId,orderId:null,amountPaise:549900});
  g.authenticate();await deliver('evt_monthly_flow_auth','subscription.authenticated',{subscription:{entity:{id:g.subscriptionId}}},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('NO_GRANT');
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId)).toHaveLength(0);
  const signature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(`${g.paymentId}|${g.subscriptionId}`).digest('hex');
  expect(await verifyClueraCallback(rpc,account,{expectedAccountId:account.userId,orderId:null,subscriptionId:g.subscriptionId,paymentId:g.paymentId,signature},testEnv,clueraRazorpayAdapter(testEnv,g.provider))).toEqual({code:'AWAITING_WEBHOOK'});
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId)).toHaveLength(0);
  g.capture();await deliver('evt_monthly_flow_paid','subscription.charged',{subscription:{entity:{id:g.subscriptionId}},...paymentPayload(g,true)},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('VERIFIED');
  await deliver('evt_monthly_flow_capture','payment.captured',paymentPayload(g,true),testEnv); // Raw payload omits subscription: independent invoice resolves it.
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('VERIFIED');
  const grants=(await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId);
  expect(grants).toHaveLength(1);expect(grants[0]).toMatchObject({kind:'RECURRING',granted_ms:144000000,spent_ms:0,reserved_ms:0});
  expect(new Date(grants[0].starts_at).toISOString()).toBe(g.start.toISOString());expect(new Date(grants[0].expires_at).toISOString()).toBe(g.end.toISOString());
  expect((await call('cluera_credits_read',[account.userId,account.sessionId])).availableMilliseconds).toBe(144900000);
  await deliver('evt_monthly_flow_late_auth','subscription.authenticated',{subscription:{entity:{id:g.subscriptionId}}},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('NO_GRANT');
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId)).toEqual(grants);
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id!==account.userId)).toEqual(otherGrantsBefore);
});
it('authoritative incomplete capture stays leased-for-review with no credit or replacement order',async()=>{
  const account=await newAccount(),testEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:account.userId},revision=await catalog(),g=gateway(revision);
  expect((await createClueraCheckout(rpc,account,randomUUID(),revision.revisionId,testEnv,clueraRazorpayAdapter(testEnv,g.provider))).code).toBe('BOUND');
  await deliver('evt_incomplete_flow_capture','payment.captured',paymentPayload(g),testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('PENDING');
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId)).toHaveLength(0);
  expect((await call('cluera_billing_status',[account.userId,account.sessionId])).pending.orderId).toBe(g.orderId);
  expect(vi.mocked(g.provider).mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
  expect((await rows('cluera_billing_private.events')).find(row=>row.event_id==='evt_incomplete_flow_capture')).toMatchObject({state:'PENDING',claim_id:null,attempts:1});
});
it('paid future invoices queue without ending the current cycle; cancellation preserves funded time and enforces independent paid cutoff',async()=>{
  const originalTrials=await rows('public.customer_trial_grants'),otherGrants=await rows('public.customer_usage_grants');
  const revision=await catalog('cluera_monthly_40h_v2'),account=await newAccount(),testEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:account.userId},g=gateway(revision);
  expect((await createClueraCheckout(rpc,account,randomUUID(),revision.revisionId,testEnv,clueraRazorpayAdapter(testEnv,g.provider))).code).toBe('BOUND');
  g.capture();await deliver('evt_queue_flow_current','subscription.charged',{subscription:{entity:{id:g.subscriptionId}},...paymentPayload(g,true)},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('VERIFIED');
  const currentGrant=(await rows('public.customer_usage_grants')).find(row=>row.user_id===account.userId),currentInvoice=g.invoiceId;
  const nextStart=new Date(g.end),nextEnd=new Date(nextStart);nextEnd.setUTCMonth(nextEnd.getUTCMonth()+1);
  g.nextInvoice(nextStart,nextEnd,Math.floor(Date.now()/1000));g.capture();
  await deliver('evt_queue_flow_future','subscription.charged',{subscription:{entity:{id:g.subscriptionId}},...paymentPayload(g,true)},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('VERIFIED');
  const queuedInvoice=g.invoiceId,grantRows=(await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId);
  expect(grantRows).toHaveLength(2);expect(grantRows.find(row=>row.id===currentGrant.id)).toEqual(currentGrant);
  const terms=(await rows('cluera_billing_private.terms')).filter(row=>row.user_id===account.userId);
  expect(terms.find(row=>row.invoice_id===currentInvoice)).toMatchObject({state:'ACTIVE'});
  const queued=terms.find(row=>row.invoice_id===queuedInvoice);expect(queued.state).toBe('QUEUED');
  expect(grantRows.find(row=>row.id===queued.grant_id)).toMatchObject({state:'PAUSED',granted_ms:144000000});
  expect((await call('cluera_credits_read',[account.userId,account.sessionId])).availableMilliseconds).toBe(144900000);
  await deliver('evt_queue_flow_late_pending','subscription.pending',{subscription:{entity:{id:g.subscriptionId}}},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('APPLIED'); // Current independently fetched state is still ACTIVE.
  g.cancelAt(Math.floor(Date.now()/1000));
  await deliver('evt_queue_flow_cancel','subscription.cancelled',{subscription:{entity:{id:g.subscriptionId}}},testEnv);
  expect(await reconcileClueraPayment(rpc,testEnv,g.provider)).toBe('APPLIED');
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===account.userId)).toEqual(grantRows);
  expect((await rows('cluera_billing_private.terms')).filter(row=>row.user_id===account.userId)).toEqual(terms);
  expect((await call('cluera_credits_read',[account.userId,account.sessionId])).availableMilliseconds).toBe(144900000);

  // A distinct bound customer's delayed invoice was already paid before its
  // verified cancellation cutoff. Its future cycle remains funded, not early spendable.
  const delayedAccount=await newAccount(),delayedEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:delayedAccount.userId},delayed=gateway(revision);
  expect((await createClueraCheckout(rpc,delayedAccount,randomUUID(),revision.revisionId,delayedEnv,clueraRazorpayAdapter(delayedEnv,delayed.provider))).code).toBe('BOUND');
  const futureStart=new Date(Date.now()+86400000);futureStart.setUTCMilliseconds(0);const futureEnd=new Date(futureStart);futureEnd.setUTCMonth(futureEnd.getUTCMonth()+1);
  const now=Math.floor(Date.now()/1000);delayed.setPeriod(futureStart,futureEnd);delayed.setPaidAt(now-10);delayed.capture();delayed.cancelAt(now-5);
  await deliver('evt_queue_flow_delayed_paid','subscription.charged',{subscription:{entity:{id:delayed.subscriptionId}},...paymentPayload(delayed,true)},delayedEnv);
  expect(await reconcileClueraPayment(rpc,delayedEnv,delayed.provider)).toBe('VERIFIED');
  const delayedGrant=(await rows('public.customer_usage_grants')).find(row=>row.user_id===delayedAccount.userId);
  expect(delayedGrant).toMatchObject({state:'PAUSED',granted_ms:144000000});
  expect((await rows('cluera_billing_private.terms')).find(row=>row.user_id===delayedAccount.userId)).toMatchObject({state:'QUEUED'});
  expect((await call('cluera_credits_read',[delayedAccount.userId,delayedAccount.sessionId])).availableMilliseconds).toBe(900000);

  // A captured invoice funded AFTER cancellation is not accepted as entitlement.
  const lateAccount=await newAccount(),lateEnv={...env,SIGMAROUND_PAYMENT_TESTER_IDS:lateAccount.userId},late=gateway(revision);
  expect((await createClueraCheckout(rpc,lateAccount,randomUUID(),revision.revisionId,lateEnv,clueraRazorpayAdapter(lateEnv,late.provider))).code).toBe('BOUND');
  late.setPeriod(futureStart,futureEnd);late.setPaidAt(now-5);late.capture();late.cancelAt(now-10);
  await deliver('evt_queue_flow_post_cancel','subscription.charged',{subscription:{entity:{id:late.subscriptionId}},...paymentPayload(late,true)},lateEnv);
  expect(await reconcileClueraPayment(rpc,lateEnv,late.provider)).toBe('PENDING');
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===lateAccount.userId)).toHaveLength(0);
  expect((await rows('cluera_billing_private.payments')).filter(row=>row.user_id===lateAccount.userId)).toHaveLength(0);
  expect(vi.mocked(late.provider).mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
  expect((await rows('public.customer_trial_grants')).filter(row=>originalTrials.some(original=>original.user_id===row.user_id))).toEqual(originalTrials);
  expect((await rows('public.customer_usage_grants')).filter(row=>otherGrants.some(original=>original.id===row.id))).toEqual(otherGrants);
});
it('genuine synthetic old-order refund missing raw order ID is resolved independently and tombstoned in the original immutable audit',async()=>{
  const trialBefore=await rows('public.customer_trial_grants'),oldBefore=await rows('billing_private.payment_intents');
  const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    expect(init?.method).toBe('GET');const path=new URL(String(input)).pathname;
    if(path.startsWith('/v1/payments/'))return Response.json({id:oldPayment,entity:'payment',order_id:oldOrder,invoice_id:null,amount:54900,currency:'INR',status:'refunded',captured:true,amount_refunded:54900,refund_status:'full',international:false});
    if(path.startsWith('/v1/orders/'))return Response.json({id:oldOrder,entity:'order',amount:54900,currency:'INR',status:'paid',amount_paid:54900,amount_due:0,receipt:oldIntent.intentId,notes:{sigma_intent:oldIntent.intentId,sigma_offer:'pro_3_hours',sigma_environment:'test'},attempts:1,partial_payment:false,offer_id:null});
    if(path.startsWith('/v1/refunds/'))return Response.json({id:oldRefund,entity:'refund',payment_id:oldPayment,amount:54900,currency:'INR',status:'processed'});
    throw Error('Unexpected old-order synthetic GET');
  }) as typeof fetch;
  await deliver('evt_old_flow_refund','refund.processed',{refund:{entity:{id:oldRefund,payment_id:oldPayment}}});
  expect(await reconcileClueraPayment(rpc,env,provider)).toBe('REFUNDED');
  const after=(await rows('billing_private.payment_intents')).find(row=>row.id===oldIntent.intentId);
  expect(after.state).toBe('REFUNDED');expect(after.order_id).toBe(oldOrder);expect(after.user_id).toBe(legacyUser);
  expect(oldBefore.find(row=>row.id===oldIntent.intentId).state).toBe('BOUND');
  expect((await rows('billing_private.payment_applications')).filter(row=>row.intent_id===oldIntent.intentId)).toHaveLength(1);
  expect((await rows('cluera_billing_private.payments')).filter(row=>row.order_id===oldOrder)).toHaveLength(0);
  expect((await rows('public.customer_usage_grants')).filter(row=>row.user_id===legacyUser)).toHaveLength(0);
  expect(await rows('public.customer_trial_grants')).toEqual(trialBefore);
});
