import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
const {audit}=createRequire(import.meta.url)('../../scripts/payments/audit-cluera-checkout-db.cjs');
const SHA='a'.repeat(40),REV='00000000-0000-4000-8000-000000000901',DB='https://yhnqlfcgrmckhyjdxegg.supabase.co';
const options=(phase='prepared')=>({expectedSourceSha:SHA,phase,expectedRevisionId:REV});
function environment(phase='prepared',patch:Record<string,string|undefined>={}){return {...paymentTestEnvironment,NODE_ENV:'production',
 CLUERA_BILLING_V2_ENABLED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:phase==='enabled'?'true':'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:phase==='enabled'?'false':'true',
 CLUERA_PROVIDER_VAULT_ENABLED:'false',CLUERA_AI_BOOTSTRAP_MODE:'auth-only',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',
 VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:SHA,
 NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_test_key_00000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_db_proof_key_000000000',
 SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,8).toString('base64'),...patch};}
function catalog(){return [['cluera_pack_3h_v2',54900,10800],['cluera_monthly_40h_v2',549900,144000],['cluera_monthly_100h_v2',959900,360000],['cluera_monthly_200h_v2',1954900,720000]].map(([offerCode,amountPaise,allowanceSeconds],index)=>({
 revisionId:index===0?REV:`00000000-0000-4000-8000-00000000090${index+1}`,offerCode,name:'Synthetic fixed catalog',amountPaise,allowanceSeconds,
 currency:'INR',kind:index===0?'PACK':'RECURRING',interval:index===0?null:'MONTH',razorpayPlanId:null,totalCount:index===0?null:120,
 enabled:index===0,version:1,testPlanValidated:index===0}));}
function fixture(rows=catalog(),unbound=false){return vi.fn(async(url:string,init:RequestInit)=>{
 expect([DB+'/rest/v1/rpc/cluera_billing_owner',DB+'/rest/v1/rpc/cluera_billing_catalog']).toContain(url);
 expect(init).toMatchObject({method:'POST',redirect:'error',credentials:'omit',cache:'no-store'});
 const headers=new Headers(init.headers);expect(headers.get('apikey')).toBe(environment().SUPABASE_SERVICE_ROLE_KEY);
 expect(headers.get('authorization')).toBe(`Bearer ${environment().SUPABASE_SERVICE_ROLE_KEY}`);
 if(url.endsWith('/cluera_billing_catalog')){expect(init.body).toBe('{}');return Response.json(rows);}
 const digest=createHash('sha256').update(`razorpay:test:${environment().RAZORPAY_TEST_ACCOUNT_ID}:${environment().RAZORPAY_TEST_KEY_ID}`).digest('hex');
 return Response.json(unbound||JSON.parse(String(init.body)).p_account_digest===digest?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'});
});}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it.each(['prepared','enabled'])('uses actual per-request SDK and two owner reads plus catalog only (%s)',async phase=>{
 const env=environment(phase),before={...env},globalFetch=globalThis.fetch,request=fixture(),result=await audit(env,request,options(phase));
 expect(result).toMatchObject({phase,stopped:'READ_ONLY_DB_PROOF_COMPLETE',configurationAccepted:true,actualClientFactoryLoaded:true,
  modernServiceKeyAuthenticated:true,merchantPinVerified:true,ownerEpochVerified:true,packPolicyVerified:true,monthlyDisabledVerified:true,
  soleTesterShapeVerified:true,requests:3,databaseReads:3,blockedRequests:0,authRequests:0,providerRequests:0,financialRequests:0,mutations:0,
  activationAuthorized:false,financialClearance:'NOT_GRANTED',fullTreeAttested:false});
 expect(request).toHaveBeenCalledTimes(3);expect(globalThis.fetch).toBe(globalFetch);expect(globalFetch).not.toHaveBeenCalled();expect(env).toEqual(before);
 for(const value of [REV,env.SUPABASE_SERVICE_ROLE_KEY,env.RAZORPAY_TEST_KEY_SECRET,env.RAZORPAY_TEST_ACCOUNT_ID,env.SIGMAROUND_PAYMENT_TESTER_IDS])expect(JSON.stringify(result)).not.toContain(value);
});
it.each([{CLUERA_BILLING_V2_ENABLED:'false'},{CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'},
 {SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'},{SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{CLUERA_PROVIDER_VAULT_ENABLED:'true'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)}])('rejects mismatched actual flags/target before SDK fetch %j',async patch=>{
 const request=fixture(),result=await audit(environment('prepared',patch),request,options());expect(result.stopped).toBe('CONFIGURATION');expect(result.requests).toBe(0);expect(request).not.toHaveBeenCalled();
});
it('rejects an unbound merchant before catalog or any other RPC',async()=>{
 const request=fixture(catalog(),true),result=await audit(environment(),request,options());
 expect(result).toMatchObject({stopped:'OWNER_READ',merchantPinVerified:false,requests:2,databaseReads:2,mutations:0});expect(request).toHaveBeenCalledTimes(2);
});
it.each([{amountPaise:1},{allowanceSeconds:1},{version:2},{enabled:false},{interval:'MONTH'},{revisionId:'00000000-0000-4000-8000-000000000999'}])
('never accepts wrong pack policy/revision %j',async patch=>{
 const rows=catalog();Object.assign(rows[0],patch);const result=await audit(environment(),fixture(rows),options());
 expect(result).toMatchObject({stopped:'CATALOG_READ',packPolicyVerified:false,requests:3,mutations:0});
});
it('rejects an enabled monthly plan and never treats it as pack readiness',async()=>{
 const rows=catalog();rows[1].enabled=true;expect(await audit(environment(),fixture(rows),options())).toMatchObject({stopped:'CATALOG_READ',monthlyDisabledVerified:false,mutations:0});
});
it('requires the actual pack validation readiness used by the buy control',async()=>{
 const rows=catalog();rows[0].testPlanValidated=false;
 expect(await audit(environment(),fixture(rows),options())).toMatchObject({stopped:'CATALOG_READ',packPolicyVerified:false,mutations:0});
});
it('permits process.env-style prototypes but ignores inherited properties and rejects own accessors',async()=>{
 const input=Object.assign(Object.create(Object.create(null)),environment());expect((await audit(input,fixture(),options())).stopped).toBe('READ_ONLY_DB_PROOF_COMPLETE');
 const getter=vi.fn(()=>environment().SUPABASE_SERVICE_ROLE_KEY),bad=environment();Object.defineProperty(bad,'SUPABASE_SERVICE_ROLE_KEY',{get:getter});
 const request=fixture();expect((await audit(bad,request,options())).stopped).toBe('CONFIGURATION');expect(getter).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
it('bounds a nonresponsive SDK transport without fallback/retry or credential reflection',async()=>{
 vi.useFakeTimers();const request=vi.fn((_url:string,_init:RequestInit)=>new Promise<Response>(()=>{}));
 const pending=audit(environment(),request,options());await vi.advanceTimersByTimeAsync(10000);const result=await pending;
 expect(result).toMatchObject({stopped:'OWNER_READ',merchantPinVerified:false,requests:1,mutations:0});expect(request).toHaveBeenCalledOnce();
 expect(request.mock.calls[0][1].signal?.aborted).toBe(true);expect(JSON.stringify(result)).not.toContain(environment().SUPABASE_SERVICE_ROLE_KEY);
});
