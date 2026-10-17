import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
const {audit,auditMerchantPinEvidence,auditReceiver}=createRequire(import.meta.url)('../../scripts/payments/audit-cluera-test-readiness.cjs');
const sha='a'.repeat(40),expectedId='SyntheticWebhook0001';
const options={expectedSourceSha:sha,expectedWebhookId:expectedId},offOptions={expectedSourceSha:sha};
const receiverEnv={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',
 CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false',
 VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',
 VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:sha};
const financialFlags=['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED',
 'SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED'];
const canonical='https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook';
const hook={id:expectedId,url:canonical,service:'api-test',owner_type:'merchant',owner_id:paymentTestEnvironment.RAZORPAY_TEST_ACCOUNT_ID,
 active:true,disabled_at:1234567890,secret_exists:true,events:['payment.captured','order.paid','refund.processed']};
function fixture(listed:Record<string,unknown>|Record<string,unknown>[]=hook,direct?:Record<string,unknown>){
 const calls:{url:string;init:RequestInit}[]=[];
 const request=async(raw:string,init:RequestInit)=>{
  calls.push({url:raw,init});const url=new URL(raw);
  expect(url.origin).toBe('https://api.razorpay.com');expect(init.method).toBe('GET');expect(init.body).toBeUndefined();
  expect(init.redirect).toBe('error');expect(init.credentials).toBe('omit');expect(init.cache).toBe('no-store');
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect((init.headers as Record<string,string>).Authorization).toBe('Basic '+Buffer.from(receiverEnv.RAZORPAY_TEST_KEY_ID+':'+receiverEnv.RAZORPAY_TEST_KEY_SECRET).toString('base64'));
  if(url.pathname==='/v1/webhooks'){
   expect(url.search).toBe('?count=100&skip=0');const rows=Array.isArray(listed)?listed:[listed];
   return Response.json({entity:'collection',count:rows.length,items:rows});
  }
  expect(url.pathname).toBe('/v1/webhooks/'+expectedId);expect(url.search).toBe('');return Response.json(direct??listed);
 };
 return {calls,request};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');})));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('reads actual receiver-only configuration and exact operator-selected Test destination, not signer equality or delivery',async()=>{
 const f=fixture(),before=JSON.stringify(receiverEnv),r=await auditReceiver(receiverEnv,f.request,options);
 expect(r.stopped).toBe('RECEIVER_CONFIGURATION_VERIFIED');
 expect(r).toMatchObject({configurationAccepted:true,actualIntakeVerified:true,actualCheckoutDisabledVerified:true,
  merchantVerified:true,operatorIdMatches:true,receiverConfigurationAccepted:true,requests:2,financialRequests:0,mutations:0,
  signerMatch:'UNVERIFIED',signedDelivery:'UNVERIFIED',financialClearance:'NOT_GRANTED',activationAuthorized:false,
  fullTreeAttested:false,externalDeploymentVerificationRequired:true});
 expect(r.destinations).toEqual({oldAccount:0,clueraLegacy:0,clueraV2:1});
 expect(r.canonical.listing.active).toEqual({type:'boolean',value:true});
 expect(r.canonical.listing.disabledAt).toEqual({type:'number',zero:false});
 expect(r.canonical.direct.events).toEqual({valid:true,enabledCount:3,profile:'exact-pack'});
 expect(f.calls).toHaveLength(2);expect(JSON.stringify(receiverEnv)).toBe(before);expect(fetch).not.toHaveBeenCalled();
 const output='CLUERA_TEST_RECEIVER '+JSON.stringify(r);expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1900);
 for(const value of [expectedId,receiverEnv.RAZORPAY_TEST_KEY_ID,receiverEnv.RAZORPAY_TEST_KEY_SECRET,
  receiverEnv.RAZORPAY_TEST_WEBHOOK_SECRET,receiverEnv.RAZORPAY_TEST_ACCOUNT_ID,'merchantDigest','reportDigest'])expect(output).not.toContain(value);
});
it('keeps OFF audit and merchant-pin evidence OFF-only; extra caller arguments cannot choose receiver mode',async()=>{
 const f=fixture();expect((await audit(receiverEnv,f.request,offOptions,()=>1,expectedId)).stopped).toBe('CONFIGURATION');
 const pin=await auditMerchantPinEvidence(receiverEnv,f.request,offOptions);expect(pin.merchantMatches).toBe(false);expect(pin.requests).toBe(0);
 expect(f.calls).toHaveLength(0);
 const offEnv={...receiverEnv,...Object.fromEntries(financialFlags.map(key=>[key,'false']))},before=JSON.stringify(offEnv);
 const off=fixture();expect((await audit(offEnv,off.request,offOptions)).stopped).toBe('READ_ONLY_REVIEW_COMPLETE');
 expect(off.calls).toHaveLength(2);expect(JSON.stringify(offEnv)).toBe(before);
 const refused=fixture();expect((await auditReceiver(offEnv,refused.request,options)).receiverConfigurationAccepted).toBe(false);
 expect(refused.calls).toHaveLength(0);expect(JSON.stringify(offEnv)).toBe(before);
});
it.each([
 {CLUERA_BILLING_V2_ENABLED:'false'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'},
 {SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'},{SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true'},
 {SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true'},
 {RAZORPAY_ENVIRONMENT:'live'},{NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},
 {SIGMAROUND_ACCOUNT_ORIGIN:'https://sigmaround-account-staging.vercel.app'},{VERCEL_ENV:'preview'},
 {VERCEL_PROJECT_ID:'foreign'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)},
])('rejects wrong ACTUAL phase/target before any GET, never rewriting it (%j)',async patch=>{
 const input={...receiverEnv,...patch},before=JSON.stringify(input),f=fixture(),r=await auditReceiver(input,f.request,options);
 expect(r.stopped).toBe('CONFIGURATION');expect(r.receiverConfigurationAccepted).toBe(false);expect(f.calls).toHaveLength(0);
 expect(JSON.stringify(input)).toBe(before);
});
it('requires explicit false external transport and strict operator option descriptors',async()=>{
 const missing:Record<string,string>={...receiverEnv};delete missing.CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED;
 const f=fixture();expect((await auditReceiver(missing,f.request,options)).stopped).toBe('CONFIGURATION');
 for(const bad of [{expectedSourceSha:sha},{...options,extra:'private'},{...options,expectedSourceSha:'short'},{...options,expectedWebhookId:'x?arbitrary=1'}])
  expect((await auditReceiver(receiverEnv,f.request,bad)).stopped).toBe('CONFIGURATION');
 const getter=vi.fn(()=>expectedId),bad={...options};Object.defineProperty(bad,'expectedWebhookId',{get:getter});
 expect((await auditReceiver(receiverEnv,f.request,bad)).stopped).toBe('CONFIGURATION');expect(getter).not.toHaveBeenCalled();expect(f.calls).toHaveLength(0);
});
it('compares independent expected ID BEFORE any direct-resource GET',async()=>{
 const f=fixture(),r=await auditReceiver(receiverEnv,f.request,{...options,expectedWebhookId:'differentExpected01'});
 expect(r.stopped).toBe('RECEIVER_REVIEW_REQUIRED');expect(r.operatorIdMatches).toBe(false);expect(r.receiverConfigurationAccepted).toBe(false);
 expect(r.canonical.state).toBe('OPERATOR_ID_MISMATCH');expect(r.canonical.direct).toBeNull();expect(f.calls).toHaveLength(1);
});
it.each([{url:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook'},
 {url:'https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook'}])
 ('never substitutes an old/legacy destination for canonical V2 (%j)',async patch=>{
 const f=fixture({...hook,...patch}),r=await auditReceiver(receiverEnv,f.request,options);
 expect(r.stopped).toBe('RECEIVER_REVIEW_REQUIRED');expect(r.receiverConfigurationAccepted).toBe(false);
 expect(r.destinations.clueraV2).toBe(0);expect(r.canonical.state).toBe('MISSING');expect(f.calls).toHaveLength(1);
});
it.each([{active:false},{active:'true'},{active:1}])('requires raw TRUE boolean, not truthy activation (%j)',async patch=>{
 const f=fixture({...hook,...patch}),r=await auditReceiver(receiverEnv,f.request,options);
 expect(r.receiverConfigurationAccepted).toBe(false);expect(r.stopped).toBe('RECEIVER_REVIEW_REQUIRED');expect(f.calls).toHaveLength(2);
});
it.each([{events:['payment.captured','order.paid']},
 {events:[...hook.events,'subscription.charged']},{secret_exists:false},{owner_id:'acc_foreignmerchant01'},{service:'api-live'}])
 ('rejects wrong pack profile, absent signer, merchant or mode (%j)',async patch=>{
 const f=fixture({...hook,...patch}),r=await auditReceiver(receiverEnv,f.request,options);
 expect(r.receiverConfigurationAccepted).toBe(false);expect(r.signerMatch).toBe('UNVERIFIED');expect(r.signedDelivery).toBe('UNVERIFIED');
 expect(r.financialRequests).toBe(0);expect(r.mutations).toBe(0);
});
it('rejects direct identity drift and parallel destinations',async()=>{
 const changed=fixture(hook,{...hook,id:'differentResource01'}),r=await auditReceiver(receiverEnv,changed.request,options);
 expect(r.receiverConfigurationAccepted).toBe(false);expect(r.canonical.state).toBe('DIRECT_IDENTITY_REVIEW');
 const parallel=fixture([hook,{...hook,id:'parallelResource01',url:'https://unrelated.invalid/webhook'}],hook);
 const other=await auditReceiver(receiverEnv,parallel.request,options);expect(other.listing.otherDestinations).toBe(1);
 expect(other.receiverConfigurationAccepted).toBe(false);expect(parallel.calls).toHaveLength(2);
});
it('never reflects upstream bodies/errors and importing the CLI never runs it',async()=>{
 const privateBody='SYNTHETIC_PRIVATE_BODY',request=vi.fn(async()=>Response.json({privateBody},{status:401}));
 const result=await auditReceiver(receiverEnv,request,options);expect(result.stopped).toBe('WEBHOOK_LISTING_UNAVAILABLE');
 expect(JSON.stringify(result)).not.toContain(privateBody);expect(result.requests).toBe(1);expect(result.financialRequests).toBe(0);
 const source=readFileSync(new URL('../../scripts/payments/audit-cluera-test-receiver.cjs',import.meta.url),'utf8');
 expect(source).toContain('args.length===2');expect(source).toContain('process.exitCode=2');
 expect(source).not.toMatch(/writeFile|readFile|@supabase|createOrder|handleClueraBillingTick/);
 createRequire(import.meta.url)('../../scripts/payments/audit-cluera-test-receiver.cjs');expect(fetch).not.toHaveBeenCalled();
});
