import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { clueraRazorpayAdapter, recurringMethodAllowed, verifyClueraPlan } from '../lib/payments/cluera/adapter';
import { clueraRazorpayTransport } from '../lib/payments/cluera/transport';
import { clueraCheckoutAllowed, clueraCheckoutEnabled, clueraIntakeEnabled } from '../lib/payments/cluera/config';
import { callbackSchema, clueraBillingCatalog, createClueraCheckout, verifyClueraCallback } from '../lib/payments/cluera/checkout';
import { handleClueraWebhook, parseClueraRazorpayEvent } from '../lib/payments/cluera/events';
import { reconcileClueraPayment } from '../lib/payments/cluera/reconciliation';
import { revisionSchema, type BillingEvent, type Binding, type Revision } from '../lib/payments/cluera/contracts';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'};

const uuid = (last:number)=>`00000000-0000-4000-8000-${last.toString().padStart(12,'0')}`;
const actor=env.SIGMAROUND_PAYMENT_TESTER_IDS,intentId=uuid(901),attemptId=uuid(902),revisionId=uuid(903);
const orderId='order_syntheticcluera01',paymentId='pay_syntheticcluera01',subscriptionId='sub_syntheticcluera01',invoiceId='inv_syntheticcluera01',planId='plan_syntheticcluera01';
const pack:Revision={revisionId,offerCode:'cluera_pack_3h_v2',name:'Cluera 3 Hours',amountPaise:54900,currency:'INR',allowanceSeconds:10800,
  kind:'PACK',interval:null,razorpayPlanId:null,enabled:true,version:1,totalCount:null,testPlanValidated:true};
const recurring:Revision={...pack,offerCode:'cluera_monthly_40h_v2',name:'Cluera 40 Hours',amountPaise:549900,allowanceSeconds:144000,
  kind:'RECURRING',interval:'MONTH',razorpayPlanId:planId,totalCount:120};
const bind=(revision=pack):Binding=>({code:'BOUND',intentId,userId:actor,orderId:revision.kind==='PACK'?orderId:null,
  subscriptionId:revision.kind==='RECURRING'?subscriptionId:null,revision});
const notes={cluera_intent:intentId,cluera_revision:revisionId,cluera_environment:'test'};
const event=(eventType:BillingEvent['eventType']='payment.captured',revision=pack):BillingEvent=>({eventId:'event_syntheticcluera01',eventType,resourceId:eventType==='refund.processed'?'rfnd_syntheticcluera01':paymentId,
  paymentId,orderId,invoiceId:revision.kind==='RECURRING'?invoiceId:null,subscriptionId:revision.kind==='RECURRING'?subscriptionId:null,digest:'a'.repeat(64),occurredAt:'2026-10-14T00:00:00Z'});
function fixtures(revision=pack,changes:Record<string,unknown>={}) {
  const amount=revision.amountPaise;
  return {order:{id:orderId,entity:'order',amount,currency:'INR',receipt:revision.kind==='PACK'?intentId:null,status:'paid',amount_paid:amount,amount_due:0,attempts:1,notes,offer_id:null,partial_payment:false},
    payment:{id:paymentId,entity:'payment',order_id:orderId,invoice_id:revision.kind==='PACK'?null:invoiceId,amount,currency:'INR',status:'captured',captured:true,amount_refunded:0,refund_status:null,international:false,method:'card',card:{network:'Visa'}},
    subscription:{id:subscriptionId,entity:'subscription',plan_id:planId,status:'active',quantity:1,notes,paid_count:1,total_count:120,customer_id:'cust_syntheticcluera01',has_scheduled_changes:false,offer_id:null,ended_at:null},
    plan:{id:planId,entity:'plan',period:'monthly',interval:1,item:{amount,currency:'INR',active:true}},
    invoice:{id:invoiceId,entity:'invoice',subscription_id:subscriptionId,order_id:orderId,payment_id:paymentId,customer_id:'cust_syntheticcluera01',status:'paid',currency:'INR',amount,amount_paid:amount,amount_due:0,gross_amount:amount,tax_amount:0,partial_payment:false,billing_start:1767225600,billing_end:1769904000,paid_at:1767225600,
      line_items:[{type:'plan',amount,unit_amount:amount,gross_amount:amount,net_amount:amount,tax_amount:0,currency:'INR',quantity:1,taxes:[]}]},
    collection:{entity:'collection',count:1,items:[{id:invoiceId,subscription_id:subscriptionId}]},
    refund:{id:'rfnd_syntheticcluera01',entity:'refund',payment_id:paymentId,amount,currency:'INR',status:'processed'},...changes};
}
function provider(revision=pack,changes:Record<string,unknown>={}) {
  const values=fixtures(revision,changes);
  return vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/orders'&&init?.method==='POST')return Response.json({...values.order,status:'created',amount_paid:0,amount_due:revision.amountPaise,attempts:0});
    if(url.pathname==='/v1/subscriptions'&&init?.method==='POST')return Response.json({...values.subscription,status:'created',paid_count:0,customer_id:null});
    if(url.pathname.startsWith('/v1/orders/'))return Response.json(values.order);
    if(url.pathname.startsWith('/v1/payments/'))return Response.json(values.payment);
    if(url.pathname.startsWith('/v1/subscriptions/'))return Response.json(values.subscription);
    if(url.pathname.startsWith('/v1/plans/'))return Response.json(values.plan);
    if(url.pathname==='/v1/invoices')return Response.json(values.collection);
    if(url.pathname.startsWith('/v1/invoices/'))return Response.json(values.invoice);
    if(url.pathname.startsWith('/v1/refunds/'))return Response.json(values.refund);
    return new Response('never',{status:404});
  }) as typeof fetch;
}
it('validates four isolated policies and rejects legacy weekly IDs or hidden perpetual cycles',()=>{
  expect(revisionSchema.parse(pack).allowanceSeconds).toBe(10800);
  expect(revisionSchema.parse(recurring).totalCount).toBe(120);
  for(const patch of [{offerCode:'enterprise_weekly'},{interval:'WEEK'},{totalCount:null},{totalCount:121},{amountPaise:0},{razorpayPlanId:'plan_other',kind:'PACK'}])expect(()=>revisionSchema.parse({...recurring,...patch})).toThrow();
});
it.each([{RAZORPAY_ENVIRONMENT:'live'},{RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456'},{SIGMAROUND_ACCOUNT_ORIGIN:'https://sigmaround-account-staging.vercel.app'},
  {NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},{SIGMAROUND_ACCOUNTS_ENABLED:'false'},{RAZORPAY_TEST_WEBHOOK_SECRET:'short'}])('fails closed before API on wrong Cluera/Test target %j',patch=>{
  const request=provider();expect(()=>clueraRazorpayAdapter({...env,...patch},request)).toThrow();expect(request).not.toHaveBeenCalled();expect(clueraCheckoutEnabled({...env,...patch})).toBe(false);
});
it('keeps rollout, intake, pause and sole tester independently gated',()=>{
  expect(clueraCheckoutAllowed(actor,env)).toBe(true);expect(clueraCheckoutAllowed(uuid(999),env)).toBe(false);
  expect(clueraCheckoutAllowed(actor,{...env,SIGMAROUND_PAYMENT_TESTER_IDS:'*'})).toBe(false);
  expect(clueraCheckoutEnabled({...env,CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'})).toBe(false);
  expect(clueraCheckoutEnabled({...env,CLUERA_BILLING_V2_ENABLED:'false'})).toBe(false);
  expect(clueraIntakeEnabled({...env,SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'})).toBe(false);
});
it('pack amount and identity derive only from the immutable server revision; one provider POST',async()=>{
  const request=provider(),resource=await clueraRazorpayAdapter(env,request).create(intentId,pack);
  expect(resource).toEqual({orderId,subscriptionId:null});expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(request).mock.calls[0][1]!.body as string)).toEqual({amount:54900,currency:'INR',receipt:intentId,partial_payment:false,notes});
});
it('recurring preflights exact immutable Test plan then creates finite canonical subscription without addons or browser identity',async()=>{
  const request=provider(recurring),resource=await clueraRazorpayAdapter(env,request).create(intentId,recurring);
  expect(resource).toEqual({orderId:null,subscriptionId});expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(request).mock.calls[1][1]!.body as string)).toEqual({plan_id:planId,quantity:1,total_count:120,customer_notify:true,notes});
});
it.each([{period:'weekly'},{interval:2},{item:{amount:549899,currency:'INR'}},{item:{amount:549900,currency:'USD'}},{id:'plan_foreign0001'}])('mismatched plan cannot create subscription or enable revision %j',async patch=>{
  const plan={...fixtures(recurring).plan,...patch},request=provider(recurring,{plan});expect(()=>verifyClueraPlan(recurring,plan)).toThrow();
  await expect(clueraRazorpayAdapter(env,request).create(intentId,recurring)).rejects.toThrow();expect(vi.mocked(request).mock.calls.some(call=>call[1]?.method==='POST')).toBe(false);
});
it('raw webhook and callback HMAC use distinct canonical resource formulas; callback creates no credit',()=>{
  const adapter=clueraRazorpayAdapter(env,provider());
  const packSignature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const subscriptionSignature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');
  expect(()=>adapter.verifyCallback(bind(),paymentId,packSignature)).not.toThrow();expect(()=>adapter.verifyCallback(bind(recurring),paymentId,subscriptionSignature)).not.toThrow();
  expect(()=>adapter.verifyCallback(bind(recurring),paymentId,packSignature)).toThrow();expect(()=>callbackSchema.parse({expectedAccountId:actor,orderId,subscriptionId,paymentId,signature:packSignature})).toThrow();
});
it('pack requires independent captured full payment, paid canonical order and no subscription/invoice',async()=>{
  const request=provider(),evidence=await clueraRazorpayAdapter(env,request).inspect(bind(),event());
  expect(evidence).toMatchObject({action:'GRANT',intentId,orderId,paymentId,amountPaise:54900,invoiceId:null,subscriptionId:null,periodStart:null,periodEnd:null});
  expect(request).toHaveBeenCalledTimes(2);expect(vi.mocked(request).mock.calls.every(call=>call[1]?.method==='GET')).toBe(true);
});
it.each([{status:'authorized',captured:false},{amount:54899},{currency:'USD'},{order_id:'order_foreign0001'},
  {amount_refunded:1,refund_status:'partial'},{invoice_id:invoiceId},{international:true}])('non-authoritative pack evidence cannot grant %j',async patch=>{
  await expect(clueraRazorpayAdapter(env,provider(pack,{payment:{...fixtures().payment,...patch}})).inspect(bind(),event())).rejects.toThrow();
});
it('recurring grant binds subscription/plan/paid invoice/captured payment/order and uses immutable invoice cycle',async()=>{
  const request=provider(recurring,{subscription:{...fixtures(recurring).subscription,current_start:999999999,current_end:9999999999}});
  const evidence=await clueraRazorpayAdapter(env,request).inspect(bind(recurring),event('subscription.charged',recurring));
  expect(evidence).toMatchObject({action:'GRANT',invoiceId,subscriptionId,periodStart:new Date(1767225600000).toISOString(),periodEnd:new Date(1769904000000).toISOString(),amountPaise:549900});
  expect(request).toHaveBeenCalledTimes(6);expect(vi.mocked(request).mock.calls.every(call=>call[1]?.method==='GET')).toBe(true);
});
it.each([{status:'issued'},{subscription_id:'sub_foreign0001'},{customer_id:'cust_foreign0001'},{payment_id:'pay_foreign0001'},
  {amount_paid:1},{tax_amount:1},{partial_payment:true},{billing_end:1767225600},{line_items:[]}])('unpaid/foreign/partial/taxed/setup invoice cannot grant %j',async patch=>{
  await expect(clueraRazorpayAdapter(env,provider(recurring,{invoice:{...fixtures(recurring).invoice,...patch}})).inspect(bind(recurring),event('subscription.charged',recurring))).rejects.toThrow();
});
it('missing or duplicate invoice membership cannot grant despite same amount',async()=>{
  for(const items of [[],[{id:invoiceId,subscription_id:subscriptionId},{id:invoiceId,subscription_id:subscriptionId}]])
    await expect(clueraRazorpayAdapter(env,provider(recurring,{collection:{entity:'collection',count:items.length,items}})).inspect(bind(recurring),event('subscription.charged',recurring))).rejects.toThrow();
});
it('mandate/auth/setup cannot grant, while independently verified cancellation is status only',async()=>{
  const authenticated={...fixtures(recurring).subscription,status:'authenticated',paid_count:0};
  expect(await clueraRazorpayAdapter(env,provider(recurring,{subscription:authenticated})).inspect(bind(recurring),{...event('subscription.authenticated',recurring),paymentId:null,orderId:null,invoiceId:null,resourceId:subscriptionId})).toMatchObject({action:'STATUS',subscriptionState:null,paymentId:null});
  const canceled={...fixtures(recurring).subscription,status:'cancelled',ended_at:Math.floor(Date.now()/1000)};
  expect(await clueraRazorpayAdapter(env,provider(recurring,{subscription:canceled})).inspect(bind(recurring),{...event('subscription.cancelled',recurring),paymentId:null,orderId:null,invoiceId:null,resourceId:subscriptionId})).toMatchObject({action:'STATUS',subscriptionState:'CANCELED',paymentId:null});
});
it('canceled subscription requires an independently verified end cutoff; only invoices paid before that cutoff may fulfill',async()=>{
  const values=fixtures(recurring),cancel=Math.floor(Date.now()/1000),subscription={...values.subscription,status:'cancelled',ended_at:cancel};
  expect(await clueraRazorpayAdapter(env,provider(recurring,{subscription})).inspect(bind(recurring),event('subscription.charged',recurring))).toMatchObject({action:'GRANT',paidAt:new Date(values.invoice.paid_at*1000).toISOString(),cancellationAt:new Date(cancel*1000).toISOString()});
  await expect(clueraRazorpayAdapter(env,provider(recurring,{subscription:{...subscription,ended_at:null}})).inspect(bind(recurring),event('subscription.charged',recurring))).rejects.toThrow();
  await expect(clueraRazorpayAdapter(env,provider(recurring,{subscription:{...subscription,ended_at:values.invoice.paid_at-1}})).inspect(bind(recurring),event('subscription.charged',recurring))).rejects.toThrow();
});
it.each([['subscription.pending','active','ACTIVE'],['subscription.paused','active','ACTIVE'],['subscription.resumed','paused','PAUSED']] as const)
  ('late %s notification records current provider %s state without granting',async(eventType,currentState,expectedState)=>{
    const request=provider(recurring,{subscription:{...fixtures(recurring).subscription,status:currentState}});
    const evidence=await clueraRazorpayAdapter(env,request).inspect(bind(recurring),{...event(eventType,recurring),resourceId:subscriptionId});
    expect(evidence).toMatchObject({action:'STATUS',subscriptionState:expectedState,paymentId:null,orderId:null,invoiceId:null,paidAt:null});
    expect(request).toHaveBeenCalledTimes(2);expect(vi.mocked(request).mock.calls.every(call=>call[1]?.method==='GET')).toBe(true);
  });
it('high-value recurring excludes ordinary UPI and RuPay; no merchant resume authority',()=>{
  const high={...recurring,amountPaise:1954900};expect(recurringMethodAllowed(high,'upi')).toBe(false);expect(recurringMethodAllowed(high,'card','RuPay')).toBe(false);
  expect(recurringMethodAllowed(high,'card')).toBe(false);expect(recurringMethodAllowed(high,'card','unknown')).toBe(false);
  expect(recurringMethodAllowed(high,'card','Visa')).toBe(true);expect(recurringMethodAllowed(high,'wallet')).toBe(false);
});
it('full refund independently verifies matching processed refund; partial is review-only',async()=>{
  const values=fixtures(),payment={...values.payment,status:'refunded',amount_refunded:54900,refund_status:'full'};
  expect(await clueraRazorpayAdapter(env,provider(pack,{payment})).inspect(bind(),event('refund.processed'))).toMatchObject({action:'REFUND',refundId:'rfnd_syntheticcluera01'});
  await expect(clueraRazorpayAdapter(env,provider(pack,{payment,refund:{...values.refund,amount:1}})).inspect(bind(),event('refund.processed'))).rejects.toThrow();
});
it('fixed resource transport rejects URL injection/mutations and masks raw provider failures without retry',async()=>{
  const request=vi.fn(async()=>new Response('secret-body',{status:401})) as typeof fetch,api=clueraRazorpayTransport(env,request);
  for(const path of ['https://attacker.invalid','/payments/pay_syntheticcluera01/capture','/plans/plan_syntheticcluera01?x=1','/invoices?subscription_id=sub_syntheticcluera01&skip=0&count=100'])await expect(api(path)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();await expect(api('/orders')).rejects.toThrow('Billing verification is unavailable.');expect(request).toHaveBeenCalledOnce();
});
it('transport bounds response bytes and never surfaces malformed or secret provider bodies',async()=>{
  for(const body of ['never-secret-not-json','x'.repeat(256*1024+1)]) {
    const request=vi.fn(async()=>new Response(body,{status:200})) as typeof fetch;
    await expect(clueraRazorpayTransport(env,request)('/orders')).rejects.toThrow('Billing verification is unavailable.');expect(request).toHaveBeenCalledOnce();
  }
});
it('one verification chain has a monotonic total deadline inside the SQL lease, not ten unbounded page deadlines',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try {
    let elapsed=0;
    const request=vi.fn(()=>new Promise<Response>(()=>undefined)) as typeof fetch,api=clueraRazorpayTransport(env,request,()=>elapsed);
    elapsed=64000;
    const outcome=api('/orders').then(()=>null,error=>error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await outcome).message).toBe('Billing verification is unavailable.');expect(request).toHaveBeenCalledOnce();
    elapsed=65000;
    await expect(api('/orders')).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it('safe catalog projection excludes plan/merchant/secret authority and rejects extra unexpected fields',async()=>{
  const rpc=vi.fn(async()=>({data:[pack,recurring],error:null}));expect(await clueraBillingCatalog(rpc)).toEqual([pack,recurring].map(({razorpayPlanId:_p,...v})=>v));
  rpc.mockResolvedValue({data:[{...pack,apiKey:'never'}],error:null});await expect(clueraBillingCatalog(rpc)).rejects.toThrow();
});
it('provider creation is attempted once only for fresh CLAIMED; replay/UNCERTAIN is never posted again',async()=>{
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:name==='cluera_billing_prepare'?{code:'PENDING'}:null,error:null}));
  const request=provider(),adapter=clueraRazorpayAdapter(env,request);expect(await createClueraCheckout(rpc,{userId:actor,sessionId:uuid(904)},uuid(905),revisionId,env,adapter)).toEqual({code:'PENDING'});expect(request).not.toHaveBeenCalled();
});
it('post/bind/identity uncertainty persists without retry or grant',async()=>{
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:name==='cluera_billing_prepare'?{code:'CLAIMED',intentId,attemptId,revision:pack}:name==='cluera_billing_bind'?'BOUND':{userId:uuid(999),code:'AVAILABLE',pending:null,resolvedOrderIds:[],resolvedSubscriptionIds:[]},error:null}));
  const request=provider();expect(await createClueraCheckout(rpc,{userId:actor,sessionId:uuid(904)},uuid(905),revisionId,env,clueraRazorpayAdapter(env,request))).toEqual({code:'PENDING'});
  expect(request).toHaveBeenCalledOnce();expect(rpc.mock.calls.filter(([name])=>name==='cluera_billing_bind')).toHaveLength(2);expect(rpc.mock.calls.some(([name])=>/apply|grant|receive/.test(name))).toBe(false);
});
it('callback verifies exact bound same owner even when webhook won race; no financial RPC',async()=>{
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:{...bind(),code:'VERIFIED'},error:null}));
  const signature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  expect(await verifyClueraCallback(rpc,{userId:actor,sessionId:uuid(904)},{expectedAccountId:actor,orderId,subscriptionId:null,paymentId,signature},env)).toEqual({code:'AWAITING_WEBHOOK'});
  expect(rpc.mock.calls.map(([name])=>name)).toEqual(['cluera_billing_owner','cluera_billing_binding']);
});
it('parses signed receipt projection only; foreign merchant and future timestamp fail before durability',()=>{
  const payload={entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event:'subscription.charged',created_at:1767225600,
    payload:{subscription:{entity:{id:subscriptionId}},payment:{entity:{id:paymentId,order_id:orderId,invoice_id:invoiceId,email:'never-store'}}}};
  const parsed=parseClueraRazorpayEvent(Buffer.from(JSON.stringify(payload)),'event_syntheticcluera01',env.RAZORPAY_TEST_ACCOUNT_ID);
  expect(parsed).toMatchObject({subscriptionId,invoiceId,paymentId,orderId});expect(JSON.stringify(parsed)).not.toContain('never-store');
  expect(()=>parseClueraRazorpayEvent(Buffer.from(JSON.stringify({...payload,account_id:'acc_foreign0001'})),'event_syntheticcluera01',env.RAZORPAY_TEST_ACCOUNT_ID)).toThrow();
  expect(()=>parseClueraRazorpayEvent(Buffer.from(JSON.stringify({...payload,created_at:Math.floor(Date.now()/1000)+1000})),'event_syntheticcluera01',env.RAZORPAY_TEST_ACCOUNT_ID)).toThrow();
});
it('disabled intake does no reads/mutations; enabled raw HMAC accepts only durable fixed acknowledgment',async()=>{
  const raw=Buffer.from(JSON.stringify({entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event:'payment.captured',created_at:1767225600,payload:{payment:{entity:{id:paymentId,order_id:orderId,invoice_id:null}}}}));
  const signature=createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex');
  const req=()=>new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',{method:'POST',headers:{'content-type':'application/json','x-razorpay-signature':signature,'x-razorpay-event-id':'event_syntheticcluera01'},body:raw});
  const rpc=vi.fn(async()=>({data:'STORED',error:null}));expect((await handleClueraWebhook(req(),{...env,CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'},rpc)).status).toBe(404);expect(rpc).not.toHaveBeenCalled();
  const response=await handleClueraWebhook(req(),env,rpc);expect(response.status).toBe(200);expect(await response.json()).toEqual({received:true});expect(rpc).toHaveBeenCalledOnce();expect(rpc.mock.calls[0][0]).toBe('cluera_billing_event_accept');
});
it('worker requires Cluera owner/epoch and cannot apply when wrong owner remains Account',async()=>{
  const rpc=vi.fn(async()=>({data:{owner:'account',epoch:1},error:null})),request=provider();await expect(reconcileClueraPayment(rpc,env,request)).rejects.toThrow();expect(request).not.toHaveBeenCalled();expect(rpc).toHaveBeenCalledOnce();
});
it('worker accepts actual strict claimed projection, independent pack evidence and exactly one apply',async()=>{
  const claimed={code:'CLAIMED',claimId:uuid(910),legacy:false,...event()};
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{code:'ACTIVE',owner:'cluera',epoch:2}:name==='cluera_billing_event_claim'?claimed:name==='cluera_billing_binding'?{...bind(),legacy:false}:name==='cluera_billing_apply'?{code:'VERIFIED'}:null,error:null}));
  const request=provider();expect(await reconcileClueraPayment(rpc,env,request)).toBe('VERIFIED');
  expect(rpc.mock.calls.filter(([name])=>name==='cluera_billing_apply')).toHaveLength(1);expect(vi.mocked(request).mock.calls.every(call=>call[1]?.method==='GET')).toBe(true);
});
it('ordinary captured event may omit subscription links; independent invoice resolves exact owned subscription',async()=>{
  const claimed={code:'CLAIMED',claimId:uuid(910),legacy:false,...event('payment.captured',recurring),subscriptionId:null,invoiceId:null};
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:name==='cluera_billing_event_claim'?claimed:name==='cluera_billing_binding'?{...bind(recurring),legacy:false}:name==='cluera_billing_apply'?{code:'VERIFIED'}:null,error:null}));
  expect(await reconcileClueraPayment(rpc,env,provider(recurring))).toBe('VERIFIED');
  const bindingCall=rpc.mock.calls.find(([name])=>name==='cluera_billing_binding')!;expect(bindingCall[1]).toMatchObject({p_resource:subscriptionId});
  const applied=rpc.mock.calls.find(([name])=>name==='cluera_billing_apply')!;expect(applied[1]).toMatchObject({p_epoch:2,p_evidence:{subscriptionId,invoiceId,paymentId,action:'GRANT'}});
});
it('subscription lifecycle with optional payment entity applies status only, not a new paid grant',async()=>{
  const claimed={code:'CLAIMED',claimId:uuid(910),legacy:false,...event('subscription.cancelled',recurring),resourceId:subscriptionId};
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:name==='cluera_billing_event_claim'?claimed:name==='cluera_billing_binding'?{...bind(recurring),legacy:false}:name==='cluera_billing_apply'?{code:'APPLIED'}:null,error:null}));
  expect(await reconcileClueraPayment(rpc,env,provider(recurring,{subscription:{...fixtures(recurring).subscription,status:'cancelled',ended_at:Math.floor(Date.now()/1000)}}))).toBe('APPLIED');
  const applied=rpc.mock.calls.find(([name])=>name==='cluera_billing_apply')!;expect(applied[1]).toMatchObject({p_evidence:{action:'STATUS',paymentId:null,orderId:null,invoiceId:null,subscriptionState:'CANCELED'}});
});
it('unexpanded high-value card network is held for review rather than bypassing RuPay policy',async()=>{
  const high={...recurring,amountPaise:1954900};
  await expect(clueraRazorpayAdapter(env,provider(high,{payment:{...fixtures(high).payment,card:null}})).inspect(bind(high),event('subscription.charged',high))).rejects.toThrow();
});
it('refund-before-capture legacy receipt resolves old binding and applies through original audited tombstone bridge',async()=>{
  const claimed={code:'CLAIMED',claimId:uuid(910),legacy:false,...event('refund.processed'),orderId:null};
  const oldBinding={legacy:true,code:'BOUND',intentId,userId:actor,orderId,offerCode:'pro_3_hours'};
  const values=fixtures(),request=provider(pack,{order:{...values.order,notes:{sigma_intent:intentId,sigma_offer:'pro_3_hours',sigma_environment:'test'}},payment:{...values.payment,status:'refunded',amount_refunded:54900,refund_status:'full'}});
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:name==='cluera_billing_event_claim'?claimed:name==='cluera_billing_binding'?oldBinding:name==='cluera_billing_legacy_apply'?{code:'REFUNDED'}:null,error:null}));
  expect(await reconcileClueraPayment(rpc,env,request)).toBe('REFUNDED');expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_apply')).toBe(false);
  expect(rpc.mock.calls.find(([name])=>name==='cluera_billing_legacy_apply')![1]).toMatchObject({p_evidence:{action:'REFUND',amount:54900,orderId,paymentId}});
});
it('malformed claimed projection releases only exact safe lease without inventing occurrence time or evidence',async()=>{
  const claimed={code:'CLAIMED',claimId:uuid(910),legacy:false,...event(),occurredAt:undefined};
  const rpc=vi.fn(async(name:string)=>({data:name==='cluera_billing_owner'?{owner:'cluera',epoch:2}:name==='cluera_billing_event_claim'?claimed:'RETRY',error:null}));
  const request=provider();expect(await reconcileClueraPayment(rpc,env,request)).toBe('PENDING');expect(request).not.toHaveBeenCalled();
  expect(rpc.mock.calls.find(([name])=>name==='cluera_billing_event_finish')![1]).toEqual({p_event:claimed.eventId,p_claim:claimed.claimId,p_epoch:2,p_retry:true});
});
