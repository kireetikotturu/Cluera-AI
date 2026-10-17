import {afterEach,beforeEach,test,vi} from 'vitest';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {audit}=require('../../scripts/payments/audit-cluera-test-obligations.cjs');
const sha='a'.repeat(40),options={expectedSourceSha:sha};
const env={VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',
 VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:sha,SIGMAROUND_ACCOUNTS_ENABLED:'true',
 SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
 SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',RAZORPAY_ENVIRONMENT:'test',SIGMAROUND_PAYMENT_PROVIDER:'razorpay',
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 RAZORPAY_TEST_KEY_ID:'rzp_test_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'synthetic-api-secret-not-a-real-key',
 RAZORPAY_TEST_WEBHOOK_SECRET:'synthetic-webhook-secret-not-a-real-key',RAZORPAY_TEST_ACCOUNT_ID:'acc_synthetic123456'};
const webhook={id:'webhook_synthetic1',url:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook',
 service:'api-test',owner_type:'merchant',owner_id:'synthetic123456',active:true,disabled_at:0,secret_exists:true,
 events:['payment.captured','order.paid','refund.processed']};
const collection=(items:any[])=>({entity:'collection',count:items.length,items});
const order=(n=1,extra={})=>({id:'order_synthetic'+n,entity:'order',status:'created',amount:54900,amount_paid:0,amount_due:54900,currency:'INR',...extra});
const payment=(n=1,extra={})=>({id:'pay_synthetic'+n,entity:'payment',status:'captured',amount:54900,amount_refunded:0,refund_status:null,
 captured:true,currency:'INR',order_id:'order_synthetic1',...extra});
const refund=(n=1,extra={})=>({id:'rfnd_synthetic'+n,entity:'refund',status:'processed',amount:54900,currency:'INR',payment_id:'pay_synthetic1',...extra});
const subscription=(n=1,extra={})=>({id:'sub_synthetic'+n,entity:'subscription',status:'created',total_count:12,paid_count:0,remaining_count:12,...extra});
type Financial=(name:string,page:number,url:string,init:RequestInit)=>Response|Promise<Response>;
function fetcher(financial:Financial=()=>Response.json(collection([])),hooks=[webhook]){
 const calls:{url:string;init:RequestInit}[]=[];
 return {calls,request:async(raw:string,init:RequestInit)=>{
  const url=new URL(raw);calls.push({url:raw,init});assert.equal(url.origin,'https://api.razorpay.com');
  assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');
  assert.ok(init.signal instanceof AbortSignal);assert.equal((init.headers as any).Authorization,'Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'));
  if(url.pathname==='/v1/webhooks')return Response.json(collection(hooks));
  if(url.pathname==='/v1/webhooks/'+webhook.id)return Response.json(hooks[0]);
  assert.match(url.pathname,/^\/v1\/(orders|payments|refunds|subscriptions)$/);assert.equal(url.searchParams.get('count'),'100');
  assert.match(url.searchParams.get('skip')!,/^(?:0|100|200|300|400|500|600|700|800|900)$/);
  return financial(url.pathname.slice(4),Number(url.searchParams.get('skip'))/100,raw,init);
 }};
}
beforeEach(()=>vi.stubGlobal('fetch',()=>{throw Error('Unexpected real-network fallback');}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

test('complete empty Test inventory uses merchant proof BEFORE all financial reads and never clears Live/Paddle',async()=>{
 const f=fetcher(),before=JSON.stringify(env),r=await audit(env,f.request,options);
 assert.equal(r.stopped,'READ_ONLY_INVENTORY_COMPLETE');assert.equal(r.completeInventory,true);assert.equal(r.needsReview,false);
 assert.equal(r.merchant.configurationAccepted,true);assert.equal(r.merchant.verified,true);assert.equal(r.merchant.newDestinationState,'MISSING');
 assert.deepEqual(f.calls.map(c=>new URL(c.url).pathname),['/v1/webhooks','/v1/webhooks/'+webhook.id,'/v1/orders','/v1/payments','/v1/refunds','/v1/subscriptions']);
 assert.equal(r.financialRequests,4);assert.equal(r.requests,6);assert.equal(r.mutations,0);assert.equal(r.atomicSnapshot,false);
 assert.equal(r.liveReviewed,false);assert.equal(r.paddleReviewed,false);assert.equal(r.activationAuthorized,false);assert.equal(r.databaseCompared,false);
 assert.equal(r.limitation,'BOUNDED_NON_ATOMIC_TEST_COLLECTIONS_NOT_FINANCIAL_CLEARANCE');assert.equal('obligationsCleared' in r,false);
 assert.equal(r.financialClearance,'NOT_GRANTED');assert.equal(r.obligationsUnresolved,true);
 assert.equal(JSON.stringify(env),before);for(const value of Object.values(env).filter(v=>v.startsWith('rzp_')||v.startsWith('synthetic-')||v.startsWith('acc_')))assert.ok(!JSON.stringify(r).includes(value));
});

for(const change of [
 {CLUERA_BILLING_V2_ENABLED:'true'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true'},{SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'},
 {SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true'},{SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true'},{SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},
 {SIGMAROUND_ACCOUNTS_ENABLED:'false'},{SIGMAROUND_ACCOUNT_ORIGIN:'https://foreign.invalid'},{NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co'},
 {SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'dwqltsqumiwsxtkzdoaa'},{RAZORPAY_ENVIRONMENT:'live'},{RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456'},
 {VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)},{VERCEL_ENV:'preview'},
])test('actual application/config boundary rejects before any request: '+Object.keys(change)[0],async()=>{
 const f=fetcher(),r=await audit({...env,...change},f.request,options);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);assert.equal(r.completeInventory,false);
});

test('invalid options/accessor env cannot bypass the actual configuration gate',async()=>{
 for(const opts of [{},{...options,origin:'https://foreign.invalid'},{expectedSourceSha:'short'}]){
  const f=fetcher(),r=await audit(env,f.request,opts);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
 }
 let getterCalled=false;const input={...env};Object.defineProperty(input,'RAZORPAY_TEST_KEY_SECRET',{get(){getterCalled=true;return 'private';}});
 const f=fetcher(),r=await audit(input,f.request,options);assert.equal(r.stopped,'CONFIGURATION');assert.equal(getterCalled,false);assert.equal(f.calls.length,0);
});

test('absent optional platform metadata requires external pin verification rather than an invented match',async()=>{
 const input:any={...env};for(const key of ['VERCEL_TARGET_ENV','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA'])delete input[key];
 const f=fetcher(),r=await audit(input,f.request,options);assert.equal(r.completeInventory,true);assert.equal(r.merchant.configurationAccepted,true);
 assert.equal(r.fullTreeAttested,false);assert.equal(r.externalDeploymentVerificationRequired,true);
});

test('foreign/Live/unknown/missing Test merchant proof permits ZERO financial reads',async()=>{
 for(const hooks of [[],[{...webhook,owner_id:'foreign123456'}],[{...webhook,service:'api-live'}],[{...webhook,url:'https://untrusted.invalid/webhook'}]]){
  const f=fetcher(undefined,hooks),r=await audit(env,f.request,options);assert.equal(r.stopped,'MERCHANT_REVIEW_REQUIRED');assert.equal(r.financialRequests,0);
  assert.ok(f.calls.every(c=>new URL(c.url).pathname.startsWith('/v1/webhooks')));
 }
});

test('complete observed histories are preserved aggregate evidence, not a clearance or grant',async()=>{
 const rows:any={orders:[order(1,{status:'paid',amount_paid:54900,amount_due:0})],
  payments:[payment(1,{status:'refunded',amount_refunded:54900,refund_status:'full'})],refunds:[refund()],subscriptions:[subscription()]};
 const f=fetcher(name=>Response.json(collection(rows[name]))),r=await audit(env,f.request,options);
 assert.equal(r.completeInventory,true);assert.equal(r.needsReview,true);assert.equal(r.collections.orders.statuses.paid,1);
 assert.equal(r.collections.orders.amounts.knownPaid,54900);assert.equal(r.collections.payments.amounts.knownRefunded,54900);
 assert.equal(r.collections.subscriptions.amounts,null);assert.ok(r.collections.subscriptions.warnings.includes('SUBSCRIPTION_AMOUNT_UNAVAILABLE'));
 const out=JSON.stringify(r);for(const row of Object.values(rows).flat() as any[])assert.ok(!out.includes(row.id));
 for(const target of Object.values(r.collections) as any[])assert.ok(target.warnings.includes('NONEMPTY_HISTORY'));
 assert.ok(!r.collections.orders.warnings.includes('ORDER_PAYMENT_TOTAL_REVIEW'));assert.ok(!r.collections.payments.warnings.includes('REFUND_TOTAL_REVIEW'));
});

test('unknown statuses, malformed amounts and currencies are fixed review categories and never reflected',async()=>{
 const malicious='DO_NOT_ECHO_PRIVATE_PROVIDER_PAYLOAD';
 const f=fetcher(name=>Response.json(collection(name==='orders'?[order(1,{status:malicious,amount:malicious,currency:malicious})]:[])));
 const r=await audit(env,f.request,options);assert.equal(r.completeInventory,true);assert.equal(r.needsReview,true);
 assert.equal(r.collections.orders.statuses.unknown,1);assert.equal(r.collections.orders.currency.unknown,1);assert.equal(r.collections.orders.amounts.complete,false);
 for(const code of ['UNKNOWN_STATUS','INVALID_AMOUNT','UNKNOWN_CURRENCY'])assert.ok(r.collections.orders.warnings.includes(code));
 assert.ok(!JSON.stringify(r).includes(malicious));
});

test('valid non-INR amounts are counted separately, never fabricated as INR totals',async()=>{
 const f=fetcher(name=>Response.json(collection(name==='orders'?[order(1,{currency:'USD'})]:[]))),r=await audit(env,f.request,options);
 assert.equal(r.collections.orders.currency.other,1);assert.equal(r.collections.orders.amounts.knownAmount,0);
 assert.equal(r.collections.orders.amounts.complete,false);assert.ok(r.collections.orders.warnings.includes('NON_INR_CURRENCY'));
 assert.ok(!JSON.stringify(r).includes('USD'));
});

test('safe integer totals never silently overflow and numeric strings are not money',async()=>{
 const max=Number.MAX_SAFE_INTEGER;
 const f=fetcher(name=>Response.json(collection(name==='orders'?[order(1,{amount:max,amount_due:max}),order(2,{amount:max,amount_due:max}),order(3,{amount:'54900'})]:[])));
 const r=await audit(env,f.request,options);assert.equal(r.collections.orders.amounts.knownAmount,null);assert.equal(r.collections.orders.amounts.complete,false);
 assert.ok(r.collections.orders.warnings.includes('AMOUNT_OVERFLOW'));assert.ok(r.collections.orders.warnings.includes('INVALID_AMOUNT'));
});

test('duplicate IDs across pages are not double-counted or declared complete',async()=>{
 const first=Array.from({length:100},(_,i)=>order(i));
 const f=fetcher((name,page)=>Response.json(collection(name==='orders'?(page===0?first:[first[0]]):[]))),r=await audit(env,f.request,options);
 assert.equal(r.completeInventory,false);assert.equal(r.collections.orders.complete,false);assert.equal(r.collections.orders.records,100);
 assert.equal(r.collections.orders.duplicateIds,1);assert.equal(r.collections.orders.amounts.knownAmount,5490000);assert.ok(r.collections.orders.warnings.includes('DUPLICATE_ID'));
});

test('a full first page followed by an empty page completes bounded enumeration without inventing total metadata',async()=>{
 const f=fetcher((name,page)=>Response.json(collection(name==='orders'&&page===0?Array.from({length:100},(_,i)=>order(i)):[])));
 const r=await audit(env,f.request,options);assert.equal(r.collections.orders.complete,true);assert.equal(r.collections.orders.pages,2);
 assert.equal(r.collections.orders.records,100);assert.equal(r.financialRequests,5);assert.equal(r.needsReview,true);
});

test('malformed record identity/entity is explicit incomplete evidence, not an empty collection',async()=>{
 for(const row of [null,{...order(),id:'bad/id'},{...order(),entity:'payment'}]){
  const f=fetcher(name=>Response.json(collection(name==='orders'?[row]:[]))),r=await audit(env,f.request,options);
  assert.equal(r.collections.orders.complete,false);assert.equal(r.collections.orders.invalidRecords,1);assert.ok(r.collections.orders.warnings.includes('INVALID_RECORD'));
 }
});

test('each collection is capped at ten 100-row pages and no forty-first financial GET occurs',async()=>{
 const factories:any={orders:order,payments:payment,refunds:refund,subscriptions:subscription};
 const f=fetcher((name,page)=>Response.json(collection(Array.from({length:100},(_,i)=>factories[name](page*100+i))))),r=await audit(env,f.request,options);
 assert.equal(r.financialRequests,40);assert.equal(r.requests,42);assert.equal(r.completeInventory,false);assert.equal(r.needsReview,true);
 for(const target of Object.values(r.collections) as any[]){assert.equal(target.pages,10);assert.equal(target.complete,false);assert.equal(target.records,1000);assert.ok(target.warnings.includes('PAGE_CAP'));}
});

test('ambiguous pagination/count/collection shapes stop that collection without inventing absence',async()=>{
 for(const raw of [{items:[]},{entity:'collection',count:1,items:[]},{entity:'collection',count:0,items:[],has_more:false},
  {entity:'collection',count:0,items:[],total_count:100},
  {entity:'collection',count:101,items:Array.from({length:101},()=>order())},{entity:'collection',count:0,items:{}}]){
  const f=fetcher(name=>Response.json(name==='orders'?raw:collection([]))),r=await audit(env,f.request,options);
  assert.equal(r.collections.orders.complete,false);assert.equal(r.collections.orders.pages,0);assert.ok(r.collections.orders.warnings.includes('COLLECTION_SHAPE'));
 }
});

for(const [status,category] of [[401,'HTTP_AUTH'],[403,'HTTP_AUTH'],[429,'HTTP_RATE_LIMIT'],[500,'HTTP_UNAVAILABLE']] as const)
test('financial HTTP '+status+' is unavailable, never zero or reflected raw provider error',async()=>{
 const secret='DO_NOT_ECHO_PROVIDER_ERROR',f=fetcher(name=>name==='orders'?Response.json({error:secret},{status}):Response.json(collection([])));
 const r=await audit(env,f.request,options);assert.equal(r.collections.orders.complete,false);assert.ok(r.collections.orders.warnings.includes(category));
 assert.ok(!JSON.stringify(r).includes(secret));assert.equal(f.calls.filter(c=>c.url.includes('/orders?')).length,1);
});

test('redirect/content type/content length/body/UTF8/JSON limits are enforced without payload echo',async()=>{
 const secret='DO_NOT_ECHO_REDIRECT_OR_BODY';
 const responses=[new Response(secret,{status:302,headers:{location:'https://untrusted.invalid/'+secret}}),
  new Response(secret,{headers:{'content-type':'text/html'}}),
  new Response(secret,{headers:{'content-type':'application/json','content-length':'262145'}}),
  new Response(' '.repeat(262145),{headers:{'content-type':'application/json'}}),
  new Response(new Uint8Array([0xc3,0x28]),{headers:{'content-type':'application/json'}}),
  new Response(secret,{headers:{'content-type':'application/json'}})];
 const categories=['REDIRECT','CONTENT_TYPE','BODY_BOUND','BODY_BOUND','MALFORMED_BODY','MALFORMED_BODY'];
 for(let i=0;i<responses.length;i++){
  const f=fetcher(name=>name==='orders'?responses[i]:Response.json(collection([]))),r=await audit(env,f.request,options);
  assert.equal(r.collections.orders.complete,false);assert.ok(r.collections.orders.warnings.includes(categories[i]));assert.ok(!JSON.stringify(r).includes(secret));
 }
});

test('fetch and stream deadlines include uncooperative cancellation without retry',async()=>{
 vi.useFakeTimers();
 for(const stream of [false,true]){
  const f=fetcher(name=>name!=='orders'?Response.json(collection([])):stream
   ?new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}})
   :new Promise(()=>{}));
  const pending=audit(env,f.request,options);await vi.advanceTimersByTimeAsync(10001);const r=await pending;
  assert.equal(r.collections.orders.complete,false);assert.ok(r.collections.orders.warnings.includes('DEADLINE'));
  assert.equal(f.calls.filter(c=>c.url.includes('/orders?')).length,1);
 }
});

test('raw thrown errors are reduced to a fixed network category',async()=>{
 const secret='DO_NOT_ECHO_EXCEPTION',f=fetcher(name=>{if(name==='orders')throw Error(secret);return Response.json(collection([]));});
 const r=await audit(env,f.request,options);assert.ok(r.collections.orders.warnings.includes('NETWORK'));assert.ok(!JSON.stringify(r).includes(secret));
});

test('whole-inventory monotonic deadline prevents further financial requests without changing bounds',async()=>{
 let clock=0;
 const f=fetcher(name=>{if(name==='orders')clock=500001;return Response.json(collection([]));});
 const r=await audit(env,f.request,options,()=>clock);assert.equal(r.financialRequests,1);assert.equal(r.completeInventory,false);
 assert.ok(r.collections.orders.warnings.includes('DEADLINE'));assert.equal(r.collections.orders.complete,false);
 for(const name of ['payments','refunds','subscriptions'])assert.ok(r.collections[name].warnings.includes('DEADLINE'));
});

test('monotonic deadline is rechecked after body/JSON parse before accepting a page',async()=>{
 let clock=0;const parse=JSON.parse;let emptyBodies=0;
 vi.spyOn(JSON,'parse').mockImplementation((text:string,...rest:any[])=>{
  const value=parse(text,...rest);if(text===JSON.stringify(collection([]))&&++emptyBodies===4)clock=500001;return value;
 });
 const r=await audit(env,fetcher().request,options,()=>clock);assert.equal(r.collections.subscriptions.complete,false);
 assert.ok(r.collections.subscriptions.warnings.includes('DEADLINE'));assert.equal(r.completeInventory,false);assert.equal(r.needsReview,true);
});

test('final monotonic deadline cannot certify a late final collection as a complete inventory',async()=>{
 const parse=JSON.parse;let emptyBodies=0,finalChecks=0;
 vi.spyOn(JSON,'parse').mockImplementation((text:string,...rest:any[])=>{
  const value=parse(text,...rest);if(text===JSON.stringify(collection([])))emptyBodies++;return value;
 });
 const r=await audit(env,fetcher().request,options,()=>emptyBodies===4&&++finalChecks>1?500001:0);
 assert.equal(r.stopped,'INVENTORY_DEADLINE');assert.equal(r.completeInventory,false);assert.equal(r.needsReview,true);
 assert.ok(r.warnings.includes('DEADLINE'));assert.equal(r.financialClearance,'NOT_GRANTED');
});

test('order/payment/refund linkage, currency, capture, refund and cycle inconsistencies require review',async()=>{
 const rows:any={orders:[order(1,{status:'paid',amount_paid:1,amount_due:0})],
  payments:[payment(1,{order_id:'order_missing',captured:false,amount_refunded:54901,refund_status:'full'})],
  refunds:[refund(1,{payment_id:'pay_missing',currency:'USD'})],subscriptions:[subscription(1,{paid_count:13})]};
 const f=fetcher(name=>Response.json(collection(rows[name]))),r=await audit(env,f.request,options);
 assert.equal(r.needsReview,true);assert.ok(r.collections.orders.warnings.includes('INCONSISTENT_ORDER'));
 for(const code of ['INCONSISTENT_CAPTURE','INCONSISTENT_REFUND','MISSING_ORDER_REFERENCE','REFUND_TOTAL_REVIEW'])assert.ok(r.collections.payments.warnings.includes(code));
 assert.ok(r.collections.refunds.warnings.includes('MISSING_PAYMENT_REFERENCE'));assert.ok(r.collections.subscriptions.warnings.includes('INCONSISTENT_CYCLES'));
});

test('cross-currency linkage cannot silently reconcile or leak currency/identities',async()=>{
 const rows:any={orders:[order()],payments:[payment(1,{currency:'USD'})],refunds:[refund()],subscriptions:[]};
 const r=await audit(env,fetcher(name=>Response.json(collection(rows[name]))).request,options);
 assert.ok(r.collections.payments.warnings.includes('CROSS_CURRENCY'));assert.ok(r.collections.refunds.warnings.includes('CROSS_CURRENCY'));
 assert.ok(!JSON.stringify(r).includes('USD'));assert.equal(r.needsReview,true);
});
