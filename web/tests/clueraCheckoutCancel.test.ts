import { beforeEach, expect, it, vi } from 'vitest';
import { cancelClueraPendingCheckout } from '../lib/payments/cluera/checkoutResume';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'};
const account={userId:env.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:'00000000-0000-4000-8000-000000000002'};
const intentId='00000000-0000-4000-8000-000000000004',revisionId='00000000-0000-4000-8000-000000000005';
const orderId='order_cancelcluera0001',notes={cluera_intent:intentId,cluera_revision:revisionId,cluera_environment:'test'};
const revision={revisionId,offerCode:'cluera_pack_3h_v2',name:'Cluera pack',amountPaise:54900,currency:'INR',allowanceSeconds:10800,
 kind:'PACK',interval:null,razorpayPlanId:null,totalCount:null,version:1,testPlanValidated:true,enabled:true};
const order={id:orderId,entity:'order',amount:54900,currency:'INR',status:'created',amount_paid:0,amount_due:54900,attempts:0,receipt:intentId,notes};
let pendingState:Record<string,unknown>|null,cancelResult:string;
const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>({error:null,data:
 name==='cluera_billing_owner'?(args.p_account_digest===merchantDigest(env)?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'})
 :name==='cluera_billing_status'?{userId:account.userId,code:pendingState?'PENDING':'AVAILABLE',pending:pendingState,resolvedOrderIds:[],resolvedSubscriptionIds:[]}
 :name==='cluera_billing_binding'?{legacy:false,code:'BOUND',intentId,userId:account.userId,orderId,subscriptionId:null,revision}
 :name==='cluera_billing_intent_cancel'?{code:cancelResult}:null}));
const provider=(patch:Record<string,unknown>={},items:unknown[]=[])=>vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
 expect(init?.method).toBe('GET');
 return Response.json(String(url).endsWith('/payments')?{entity:'collection',count:items.length,items}:{...order,...patch});
});
const cancelCall=()=>rpc.mock.calls.find(([name])=>name==='cluera_billing_intent_cancel');
beforeEach(()=>{rpc.mockClear();cancelResult='CANCELLED';
 pendingState={legacy:false,intentId,state:'BOUND',kind:'PACK',revisionId,offerCode:revision.offerCode,orderId,subscriptionId:null};});

it('cancels an untouched order with fresh provider evidence and only GET provider calls',async()=>{
 const request=provider();
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'CANCELLED'});
 expect(cancelCall()?.[1]).toMatchObject({p_user:account.userId,p_intent:intentId,p_epoch:1,
  p_evidence:{orderId,orderStatus:'created',amountPaidPaise:0,openPayments:0}});
 expect(request).toHaveBeenCalledTimes(2);
});
it('cancels an attempted order whose payments all failed',async()=>{
 const request=provider({status:'attempted',attempts:2},[{id:'pay_failedattempt0001',status:'failed'},{id:'pay_failedattempt0002',status:'failed'}]);
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'CANCELLED'});
 expect(cancelCall()?.[1]).toMatchObject({p_evidence:{orderStatus:'attempted',openPayments:0}});
});
it.each(['authorized','captured','created'])('never cancels an order with a %s payment',async state=>{
 const request=provider({status:'attempted',attempts:1},[{id:'pay_openattempt00001',status:state}]);
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'PAYMENT_IN_PROGRESS'});
 expect(cancelCall()).toBeUndefined();
});
it('never cancels a paid order',async()=>{
 const request=provider({status:'paid',amount_paid:54900,amount_due:0});
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'PAYMENT_IN_PROGRESS'});
 expect(cancelCall()).toBeUndefined();
});
it('cancels an order-less stuck checkout without contacting Razorpay, and relays TOO_SOON',async()=>{
 pendingState={legacy:false,intentId,state:'UNCERTAIN',kind:'PACK',revisionId,offerCode:revision.offerCode,orderId:null,subscriptionId:null};
 const request=provider();cancelResult='TOO_SOON';
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'TOO_SOON'});
 expect(request).not.toHaveBeenCalled();expect(cancelCall()?.[1]).toMatchObject({p_evidence:null});
});
it('reports nothing pending and already-resolved orders without failing',async()=>{
 const request=provider();cancelResult='VERIFIED';
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'ALREADY_RESOLVED'});
 pendingState=null;
 expect(await cancelClueraPendingCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).toEqual({code:'NOTHING_PENDING'});
});
