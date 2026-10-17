import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
const require=createRequire(import.meta.url);
const {audit,auditMerchantPinEvidence,merchantPinEvidenceLine}=require('../../scripts/payments/audit-cluera-test-readiness.cjs');
const SHA='a'.repeat(40),options={expectedSourceSha:SHA},NOW=Date.UTC(2026,9,17,14,0),PROJECT='yhnqlfcgrmckhyjdxegg',ID='SyntheticWebhook0001';
const OLD='https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook',NEW='https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook';
function environment(overrides:Record<string,string|undefined>={}){return {...paymentTestEnvironment,VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
 VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:SHA,
 CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',
 SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',...overrides};}
const row=(patch:Record<string,unknown>={})=>({id:ID,url:OLD,owner_type:'merchant',owner_id:paymentTestEnvironment.RAZORPAY_TEST_ACCOUNT_ID,
 service:'api-test',active:true,disabled_at:123,events:['payment.captured','order.paid','refund.processed'],secret_exists:true,
 secret:'SYNTHETIC_UPSTREAM_SECRET_NEVER_REFLECT',private_body:'SYNTHETIC_RAW_BODY_NEVER_REFLECT',...patch});
function fixture(rows=[row()],direct?:Record<string,unknown>){return vi.fn(async(url:string,init:RequestInit)=>{
 expect(new URL(url).origin).toBe('https://api.razorpay.com');expect(new URL(url).pathname.startsWith('/v1/webhooks')).toBe(true);
 expect(init).toMatchObject({method:'GET',redirect:'error',credentials:'omit',cache:'no-store'});expect(init.body).toBeUndefined();
 if(new URL(url).pathname==='/v1/webhooks')return Response.json({entity:'collection',count:rows.length,items:rows});
 return Response.json(direct??rows.find(value=>'/v1/webhooks/'+value.id===new URL(url).pathname));
});}
const digest=(env:ReturnType<typeof environment>)=>createHash('sha256').update(`razorpay:test:${env.RAZORPAY_TEST_ACCOUNT_ID}:${env.RAZORPAY_TEST_KEY_ID}`).digest('hex');
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('actual guard and two GETs precede private fixed merchant correlation metadata',async()=>{
 const env=environment(),request=fixture(),result=await auditMerchantPinEvidence(env,request,options);
 expect(result).toEqual({projectRef:PROJECT,sourceCommit:SHA,observedAt:new Date(NOW).toISOString(),merchantDigest:digest(env),reportDigest:expect.stringMatching(/^[a-f0-9]{64}$/),
  testAuthentication:true,merchantMatches:true,configuredDigestMatches:true,testModeVerified:true,requests:2,mutations:0,activationAuthorized:false,financialClearance:'NOT_GRANTED'});
 expect(request).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();
 const report=await audit(env,fixture(),options);expect(result.reportDigest).toBe(createHash('sha256').update(JSON.stringify(report)).digest('hex'));
 const line=merchantPinEvidenceLine(result);expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1200);expect(JSON.parse(line.slice(line.indexOf(' ')+1))).toEqual(result);
 for(const value of [env.RAZORPAY_TEST_KEY_ID,env.RAZORPAY_TEST_ACCOUNT_ID,env.RAZORPAY_TEST_KEY_SECRET,env.RAZORPAY_TEST_WEBHOOK_SECRET,ID,OLD,NEW,row().secret,row().private_body,Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64')])expect(line).not.toContain(value);
});
it('snapshots caller configuration; API/webhook secrets do not determine identity digest',async()=>{
 const env=environment(),expected=digest(env),base=fixture();
 const request=vi.fn(async(url:string,init:RequestInit)=>{env.RAZORPAY_TEST_KEY_ID='rzp_test_mutatedsynthetic';return base(url,init);});
 expect((await auditMerchantPinEvidence(env,request,options)).merchantDigest).toBe(expected);
 const changed=environment({RAZORPAY_TEST_KEY_SECRET:'another-synthetic-secret-00000000',RAZORPAY_TEST_WEBHOOK_SECRET:'another-synthetic-webhook-secret-00000000'});
 expect((await auditMerchantPinEvidence(changed,fixture(),options)).merchantDigest).toBe(digest(environment()));
});
it.each([{CLUERA_BILLING_V2_ENABLED:'true'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true'},
 {SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{RAZORPAY_ENVIRONMENT:'live'},{NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)}])('unsafe configuration produces no request or digest %j',async patch=>{
 const request=fixture();expect(await auditMerchantPinEvidence(environment(patch),request,options)).toMatchObject({merchantDigest:null,reportDigest:null,merchantMatches:false,requests:0,mutations:0,activationAuthorized:false});expect(request).not.toHaveBeenCalled();
});
it.each([{}, {expectedSourceSha:'bad'},{expectedSourceSha:SHA,extra:'SYNTHETIC_PRIVATE'}])('requires one reviewed SHA %j',async supplied=>{
 const request=fixture();expect(await auditMerchantPinEvidence(environment(),request,supplied)).toMatchObject({sourceCommit:null,merchantDigest:null,reportDigest:null,requests:0});expect(request).not.toHaveBeenCalled();
});
it.each([{owner_id:'acc_foreignsynthetic'},{service:'api-live'},{owner_type:'partner'},{url:NEW+'/'}])('foreign/Live/missing literal identity cannot yield digest %j',async patch=>{
 expect(await auditMerchantPinEvidence(environment(),fixture([row(patch)]),options)).toMatchObject({merchantDigest:null,reportDigest:null,merchantMatches:false,configuredDigestMatches:false,testModeVerified:false});
});
it('requires consistent direct resource and unambiguous present destinations',async()=>{
 for(const request of [fixture([row()],row({active:false})),fixture([row(),row({id:'SyntheticWebhook0002'})]),fixture([row(),row({id:'SyntheticWebhook0002',url:NEW,owner_id:'acc_foreignsynthetic'})])])
  expect(await auditMerchantPinEvidence(environment(),request,options)).toMatchObject({merchantDigest:null,reportDigest:null,merchantMatches:false,activationAuthorized:false});
});
it('unavailable or incomplete evidence never reflects bodies or produces authority',async()=>{
 const records=Array.from({length:100},(_,i)=>row({id:'SyntheticPageWebhook'+i,url:'https://unrelated.invalid'}));
 for(const request of [vi.fn(async()=>Response.json({private:environment().RAZORPAY_TEST_KEY_SECRET},{status:401})),vi.fn(async()=>Response.json({entity:'collection',count:1,items:[]})),vi.fn(async()=>Response.json({entity:'collection',count:100,items:records})),vi.fn(async()=>{throw Error(environment().RAZORPAY_TEST_KEY_SECRET);})]){
  const result=await auditMerchantPinEvidence(environment(),request,options);expect(result.merchantDigest).toBeNull();expect(result.reportDigest).toBeNull();expect(merchantPinEvidenceLine(result)).not.toContain(environment().RAZORPAY_TEST_KEY_SECRET);
 }
});
it('bounded serializer rejects arbitrary fields/accessors without evaluating or reflecting them',async()=>{
 const good=await auditMerchantPinEvidence(environment(),fixture(),options),getter=vi.fn(()=>'SYNTHETIC_PRIVATE'),accessor={...good};Object.defineProperty(accessor,'merchantDigest',{get:getter});
 for(const bad of [{...good,raw:'SYNTHETIC_PRIVATE'},accessor,{...good,requests:1000},{...good,activationAuthorized:true},{...good,financialClearance:'GRANTED'},{...good,sourceCommit:'bad'},{...good,merchantDigest:'SYNTHETIC_PRIVATE'},null]){
  const line=merchantPinEvidenceLine(bad),value=JSON.parse(line.slice(line.indexOf(' ')+1));expect(value).toMatchObject({merchantDigest:null,reportDigest:null,activationAuthorized:false,financialClearance:'NOT_GRANTED'});expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1200);expect(line).not.toContain('SYNTHETIC_PRIVATE');
 }expect(getter).not.toHaveBeenCalled();
});
it('optional pins really absent remain absent after snapshot, while explicit undefined fails',async()=>{
 const input:Record<string,string|undefined>=environment();for(const k of ['VERCEL_GIT_COMMIT_SHA','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_TARGET_ENV'])delete input[k];
 expect((await auditMerchantPinEvidence(input,fixture(),options)).merchantMatches).toBe(true);
 input.VERCEL_PROJECT_ID=undefined;const request=fixture();expect((await auditMerchantPinEvidence(input,request,options)).merchantDigest).toBeNull();expect(request).not.toHaveBeenCalled();
});
it('never reads environment accessors or runs the CLI at import time',async()=>{
 const env=environment(),getter=vi.fn(()=>'SYNTHETIC_PRIVATE');Object.defineProperty(env,'RAZORPAY_TEST_ACCOUNT_ID',{get:getter});const request=fixture();
 expect((await auditMerchantPinEvidence(env,request,options)).merchantDigest).toBeNull();expect(request).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
 const source=readFileSync(new URL('../../scripts/payments/audit-cluera-test-merchant-pin.cjs',import.meta.url),'utf8');expect(source).toContain('args.length===1');expect(source).toContain('process.exitCode=2');expect(source).not.toMatch(/writeFile|readFile|@supabase|createOrder|cluera_billing_cutover|handleClueraBillingTick/);
 require('../../scripts/payments/audit-cluera-test-merchant-pin.cjs');expect(fetch).not.toHaveBeenCalled();
});
