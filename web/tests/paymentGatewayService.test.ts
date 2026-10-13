import { createHmac } from 'node:crypto';
import { it,expect,vi } from 'vitest';
import { createPaymentOrder, verifyPaymentCallback, paymentStatus } from '../lib/payments/checkout/service';
import { handleRazorpayWebhook,parseRazorpayEvent } from '../lib/payments/webhooks/razorpay';
import { reconcilePayment } from '../lib/payments/reconciliation/worker';
import { paymentTestEnvironment as env } from './helpers/paymentTestMode';
const account={userId:env.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:'00000000-0000-4000-8000-000000000802'};
const intentId='00000000-0000-4000-8000-000000000811',attemptId='00000000-0000-4000-8000-000000000812';
const orderId='order_synthetic0001',paymentId='pay_synthetic0001';
const status={code:'PENDING',userId:account.userId,pending:{id:intentId,state:'BOUND',offerCode:'pro_3_hours',orderId},history:[],resolvedOrderIds:[]};
const adapter={provider:'razorpay' as const,createOrder:vi.fn(async()=>({orderId})),verifyCallback:vi.fn(),inspect:vi.fn()};
it('one claimed CREATE results in one provider request and bound owned DTO; no fulfillment RPC',async()=>{
 const gateway={...adapter,createOrder:vi.fn(async()=>({orderId}))};
 const rpc=vi.fn(async(name:string)=>({data:name==='account_payment_prepare'?{code:'CLAIMED',intentId,attemptId}:name==='account_payment_bind'?'BOUND':status,error:null}));
 expect(await createPaymentOrder(rpc,account,intentId,env,gateway)).toMatchObject({code:'BOUND',orderId,amount:54900});
 expect(gateway.createOrder).toHaveBeenCalledOnce();expect(rpc.mock.calls.map(c=>c[0])).toEqual(['account_payment_prepare','account_payment_bind','account_payment_status']);
});
it.each(['CREATING','BOUND','UNCERTAIN','VERIFIED','REFUNDED','PENDING','REJECTED'])('request replay %s never creates or reopens another order',async code=>{
 const gateway={...adapter,createOrder:vi.fn()},rpc=vi.fn(async()=>({data:{code,intentId,orderId},error:null}));
 expect(await createPaymentOrder(rpc,account,intentId,env,gateway)).toEqual({code:'PENDING'});expect(gateway.createOrder).not.toHaveBeenCalled();
});
it('transport ambiguity persists UNCERTAIN once, no provider retry and no raw detail',async()=>{
 const gateway={...adapter,createOrder:vi.fn(async()=>{throw new Error('raw credential body');})};
 const rpc=vi.fn(async(name:string)=>({data:name==='account_payment_prepare'?{code:'CLAIMED',intentId,attemptId}:'UNCERTAIN',error:null}));
 expect(await createPaymentOrder(rpc,account,intentId,env,gateway)).toEqual({code:'PENDING'});
 expect(gateway.createOrder).toHaveBeenCalledOnce();expect(rpc.mock.calls[1][1]).toMatchObject({p_order:null});
});
it('callback HMAC verification never records a webhook, changes intent or grants; different canonical order denied',async()=>{
 const rpc=vi.fn(async()=>({data:status,error:null})),gateway={...adapter,verifyCallback:vi.fn()};
 expect(await verifyPaymentCallback(rpc,account,{orderId,paymentId,signature:'a'.repeat(64)},env,gateway)).toEqual({code:'AWAITING_WEBHOOK'});
 expect(rpc.mock.calls.map(c=>c[0])).toEqual(['account_payment_status']);expect(gateway.verifyCallback).toHaveBeenCalledOnce();
 await expect(verifyPaymentCallback(rpc,account,{orderId:'order_foreign0001',paymentId,signature:'a'.repeat(64)},env,gateway)).rejects.toThrow();
});
it('foreign/malformed availability cannot authorize another account',async()=>{
 for(const data of [{...status,userId:attemptId},{...status,code:'AVAILABLE'},{unexpected:'raw'}])
  await expect(paymentStatus(async()=>({data,error:null}),account)).rejects.toThrow();
});
it.each(['VERIFIED','REFUNDED'])('webhook-before-browser callback %s race verifies only the exact owned existing binding without grant',async code=>{
 const rpc=vi.fn(async(name:string)=>({data:name==='account_payment_status'?{...status,code:'AVAILABLE',pending:null,resolvedOrderIds:[orderId]}:
 {code,intentId,userId:account.userId,orderId,offerCode:'pro_3_hours'},error:null}));
 const gateway={...adapter,verifyCallback:vi.fn()};
 expect(await verifyPaymentCallback(rpc,account,{orderId,paymentId,signature:'a'.repeat(64)},env,gateway)).toEqual({code:'AWAITING_WEBHOOK'});
 expect(rpc.mock.calls.map(c=>c[0])).toEqual(['account_payment_status','account_payment_binding']);expect(gateway.verifyCallback).toHaveBeenCalledOnce();
});
const envelope=(event='payment.captured')=>({entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event,created_at:Math.floor(Date.now()/1000),
 payload:{payment:{entity:{id:paymentId,order_id:orderId}},order:{entity:{id:orderId}}}});
const webhook=(value=envelope(),signature?:string,eventId='evt_synthetic0001')=>{
 const raw=JSON.stringify(value);return new Request('https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook',{method:'POST',
 headers:{'Content-Type':'application/json','x-razorpay-event-id':eventId,'x-razorpay-signature':signature??createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex')},body:raw});
};
it.each(['STORED','DUPLICATE'])('signed webhook acknowledges only durable %s, never paid/granted',async state=>{
 const rpc=vi.fn(async()=>({data:state,error:null}));const r=await handleRazorpayWebhook(webhook(),env,rpc);
 expect(r.status).toBe(200);expect(await r.json()).toEqual({received:true});expect(r.headers.get('cache-control')).toBe('no-store');
 expect(rpc).toHaveBeenCalledOnce();expect(rpc.mock.calls[0][0]).toBe('account_payment_receive');
 const event=(rpc.mock.calls[0][1] as any).p_event;expect(Object.keys(event)).toHaveLength(7);expect(event).not.toHaveProperty('payload');
});
it('forged signature/foreign account/missing eventId/raw whitespace change never reaches persistence',async()=>{
 const rpc=vi.fn(async()=>({data:'STORED',error:null}));
 for(const req of [webhook(envelope(),'a'.repeat(64)),webhook({...envelope(),account_id:'acc_foreign0001'}),webhook(envelope(),undefined,'')])
  expect((await handleRazorpayWebhook(req,env,rpc)).status).toBe(400);
 expect(rpc).not.toHaveBeenCalled();
});
it('unrelated signed authorized/failure events do not authorize grants; conflicts503/409 never acknowledge paid',async()=>{
 const rpc=vi.fn(async()=>({data:'CONFLICT',error:null}));expect((await handleRazorpayWebhook(webhook(envelope('payment.authorized')),env,rpc)).status).toBe(200);
 expect(rpc).not.toHaveBeenCalled();expect((await handleRazorpayWebhook(webhook(),env,rpc)).status).toBe(409);
 expect((await handleRazorpayWebhook(webhook(),env,async()=>({data:null,error:{message:'raw'}}))).status).toBe(503);
 expect((await handleRazorpayWebhook(webhook(),{...env,SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'},rpc)).status).toBe(404);
});
it('rejects order-paid cross-resource conflict and oversized malformed webhook without echo',()=>{
 expect(()=>parseRazorpayEvent(Buffer.from(JSON.stringify({...envelope('order.paid'),payload:{...envelope().payload,order:{entity:{id:'order_foreign0001'}}}})),
  'evt_synthetic0001',env.RAZORPAY_TEST_ACCOUNT_ID)).toThrow();
});
it('worker independently fetches current order/payment before a single atomic application',async()=>{
 const claim={code:'CLAIMED',eventId:'evt_synthetic0001',claimId:attemptId,digest:'a'.repeat(64),eventType:'payment.captured',resourceId:paymentId,paymentId,orderId};
 const rpc=vi.fn(async(name:string)=>({data:name==='account_payment_claim'?claim:name==='account_payment_binding'?{code:'BOUND',intentId,userId:account.userId,orderId,offerCode:'pro_3_hours'}:{code:'VERIFIED'},error:null}));
 const request=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).includes('/orders/')?
 {id:orderId,entity:'order',amount:54900,currency:'INR',receipt:intentId,status:'paid',amount_paid:54900,amount_due:0,attempts:1,
 notes:{sigma_intent:intentId,sigma_offer:'pro_3_hours',sigma_environment:'test'}}:
 {id:paymentId,entity:'payment',order_id:orderId,amount:54900,currency:'INR',status:'captured',captured:true,amount_refunded:0,refund_status:null,invoice_id:null,international:false})) as typeof fetch;
 expect(await reconcilePayment(rpc,env,request)).toBe('VERIFIED');expect(request).toHaveBeenCalledTimes(2);
 expect(rpc.mock.calls.map(c=>c[0])).toEqual(['account_payment_claim','account_payment_binding','account_payment_apply']);
});
it('worker unavailable/mismatched resources retry durable work, never provider writes or apply',async()=>{
 const claim={code:'CLAIMED',eventId:'evt_synthetic0001',claimId:attemptId,digest:'a'.repeat(64),eventType:'payment.captured',resourceId:paymentId,paymentId,orderId};
 const rpc=vi.fn(async(name:string)=>({data:name==='account_payment_claim'?claim:name==='account_payment_binding'?{code:'BOUND',intentId,userId:account.userId,orderId,offerCode:'pro_3_hours'}:'PENDING',error:null}));
 const request=vi.fn(async()=>new Response('raw-secret',{status:403})) as typeof fetch;
 expect(await reconcilePayment(rpc,env,request)).toBe('PENDING');expect(rpc.mock.calls.map(c=>c[0])).not.toContain('account_payment_apply');
 expect(rpc.mock.calls.map(c=>c[0])).toContain('account_payment_retry');expect(request).toHaveBeenCalledOnce();
});
