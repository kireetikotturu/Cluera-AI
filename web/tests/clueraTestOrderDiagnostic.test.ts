import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
const {audit,reportLines}=createRequire(import.meta.url)('../../scripts/payments/audit-cluera-test-order.cjs');
const sha='b'.repeat(40),options={expectedSourceSha:sha};
const env={...paymentTestEnvironment,VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
 VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:sha,
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false'};
const orderId='order_syntheticdirect01',privateText='SYNTHETIC_PRIVATE_NOTES_EMAIL_PROVIDER_ERROR';
const hook={id:'webhook_synthetic1',url:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook',
 service:'api-test',owner_type:'merchant',owner_id:'synthetic123456',active:true,disabled_at:0,secret_exists:true,
 events:['payment.captured','order.paid','refund.processed']};
const order=(extra:any={})=>({id:orderId,entity:'order',status:'attempted',amount:54900,amount_paid:0,amount_due:54900,currency:'INR',receipt:privateText,notes:{privateText},...extra});
const payment=(n:number,extra:any={})=>({id:'pay_syntheticdirect'+n,entity:'payment',order_id:orderId,status:n<8?'authorized':'failed',
 amount:54900,currency:'INR',amount_refunded:0,refund_status:null,captured:false,email:privateText,notes:{privateText},...extra});
const collection=(items:any[])=>({entity:'collection',count:items.length,items});
function fixture(settings:{orders?:any[];direct?:any;payments?:any[];hooks?:any[];financial?:(path:string,init:RequestInit)=>Response|Promise<Response>}={}){
 const calls:{url:string;init:RequestInit}[]=[];
 const request=async(raw:string,init:RequestInit)=>{
  calls.push({url:raw,init});const url=new URL(raw);expect(url.origin).toBe('https://api.razorpay.com');
  expect(init.method).toBe('GET');expect(init.redirect).toBe('error');expect(init.cache).toBe('no-store');expect(init.credentials).toBe('omit');
  expect(init.body).toBeUndefined();expect(init.signal).toBeInstanceOf(AbortSignal);
  expect((init.headers as any).Authorization).toBe('Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'));
  if(url.pathname==='/v1/webhooks')return Response.json(collection(settings.hooks??[hook]));
  if(url.pathname==='/v1/webhooks/'+hook.id)return Response.json((settings.hooks??[hook])[0]);
  const path=url.pathname+url.search;if(settings.financial)return settings.financial(path,init);
  if(path==='/v1/orders?count=2&skip=0')return Response.json(collection(settings.orders??[order()]));
  if(path==='/v1/orders/'+orderId)return Response.json(settings.direct??order());
  if(path==='/v1/orders/'+orderId+'/payments')return Response.json(collection(settings.payments??Array.from({length:9},(_,i)=>payment(i+1))));
  throw Error('Unexpected synthetic URL');
 };return {calls,request};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');})));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('proves merchant first and distinguishes list string-zero from direct numeric zero without clearing obligations',async()=>{
 const f=fixture({orders:[order({amount_paid:'0'})]}),r=await audit(env,f.request,options);
 expect(r.stopped).toBe('READ_ONLY_DIRECT_REVIEW_COMPLETE');expect(r.merchantVerified).toBe(true);expect(r.requests).toBe(5);expect(r.financialRequests).toBe(3);
 expect(f.calls.map(c=>new URL(c.url).pathname+new URL(c.url).search)).toEqual(['/v1/webhooks?count=100&skip=0','/v1/webhooks/'+hook.id,
  '/v1/orders?count=2&skip=0','/v1/orders/'+orderId,'/v1/orders/'+orderId+'/payments']);
 expect(r.listed).toMatchObject({paidType:'string-zero',numericEquationKnown:false,dueEquationMatches:null,paidZero:null});
 expect(r.direct).toMatchObject({paidType:'integer',numericEquationKnown:true,dueEquationMatches:true,paidZero:true});
 expect(r.comparison.paidTypeMatches).toBe(false);expect(r.comparison.monetaryOperandsMatch).toBe(false);
 expect(r.payments).toMatchObject({records:9,complete:true,sameOrder:true,statuses:{authorized:7,failed:2,captured:0,refunded:0},capturedSumKnown:true,capturedPaidEquationMatches:true});
 expect(r).toMatchObject({financialClearance:'NOT_GRANTED',obligationsUnresolved:true,atomicSnapshot:false,liveReviewed:false,paddleReviewed:false,
  activationAuthorized:false,databaseCompared:false,signedDeliveryVerified:false,mutations:0,fullTreeAttested:false,externalDeploymentVerificationRequired:true});
 const output=reportLines(r).join('\n');for(const value of [orderId,privateText,hook.id,env.RAZORPAY_TEST_KEY_ID,env.RAZORPAY_TEST_KEY_SECRET,
  env.RAZORPAY_TEST_WEBHOOK_SECRET,env.RAZORPAY_TEST_ACCOUNT_ID,'merchantDigest','reportDigest'])expect(output).not.toContain(value);
 expect(reportLines(r)).toHaveLength(5);expect(reportLines(r).every((line:string)=>Buffer.byteLength(line)<=1900)).toBe(true);expect(fetch).not.toHaveBeenCalled();
});
it('never coerces matching string-zero operands into numeric arithmetic or paid-order evidence',async()=>{
 const r=await audit(env,fixture({orders:[order({amount_paid:'0'})],direct:order({amount_paid:'0'})}).request,options);
 expect(r.direct).toMatchObject({paidType:'string-zero',numericEquationKnown:false,paidZero:null,dueEquationMatches:null});
 expect(r.payments.capturedPaidEquationMatches).toBeNull();expect(r.comparison.paidTypeMatches).toBe(true);expect(r.financialClearance).toBe('NOT_GRANTED');
});
it.each([[undefined,'missing'],[null,'null'],['17','string-decimal'],['00','string-other'],[true,'boolean'],[{},'object'],[[],'array'],[-1,'number-other']])
 ('classifies paid operands without coercion (%j)',async(value,category)=>{
 const r=await audit(env,fixture({direct:order({amount_paid:value})}).request,options);expect(r.direct.paidType).toBe(category);
 expect(r.direct.numericEquationKnown).toBe(false);expect(r.payments.capturedPaidEquationMatches).toBeNull();
});
it.each([{orders:[]},{orders:[order(),order({id:'order_syntheticsecond01'})]}])('does not select from zero or multiple orders ($orders)',async({orders})=>{
 const f=fixture({orders}),r=await audit(env,f.request,options);expect(r.stopped).toBe('ORDER_COUNT_REVIEW');expect(r.financialRequests).toBe(1);
 expect(r.direct).toBeNull();expect(f.calls).toHaveLength(3);
});
it.each([{RAZORPAY_ENVIRONMENT:'live'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true'},{SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{VERCEL_GIT_COMMIT_SHA:'c'.repeat(40)}])
 ('requires disabled exact configuration and source before requests (%j)',async change=>{
 const f=fixture(),r=await audit({...env,...change},f.request,options);expect(r.financialRequests).toBe(0);expect(f.calls).toHaveLength(0);expect(r.merchantVerified).toBe(false);
});
it('does not read orders before matching merchant proof',async()=>{
 const f=fixture({hooks:[{...hook,owner_id:'foreignmerchant01'}]}),r=await audit(env,f.request,options);
 expect(r.stopped).toBe('MERCHANT_REVIEW_REQUIRED');expect(r.financialRequests).toBe(0);expect(f.calls.every(c=>new URL(c.url).pathname.startsWith('/v1/webhooks'))).toBe(true);
});
it('rejects accessor configuration without invoking it',async()=>{
 const input={...env},getter=vi.fn(()=>privateText);Object.defineProperty(input,'RAZORPAY_TEST_KEY_SECRET',{get:getter});
 const f=fixture(),r=await audit(input,f.request,options);expect(r.stopped).toBe('CONFIGURATION');expect(getter).not.toHaveBeenCalled();expect(f.calls).toHaveLength(0);
});
it('rejects different order and cross-order or duplicate payments',async()=>{
 const wrong=await audit(env,fixture({direct:order({id:'order_syntheticforeign01'})}).request,options);expect(wrong.stopped).toBe('ORDER_DIRECT_UNAVAILABLE');expect(wrong.failure).toBe('IDENTITY');expect(wrong.financialRequests).toBe(2);
 for(const [payments,code]of [[[payment(1,{order_id:'order_syntheticforeign01'})],'CROSS_ORDER'],[[payment(1),payment(1)],'DUPLICATE_PAYMENT']] as const){
  const r=await audit(env,fixture({payments:[...payments]}).request,options);expect(r.stopped).toBe('ORDER_PAYMENTS_UNAVAILABLE');expect(r.failure).toBe(code);expect(r.payments.complete).toBe(false);
 }
});
it('never compares two different unknown statuses as equal',async()=>{
 const r=await audit(env,fixture({orders:[order({status:'unknown-one'})],direct:order({status:'unknown-two'})}).request,options);
 expect(r.listed.state).toBe('unknown');expect(r.direct.state).toBe('unknown');expect(r.comparison.statusMatches).toBe(false);
});
it('marks a full bounded payment page incomplete without pagination',async()=>{
 const f=fixture({payments:Array.from({length:100},(_,i)=>payment(i+1))}),r=await audit(env,f.request,options);
 expect(r.payments.records).toBe(100);expect(r.payments.complete).toBe(false);expect(r.payments.capturedSumKnown).toBe(false);
 expect(r.payments.capturedPaidEquationMatches).toBeNull();expect(r.financialRequests).toBe(3);expect(f.calls).toHaveLength(5);
});
it.each([401,429,503])('does not retry or echo provider failures (%s)',async status=>{
 const f=fixture({financial:()=>new Response(privateText,{status})}),r=await audit(env,f.request,options);
 expect(r.stopped).toBe('ORDER_LIST_UNAVAILABLE');expect(r.financialRequests).toBe(1);expect(f.calls).toHaveLength(3);
 expect(reportLines(r).join('\n')).not.toContain(privateText);expect(f.calls[2].init.signal?.aborted).toBe(true);
});
it('preserves10s financial deadline when abort is ignored and cancellation never settles',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const f=fixture({financial:()=>Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(){},cancel}),{headers:{'content-type':'application/json'}}))});
 let finished=false;const pending=audit(env,f.request,options).then((r:any)=>{finished=true;return r;});
 await vi.advanceTimersByTimeAsync(0);expect(f.calls).toHaveLength(3);await vi.advanceTimersByTimeAsync(9999);expect(finished).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(finished).toBe(true);const r=await pending;expect(r.failure).toBe('DEADLINE');expect(r.financialRequests).toBe(1);
 expect(cancel).toHaveBeenCalledOnce();expect(f.calls[2].init.signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('strictly rejects hidden, accessor, extra or unbounded report fields',async()=>{
 const r=await audit(env,fixture().request,options);expect(()=>reportLines({...r,rawBody:privateText})).toThrow('Safe direct-order report refused.');
 expect(()=>reportLines({...r,requests:17})).toThrow();expect(()=>reportLines({...r,direct:{...r.direct,state:privateText}})).toThrow();
 const getter=vi.fn(()=>privateText),bad={...r};Object.defineProperty(bad,'failure',{get:getter});expect(()=>reportLines(bad)).toThrow();expect(getter).not.toHaveBeenCalled();
});
