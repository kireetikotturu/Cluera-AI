import { createHmac } from 'node:crypto';
import { it,expect,vi } from 'vitest';
import { razorpayAdapter } from '../lib/payments/providers/razorpay/adapter';
import { razorpayTransport } from '../lib/payments/providers/razorpay/transport';
import { verifyRazorpayHmac } from '../lib/payments/providers/razorpay/signatures';
import { razorpayCheckoutEnabled,razorpayCheckoutAllowed } from '../lib/payments/core/config';
import { paymentAdapter } from '../lib/payments/providers/registry';
import { paymentTestEnvironment as env } from './helpers/paymentTestMode';
const intentId='00000000-0000-4000-8000-000000000811',orderId='order_synthetic0001',paymentId='pay_synthetic0001';
const binding={intentId,userId:env.SIGMAROUND_PAYMENT_TESTER_IDS,orderId,offerCode:'pro_3_hours' as const};
const order={id:orderId,entity:'order',amount:54900,currency:'INR',receipt:intentId,status:'created',amount_paid:0,amount_due:54900,attempts:0,
 notes:{sigma_intent:intentId,sigma_offer:'pro_3_hours',sigma_environment:'test'},offer_id:null};
const payment={id:paymentId,entity:'payment',order_id:orderId,amount:54900,currency:'INR',status:'captured',captured:true,amount_refunded:0,refund_status:null,invoice_id:null,international:false};
function requestWith(orderChanges={},paymentChanges={},refundChanges={}){return vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const path=String(input);if(path.endsWith('/orders')&&init?.method==='POST')return Response.json({...order,...orderChanges});
 if(path.includes('/orders/'))return Response.json({...order,status:'paid',amount_paid:54900,amount_due:0,...orderChanges});
 if(path.includes('/payments/'))return Response.json({...payment,...paymentChanges});
 return Response.json({id:'rfnd_synthetic0001',entity:'refund',payment_id:paymentId,amount:54900,currency:'INR',status:'processed',...refundChanges});
}) as typeof fetch;}
it('creates exactly one server-owned INR549 order, bounded Test key only; no identity/amount from browser',async()=>{
 const request=requestWith();expect(await razorpayAdapter(env,request).createOrder(intentId)).toEqual({orderId});
 const init=vi.mocked(request).mock.calls[0][1]!;expect(init).toMatchObject({method:'POST',redirect:'error',cache:'no-store'});
 expect(JSON.parse(init.body as string)).toEqual({amount:54900,currency:'INR',receipt:intentId,partial_payment:false,notes:order.notes});
 expect(request).toHaveBeenCalledOnce();
});
it.each([{RAZORPAY_ENVIRONMENT:'live'},{RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456'},{SIGMAROUND_ACCOUNT_ORIGIN:'https://production.example'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},{RAZORPAY_TEST_KEY_SECRET:''},{RAZORPAY_TEST_WEBHOOK_SECRET:''},{RAZORPAY_TEST_ACCOUNT_ID:''}])('wrong environment/configuration fails before any API call: %j',async change=>{
 const request=requestWith();expect(()=>razorpayAdapter({...env,...change},request)).toThrow();expect(request).not.toHaveBeenCalled();
 expect(razorpayCheckoutEnabled({...env,...change})).toBe(false);
});
it('gates missing/tester/malformed configuration and unsupported gateways without fallback',()=>{
 expect(razorpayCheckoutAllowed(env.SIGMAROUND_PAYMENT_TESTER_IDS,env)).toBe(true);
 expect(razorpayCheckoutAllowed(env.SIGMAROUND_PAYMENT_TESTER_IDS,{...env,SIGMAROUND_PAYMENT_TESTER_IDS:'*'})).toBe(false);
 expect(razorpayCheckoutEnabled({...env,SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true'})).toBe(false);
 expect(()=>paymentAdapter('stripe',env)).toThrow();expect(()=>paymentAdapter('paddle',env)).toThrow();
});
it('verifies the signature against canonical server order; raw webhook bytes, not reparsed JSON',()=>{
 const gateway=razorpayAdapter(env,requestWith()),signature=createHmac('sha256',env.RAZORPAY_TEST_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
 expect(()=>gateway.verifyCallback(binding,paymentId,signature)).not.toThrow();
 expect(()=>gateway.verifyCallback({...binding,orderId:'order_foreign0001'},paymentId,signature)).toThrow();
 const raw=Buffer.from('{ "event": "payment.captured" }'),hmac=createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex');
 expect(()=>verifyRazorpayHmac(raw,hmac,env.RAZORPAY_TEST_WEBHOOK_SECRET)).not.toThrow();
 expect(()=>verifyRazorpayHmac(Buffer.from('{"event":"payment.captured"}'),hmac,env.RAZORPAY_TEST_WEBHOOK_SECRET)).toThrow();
});
it('independently checks paid order plus captured full payment before producing minimal evidence',async()=>{
 const request=requestWith(),evidence=await razorpayAdapter(env,request).inspect(binding,paymentId);
 expect(evidence).toMatchObject({action:'GRANT',intentId,orderId,paymentId,amount:54900,currency:'INR',refundId:null});
 expect(Object.keys(evidence)).toHaveLength(8);expect(request).toHaveBeenCalledTimes(2);
 expect(vi.mocked(request).mock.calls.every(c=>c[1]?.method==='GET')).toBe(true);
});
it.each([{status:'authorized',captured:false},{amount:54899},{currency:'USD'},{order_id:'order_foreign0001'},
 {amount_refunded:100,refund_status:'partial'},{invoice_id:'inv_subscription001'},{international:true}])('non-captured/mismatched/refunded/recurring payment cannot grant: %j',async changes=>{
 await expect(razorpayAdapter(env,requestWith({},changes)).inspect(binding,paymentId)).rejects.toThrow();
});
it.each([{receipt:'00000000-0000-4000-8000-000000000812'},{status:'attempted'},{amount_paid:0},{partial_payment:true},
 {notes:{...order.notes,sigma_environment:'live'}}])('order binding or totals conflict cannot grant: %j',async changes=>{
 await expect(razorpayAdapter(env,requestWith(changes)).inspect(binding,paymentId)).rejects.toThrow();
});
it('processed full refund requires independent matching refund/payment/order; pending and partial leave review',async()=>{
 const changes={status:'refunded',amount_refunded:54900,refund_status:'full'};
 expect(await razorpayAdapter(env,requestWith({},changes)).inspect(binding,paymentId,'rfnd_synthetic0001')).toMatchObject({action:'REFUND',refundId:'rfnd_synthetic0001'});
 await expect(razorpayAdapter(env,requestWith({},changes,{status:'pending'})).inspect(binding,paymentId,'rfnd_synthetic0001')).rejects.toThrow();
 await expect(razorpayAdapter(env,requestWith({},changes,{amount:100})).inspect(binding,paymentId,'rfnd_synthetic0001')).rejects.toThrow();
});
it('HTTP/transport/malformed/oversized failures never retry or disclose raw responses; arbitrary paths rejected before fetch',async()=>{
 for(const response of [()=>new Response('private raw detail',{status:403}),()=>Response.json({unexpected:true}),()=>new Response('x'.repeat(262145)),()=>{throw new Error('private key marker');}]){
  const request=vi.fn(async()=>response()) as typeof fetch;await expect(razorpayAdapter(env,request).createOrder(intentId)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 }
 const request=requestWith();await expect(razorpayTransport(env,request)('//evil.example/orders')).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
