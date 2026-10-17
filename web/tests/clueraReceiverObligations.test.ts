import {afterEach,beforeEach,test,vi} from 'vitest';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {audit,auditReceiverInventory,serializeReport}=require('../../scripts/payments/audit-cluera-test-obligations.cjs');
const sha='a'.repeat(40),webhookId='webhook_synthetic1',options={expectedSourceSha:sha,expectedWebhookId:webhookId};
const env={VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',
 VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:sha,SIGMAROUND_ACCOUNTS_ENABLED:'true',
 SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
 SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',RAZORPAY_ENVIRONMENT:'test',SIGMAROUND_PAYMENT_PROVIDER:'razorpay',
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',CLUERA_BILLING_V2_ENABLED:'true',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false',RAZORPAY_TEST_KEY_ID:'rzp_test_synthetic123456',
 RAZORPAY_TEST_KEY_SECRET:'synthetic-api-secret-not-a-real-key',RAZORPAY_TEST_WEBHOOK_SECRET:'synthetic-webhook-secret-not-a-real-key',
 RAZORPAY_TEST_ACCOUNT_ID:'acc_synthetic123456'};
const webhook={id:webhookId,url:'https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',
 service:'api-test',owner_type:'merchant',owner_id:'synthetic123456',active:true,disabled_at:1234567890,secret_exists:true,
 events:['payment.captured','order.paid','refund.processed']};
const collection=(items:unknown[])=>({entity:'collection',count:items.length,items});
type Fixture={hooks?:Record<string,unknown>[];direct?:Record<string,unknown>;financial?:(name:string)=>Record<string,unknown>[];onRequest?:(number:number)=>void};
function fetcher({hooks=[webhook],direct=webhook,financial=()=>[],onRequest}:Fixture={}){
 const calls:string[]=[];
 return {calls,request:async(raw:string,init:RequestInit)=>{
  const url=new URL(raw);calls.push(url.pathname+url.search);onRequest?.(calls.length);
  assert.equal(url.origin,'https://api.razorpay.com');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
  assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal((init.headers as Record<string,string>).Authorization,'Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'));
  if(url.pathname==='/v1/webhooks'){assert.equal(url.search,'?count=100&skip=0');return Response.json(collection(hooks));}
  if(url.pathname==='/v1/webhooks/'+webhookId){assert.equal(url.search,'');return Response.json(direct);}
  assert.match(url.pathname,/^\/v1\/(orders|payments|refunds|subscriptions)$/);assert.equal(url.search,'?count=100&skip=0');
  return Response.json(collection(financial(url.pathname.slice(4))));
 }};
}
const financialCalls=(calls:string[])=>calls.filter(path=>!path.startsWith('/v1/webhooks'));
beforeEach(()=>vi.stubGlobal('fetch',()=>{throw Error('Unexpected real-network fallback');}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

test('receiver canonical same-ID listing and direct GET precede four financial GETs without rewriting configuration',async()=>{
 const f=fetcher(),input={...env},before=JSON.stringify(input),r=await auditReceiverInventory(input,f.request,options);
 assert.equal(r.stopped,'READ_ONLY_INVENTORY_COMPLETE');assert.equal(r.requests,6);assert.equal(r.financialRequests,4);
 assert.deepEqual(f.calls,['/v1/webhooks?count=100&skip=0','/v1/webhooks/'+webhookId,
  '/v1/orders?count=100&skip=0','/v1/payments?count=100&skip=0','/v1/refunds?count=100&skip=0','/v1/subscriptions?count=100&skip=0']);
 assert.deepEqual(r.merchant,{configurationAccepted:true,testAuthentication:true,listingComplete:true,verified:true,newDestinationState:'MATCHED_TEST_MERCHANT'});
 assert.equal(r.completeInventory,true);assert.equal(r.needsReview,false);assert.equal(r.mutations,0);
 assert.equal(r.financialClearance,'NOT_GRANTED');assert.equal(r.obligationsUnresolved,true);assert.equal(r.signedDeliveryVerified,false);
 assert.equal(r.activationAuthorized,false);assert.equal(r.liveReviewed,false);assert.equal(r.paddleReviewed,false);assert.equal(JSON.stringify(input),before);
});
for(const change of [
 {CLUERA_BILLING_V2_ENABLED:'false'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'},
 {SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'},{SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true'},
 {SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true'},
 {VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)},{RAZORPAY_ENVIRONMENT:'live'},
])test('receiver refuses wrong actual phase before any GET: '+Object.keys(change)[0],async()=>{
 const f=fetcher(),r=await auditReceiverInventory({...env,...change},f.request,options);
 assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);assert.equal(r.financialRequests,0);
});
test('external gate must be an actual own false descriptor, not absent/getter substitute',async()=>{
 for(const accessor of [false,true]){
  const input:Record<string,string>={...env};delete input.CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED;let called=false;
  if(accessor)Object.defineProperty(input,'CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED',{get(){called=true;return 'false';}});
  const f=fetcher(),r=await auditReceiverInventory(input,f.request,options);
  assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);assert.equal(called,false);
 }
});
test('receiver options are exact and getters are never evaluated',async()=>{
 const getter=vi.fn(()=>webhookId),withGetter=Object.defineProperty({expectedSourceSha:sha},'expectedWebhookId',{get:getter});
 for(const opts of [{expectedSourceSha:sha},{...options,phase:'receiver'},withGetter]){
  const f=fetcher(),r=await auditReceiverInventory(env,f.request,opts);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
 }assert.equal(getter.mock.calls.length,0);
});
test('wrong expected ID cannot cause direct read or any financial GET',async()=>{
 const f=fetcher(),r=await auditReceiverInventory(env,f.request,{...options,expectedWebhookId:'webhook_different123'});
 assert.equal(r.stopped,'MERCHANT_REVIEW_REQUIRED');assert.deepEqual(f.calls,['/v1/webhooks?count=100&skip=0']);assert.equal(r.financialRequests,0);
});
for(const fixture of [
 {name:'old URL',hooks:[{...webhook,url:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook'}]},
 {name:'parallel destination',hooks:[webhook,{...webhook,id:'webhook_parallel123',url:'https://foreign.invalid/webhook'}]},
 {name:'foreign listing merchant',hooks:[{...webhook,owner_id:'foreign123456'}]},
 {name:'foreign direct merchant',direct:{...webhook,owner_id:'foreign123456'}},
 {name:'changed direct URL',direct:{...webhook,url:'https://foreign.invalid/webhook'}},
 {name:'non-boolean active',hooks:[{...webhook,active:'true'}],direct:{...webhook,active:'true'}},
 {name:'extra event',hooks:[{...webhook,events:[...webhook.events,'subscription.charged']}],direct:{...webhook,events:[...webhook.events,'subscription.charged']}},
])test('unaccepted receiver proof permits no financial GET: '+fixture.name,async()=>{
 const f=fetcher(fixture),r=await auditReceiverInventory(env,f.request,options);
 assert.equal(r.stopped,'MERCHANT_REVIEW_REQUIRED');assert.equal(r.financialRequests,0);assert.deepEqual(financialCalls(f.calls),[]);
 assert.equal(r.merchant.verified,false);assert.equal(r.financialClearance,'NOT_GRANTED');
});
test('OFF API ignores extra phase argument and retains original external-descriptor behavior',async()=>{
 const blocked=fetcher(),r=await audit(env,blocked.request,{expectedSourceSha:sha},()=>0,true);
 assert.equal(r.stopped,'CONFIGURATION');assert.equal(blocked.calls.length,0);
 const off={...env,CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'};
 const rejected=fetcher(),receiver=await auditReceiverInventory(off,rejected.request,options);
 assert.equal(receiver.stopped,'CONFIGURATION');assert.equal(rejected.calls.length,0);
 let getterCalled=false;Object.defineProperty(off,'CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED',{get(){getterCalled=true;return 'true';}});
 const accepted=fetcher(),original=await audit(off,accepted.request,{expectedSourceSha:sha});
 assert.equal(original.stopped,'READ_ONLY_INVENTORY_COMPLETE');assert.equal(original.financialRequests,4);assert.equal(getterCalled,false);
});
test('snapshot holds original keys/gate after caller mutation during readiness',async()=>{
 const input={...env},f=fetcher({onRequest:n=>{if(n===1){input.RAZORPAY_TEST_KEY_SECRET='changed-after-snapshot';input.CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED='true';}}});
 const r=await auditReceiverInventory(input,f.request,options);assert.equal(r.stopped,'READ_ONLY_INVENTORY_COMPLETE');assert.equal(r.financialRequests,4);
});
test('null amount_paid retains strict warning and safe bounded facts without coercion or clearance',async()=>{
 const privateText='DO_NOT_ECHO_PRIVATE_CUSTOMER',order={id:'order_synthetic1',entity:'order',status:'attempted',amount:54900,
  amount_paid:null,amount_due:54900,currency:'INR',notes:{privateText},email:'private@example.invalid'};
 const f=fetcher({financial:name=>name==='orders'?[order]:[]}),r=await auditReceiverInventory(env,f.request,options);
 assert.equal(r.stopped,'READ_ONLY_INVENTORY_COMPLETE');assert.equal(r.completeInventory,true);assert.equal(r.needsReview,true);
 assert.equal(r.collections.orders.amounts.knownPaid,0);assert.equal(r.collections.orders.amounts.complete,false);
 assert.equal(r.collections.orders.validationFacts.paidNonNumeric,1);assert.equal(r.collections.orders.validationFacts.dueEquationMismatch,0);
 assert.deepEqual(r.collections.orders.warnings,['INCONSISTENT_ORDER','NONEMPTY_HISTORY']);
 assert.equal(r.financialClearance,'NOT_GRANTED');assert.equal(r.signedDeliveryVerified,false);
 const lines=serializeReport(r);assert.equal(lines.length,6);
 for(const line of lines){assert.ok(Buffer.byteLength(line)<=1900);assert.equal(/[\r\n]/.test(line),false);}
 const out=lines.join('\n');for(const forbidden of [webhookId,order.id,privateText,order.email,...Object.values(env).filter(v=>v.startsWith('rzp_')||v.startsWith('synthetic-')||v.startsWith('acc_'))])assert.equal(out.includes(forbidden),false);
 assert.throws(()=>serializeReport({...r,providerBody:privateText}),/refused/);
 let getterCalled=false;const poisoned=Object.defineProperty({...r},'merchant',{get(){getterCalled=true;return r.merchant;}});
 assert.throws(()=>serializeReport(poisoned),/refused/);assert.equal(getterCalled,false);
});
