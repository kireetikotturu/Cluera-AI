import {afterEach,beforeEach,test,vi} from 'vitest';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const readiness=require('../../scripts/payments/audit-cluera-test-readiness.cjs');
const inventory=require('../../scripts/payments/audit-cluera-test-obligations.cjs');
const sha='a'.repeat(40),owner='00000000-0000-4000-8000-000000000801',hookId='webhook_synthetic1';
const options={expectedSourceSha:sha,expectedWebhookId:hookId,expectedOwnerUuid:owner};
const base={VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',
 VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:sha,SIGMAROUND_ACCOUNTS_ENABLED:'true',
 SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
 SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',RAZORPAY_ENVIRONMENT:'test',SIGMAROUND_PAYMENT_PROVIDER:'razorpay',
 CLUERA_BILLING_V2_ENABLED:'true',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true',
 SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true',
 CLUERA_PROVIDER_VAULT_ENABLED:'false',CLUERA_AI_BOOTSTRAP_MODE:'auth-only',SIGMAROUND_PAYMENT_TESTER_IDS:owner,
 RAZORPAY_TEST_KEY_ID:'rzp_test_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'synthetic-api-secret-not-a-real-key',
 RAZORPAY_TEST_WEBHOOK_SECRET:'synthetic-webhook-secret-not-a-real-key',RAZORPAY_TEST_ACCOUNT_ID:'acc_synthetic123456'};
const env=(enabled:boolean)=>({...base,SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:enabled?'true':'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:enabled?'false':'true'});
const hook={id:hookId,url:'https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',service:'api-test',
 owner_type:'merchant',owner_id:'synthetic123456',active:true,disabled_at:1234567890,secret_exists:true,
 events:['payment.captured','order.paid','refund.processed']};
const collection=(items:any[])=>({entity:'collection',count:items.length,items});
function fetcher(hooks:any[]=[hook],direct:any=hook,orders:any[]=[],onRequest?:(count:number)=>void){
 const calls:string[]=[];
 return {calls,request:async(raw:string,init:RequestInit)=>{
  const url=new URL(raw);calls.push(url.pathname+url.search);onRequest?.(calls.length);
  assert.equal(url.origin,'https://api.razorpay.com');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
  assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');assert.ok(init.signal instanceof AbortSignal);
  assert.equal((init.headers as any).Authorization,'Basic '+Buffer.from(base.RAZORPAY_TEST_KEY_ID+':'+base.RAZORPAY_TEST_KEY_SECRET).toString('base64'));
  if(url.pathname==='/v1/webhooks'){assert.equal(url.search,'?count=100&skip=0');return Response.json(collection(hooks));}
  if(url.pathname==='/v1/webhooks/'+hookId){assert.equal(url.search,'');return Response.json(direct);}
  assert.match(url.pathname,/^\/v1\/(orders|payments|refunds|subscriptions)$/);assert.equal(url.search,'?count=100&skip=0');
  return Response.json(collection(url.pathname==='/v1/orders'?orders:[]));
 }};
}
beforeEach(()=>vi.stubGlobal('fetch',()=>{throw Error('Unexpected real-network/Auth fallback');}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

for(const enabled of [false,true]){
 const phase=enabled?'enabled':'prepared';
 const audit=enabled?readiness.auditCheckout:readiness.auditCheckoutPrepared;
 const auditInventory=enabled?inventory.auditCheckoutInventory:inventory.auditCheckoutPreparedInventory;
 test(phase+' proves only its actual checkout phase and sole pinned tester, with two canonical GETs',async()=>{
  const input=env(enabled),before=JSON.stringify(input),f=fetcher(),r=await audit(input,f.request,options);
  assert.equal(r.stopped,enabled?'CHECKOUT_CONFIGURATION_VERIFIED':'CHECKOUT_PREPARED_CONFIGURATION_VERIFIED');
  assert.equal(r.phase,phase);assert.equal(r.configurationAccepted,true);assert.equal(r.actualIntakeVerified,true);
  assert.equal(r.actualCheckoutEnabled,enabled);assert.equal(r.actualOwnerAllowed,enabled);assert.equal(r.foreignTesterDenied,true);
  assert.equal(r.soleTesterVerified,true);assert.equal(r.approvedOwnerMatches,true);assert.equal(r.providerConfigurationDisabled,true);
  assert.equal(r.checkoutConfigurationAccepted,true);assert.equal(r.requests,2);assert.equal(r.databaseRequests,0);assert.equal(r.authRequests,0);
  assert.deepEqual(f.calls,['/v1/webhooks?count=100&skip=0','/v1/webhooks/'+hookId]);
  assert.equal(r.financialRequests,0);assert.equal(r.mutations,0);assert.equal(r.signerMatch,'UNVERIFIED');assert.equal(r.signedDelivery,'UNVERIFIED');
  assert.equal(r.financialClearance,'NOT_GRANTED');assert.equal(r.activationAuthorized,false);assert.equal(JSON.stringify(input),before);
  for(const value of [owner,hookId,base.RAZORPAY_TEST_KEY_ID,base.RAZORPAY_TEST_KEY_SECRET,base.RAZORPAY_TEST_WEBHOOK_SECRET,base.RAZORPAY_TEST_ACCOUNT_ID])assert.equal(JSON.stringify(r).includes(value),false);
 });
 test(phase+' refuses the opposite actual phase without rewriting flags',async()=>{
  const f=fetcher(),r=await audit(env(!enabled),f.request,options);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
 });
 test(phase+' refuses wrong gates, project, provider security and tester pins before any request',async()=>{
  for(const change of [
   {CLUERA_BILLING_V2_ENABLED:'false'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'},
   {SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true'},{CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false'},
   {RAZORPAY_ENVIRONMENT:'live'},{NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co'},
   {CLUERA_PROVIDER_VAULT_ENABLED:'true'},{CLUERA_AI_BOOTSTRAP_MODE:'vault'},{CLUERA_PROVIDER_VAULT_KEYRING_BASE64:'synthetic-not-activated'},
   {SIGMAROUND_PAYMENT_TESTER_IDS:''},{SIGMAROUND_PAYMENT_TESTER_IDS:owner+','+owner},
   {SIGMAROUND_PAYMENT_TESTER_IDS:'10000000-0000-4000-8000-000000000801'},{SIGMAROUND_PAYMENT_TESTER_IDS:'*'},
  ]){
   const input={...env(enabled),...change},before=JSON.stringify(input),f=fetcher(),r=await auditInventory(input,f.request,options);
   assert.equal(r.stopped,'CONFIGURATION');assert.equal(r.financialRequests,0);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(input),before);
  }
 });
 test(phase+' exact options and actual own descriptors cannot be substituted by getters',async()=>{
  let calls=0;const getter=Object.defineProperty({...options},'expectedOwnerUuid',{get(){calls++;return owner;}});
  for(const invalid of [{expectedSourceSha:sha,expectedWebhookId:hookId},{...options,phase:'enabled'},getter]){
   const f=fetcher(),r=await audit(env(enabled),f.request,invalid);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
  }
  for(const key of ['SIGMAROUND_PAYMENT_TESTER_IDS','CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED','CLUERA_PROVIDER_VAULT_KEYRING_BASE64']){
   const input=Object.defineProperty(env(enabled),key,{get(){calls++;return key==='SIGMAROUND_PAYMENT_TESTER_IDS'?owner:'';}});
   const f=fetcher(),r=await audit(input,f.request,options);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
  }assert.equal(calls,0);
 });
 test(phase+' wrong operator ID or noncanonical/parallel/foreign/inactive webhook permits zero financial reads',async()=>{
  const wrong=fetcher(),id=await auditInventory(env(enabled),wrong.request,{...options,expectedWebhookId:'webhook_different123'});
  assert.equal(id.financialRequests,0);assert.deepEqual(wrong.calls,['/v1/webhooks?count=100&skip=0']);
  for(const hooks of [
   [{...hook,url:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook'}],
   [hook,{...hook,id:'webhook_parallel123',url:'https://foreign.invalid/webhook'}],
   [{...hook,owner_id:'foreign123456'}],[{...hook,active:'true'}],
  ]){
   const f=fetcher(hooks,hooks[0]),r=await auditInventory(env(enabled),f.request,options);
   assert.equal(r.stopped,'MERCHANT_REVIEW_REQUIRED');assert.equal(r.financialRequests,0);assert.ok(f.calls.every(path=>path.startsWith('/v1/webhooks')));
  }
 });
 test(phase+' bounded inventory retains strict null-paid warning and unchanged six-line redaction schema',async()=>{
  const privateText='DO_NOT_ECHO_PRIVATE_NOTES',order={id:'order_synthetic1',entity:'order',status:'attempted',amount:54900,
   amount_paid:null,amount_due:54900,currency:'INR',notes:{privateText}};
  const f=fetcher([hook],hook,[order]),r=await auditInventory(env(enabled),f.request,options);
  assert.equal(r.stopped,'READ_ONLY_INVENTORY_COMPLETE');assert.equal(r.financialRequests,4);assert.equal(r.requests,6);assert.equal(r.needsReview,true);
  assert.equal(r.collections.orders.validationFacts.paidNonNumeric,1);assert.equal(r.collections.orders.validationFacts.dueEquationMismatch,0);
  assert.equal(r.collections.orders.amounts.complete,false);assert.deepEqual(r.collections.orders.warnings,['INCONSISTENT_ORDER','NONEMPTY_HISTORY']);
  assert.equal(r.financialClearance,'NOT_GRANTED');assert.equal(r.signedDeliveryVerified,false);assert.equal(r.activationAuthorized,false);
  const lines=inventory.serializeReport(r);assert.equal(lines.length,6);
  for(const line of lines){assert.ok(Buffer.byteLength(line)<=1900);assert.equal(/[\r\n]/.test(line),false);}
  for(const value of [owner,hookId,order.id,privateText,base.RAZORPAY_TEST_KEY_SECRET,base.RAZORPAY_TEST_WEBHOOK_SECRET])assert.equal(lines.join('\n').includes(value),false);
 });
}

test('existing OFF and receiver APIs cannot select prepared/enabled phases through extra arguments',async()=>{
 for(const enabled of [false,true])for(const [audit,opts] of [
  [readiness.audit,{expectedSourceSha:sha}],[readiness.auditReceiver,{expectedSourceSha:sha,expectedWebhookId:hookId}],
  [inventory.audit,{expectedSourceSha:sha}],[inventory.auditReceiverInventory,{expectedSourceSha:sha,expectedWebhookId:hookId}],
 ] as const){
  const f=fetcher(),r=await audit(env(enabled),f.request,opts,()=>0,true,'enabled');assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
 }
});
