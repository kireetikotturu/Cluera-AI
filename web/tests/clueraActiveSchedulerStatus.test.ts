import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {RELAY_STATUS_URL,verifySchedulerProof} from '../../shared/billingDispatch';
const require=createRequire(import.meta.url);
const {audit,auditActiveStatus}=require('../../scripts/payments/audit-cluera-scheduler-status.cjs');
const KEY='synthetic-active-status-secret-0123456789-abcdefghijklmnopqrstuvwxyz',SHA='a'.repeat(40);
const NOW=Date.UTC(2026,9,17,15,0,1),options=(enabled:boolean)=>({expectedSourceSha:SHA,expectedRelayEnabled:enabled});
function environment(overrides:Record<string,string|undefined>={}){return {
 CLUERA_BILLING_V2_ENABLED:'true',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',
 SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',CLUERA_PROVIDER_VAULT_ENABLED:'false',
 CLUERA_AI_BOOTSTRAP_MODE:'auth-only',SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
 NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_BILLING_WORKER_SECRET:KEY,
 VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',
 VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:SHA,...overrides};}
const response=(status:number,body:string,headers:Record<string,string>={})=>new Response(body,{status,headers:{
 'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const denied=()=>response(401,'{"error":"Unauthorized."}');
function fixture(enabled:boolean){return vi.fn(async(_url:string,init:RequestInit)=>verifySchedulerProof('STATUS',{
 url:RELAY_STATUS_URL,method:init.method!,headers:new Headers(init.headers),body:Buffer.from(String(init.body))},KEY,NOW)
 ?response(200,JSON.stringify({configured:true,enabled})):denied());}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real network');}));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

it.each([false,true])('checks actual active-web STATUS expected relay=%s without processing',async enabled=>{
 const env=environment(),before={...env},request=fixture(enabled),result=await auditActiveStatus(env,request,options(enabled));
 expect(result).toMatchObject({mode:'ACTIVE_METADATA_ONLY',diagnosticProcessingInvoked:false,expectedRelayEnabled:enabled,observedRelayEnabled:enabled,
  configurationAccepted:true,actualProtocolLoaded:true,badProofRejected:true,sharedSecretMatched:true,relayDisabled:!enabled,
  requests:2,processingEnabled:false,activationAuthorized:false,dispatchRequests:0,wakeRequests:0,databaseRequests:0,providerRequests:0,mutations:0,
  fullTreeAttested:false,externalDeploymentVerificationRequired:true,
  stopped:enabled?'ACTIVE_STATUS_VERIFIED_RELAY_ENABLED':'ACTIVE_STATUS_VERIFIED_RELAY_DISABLED'});
 expect(env).toEqual(before);expect(request).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();
 for(const [url,init]of request.mock.calls){expect(url).toBe(RELAY_STATUS_URL);expect(init).toMatchObject({method:'POST',body:'{}',redirect:'error',credentials:'omit',cache:'no-store'});
  expect(Object.keys(init.headers!)).toEqual(['Content-Type','x-cluera-scheduler-time','x-cluera-scheduler-nonce','x-cluera-scheduler-proof']);expect(init.signal?.aborted).toBe(true);}
 const text=JSON.stringify(result);expect(text).not.toContain(KEY);
 for(const [,init]of request.mock.calls)for(const value of Object.values(init.headers!))expect(text).not.toContain(value);
 expect(vi.getTimerCount()).toBe(0);
});
it.each(['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED'])
('requires literal enabled %s without rewriting OFF configuration',async key=>{
 for(const value of ['false',undefined,'TRUE','1']){const env=environment({[key]:value}),before={...env},request=fixture(false);
  expect((await auditActiveStatus(env,request,options(false))).stopped).toBe('CONFIGURATION');expect(env).toEqual(before);expect(request).not.toHaveBeenCalled();}
});
it.each([{SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'},{SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true'},
 {SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{CLUERA_PROVIDER_VAULT_ENABLED:'true'},{CLUERA_PROVIDER_VAULT_ENABLED:undefined},
 {CLUERA_PROVIDER_VAULT_KEYRING_BASE64:'SYNTHETIC_PRIVATE'},{CLUERA_AI_BOOTSTRAP_MODE:'admin-vault'},{CLUERA_AI_BOOTSTRAP_MODE:undefined},
 {SIGMAROUND_ACCOUNTS_ENABLED:'false'},{SIGMAROUND_ACCOUNT_ORIGIN:'https://other.invalid'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},{SIGMAROUND_BILLING_WORKER_SECRET:'short'},
 {VERCEL_ENV:'preview'},{VERCEL_PROJECT_ID:'wrong'},{VERCEL_ORG_ID:'wrong'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)}])
('rejects unsafe actual context before STATUS %j',async patch=>{
 const request=fixture(false),result=await auditActiveStatus(environment(patch),request,options(false));
 expect(result).toMatchObject({stopped:'CONFIGURATION',sharedSecretMatched:false,requests:0,activationAuthorized:false});expect(request).not.toHaveBeenCalled();
 expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
});
it.each([{}, {expectedSourceSha:SHA},{expectedSourceSha:SHA,expectedRelayEnabled:'false'},
 {expectedSourceSha:'bad',expectedRelayEnabled:false},{...options(false),extra:'SYNTHETIC_PRIVATE'}])
('requires exactly SHA and boolean expected state %j',async supplied=>{
 const request=fixture(false),result=await auditActiveStatus(environment(),request,supplied);
 expect(result).toMatchObject({mode:'ACTIVE_METADATA_ONLY',expectedRelayEnabled:null,observedRelayEnabled:null,stopped:'CONFIGURATION',requests:0});
 expect(request).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
});
it('rejects option/environment accessors without reading unrelated credentials',async()=>{
 const getter=vi.fn(()=>false),supplied={...options(false)};Object.defineProperty(supplied,'expectedRelayEnabled',{get:getter});
 const request=fixture(false);expect((await auditActiveStatus(environment(),request,supplied)).stopped).toBe('CONFIGURATION');expect(getter).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
 const input=environment();Object.defineProperty(input,'SIGMAROUND_BILLING_WORKER_SECRET',{get:getter});
 expect((await auditActiveStatus(input,request,options(false))).stopped).toBe('CONFIGURATION');expect(getter).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
 const safe=environment();for(const name of ['SUPABASE_SERVICE_ROLE_KEY','RAZORPAY_TEST_KEY_SECRET','SIGMAROUND_MANAGED_GEMINI_API_KEY'])
  Object.defineProperty(safe,name,{get(){throw Error('Unexpected credential read');}});
 expect((await auditActiveStatus(safe,fixture(false),options(false))).sharedSecretMatched).toBe(true);
});
it('uses selected descriptors without invoking Proxy get or rereading caller state',async()=>{
 const get=vi.fn(()=>{throw Error(KEY);}),supplied=new Proxy(options(false),{get});
 expect(await auditActiveStatus(environment(),fixture(false),supplied)).toMatchObject({sharedSecretMatched:true,expectedRelayEnabled:false,
  observedRelayEnabled:false,diagnosticProcessingInvoked:false,requests:2});expect(get).not.toHaveBeenCalled();
});
it.each([false,true])('rejects unexpected relay state expected=%s',async enabled=>{
 const result=await auditActiveStatus(environment(),fixture(!enabled),options(enabled));
 expect(result).toMatchObject({expectedRelayEnabled:enabled,observedRelayEnabled:!enabled,badProofRejected:true,sharedSecretMatched:false,
  stopped:'SIGNED_STATUS_UNAVAILABLE',requests:2,activationAuthorized:false,dispatchRequests:0,wakeRequests:0,databaseRequests:0,providerRequests:0,mutations:0});
});
it('keeps original audit OFF-only, ignoring a sixth argument',async()=>{
 const request=fixture(false);expect((await audit(environment(),request,{expectedSourceSha:SHA},()=>0,()=>NOW,true)).stopped).toBe('CONFIGURATION');expect(request).not.toHaveBeenCalled();
 const off=environment({CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false'});
 const result=await audit(off,fixture(true),{expectedSourceSha:SHA},()=>0,()=>NOW,true);
 expect(result).toMatchObject({stopped:'SIGNED_STATUS_UNAVAILABLE',sharedSecretMatched:false,requests:2});expect(result.mode).toBeUndefined();
});
it('keeps external deployment attestation when optional system pins are absent',async()=>{
 const env:Record<string,string|undefined>=environment();for(const name of ['VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA','VERCEL_TARGET_ENV'])delete env[name];
 expect(await auditActiveStatus(env,fixture(false),options(false))).toMatchObject({sharedSecretMatched:true,fullTreeAttested:false,
  externalDeploymentVerificationRequired:true,deploymentContext:'external-deployment-pin-required'});
});
it('requires exact corrupted-proof rejection before the genuine STATUS proof',async()=>{
 const request=vi.fn(async()=>response(401,JSON.stringify({error:KEY})));
 const result=await auditActiveStatus(environment(),request,options(false));expect(result).toMatchObject({stopped:'BAD_PROOF_UNAVAILABLE',requests:1,badProofRejected:false});
 expect(JSON.stringify(result)).not.toContain(KEY);expect(request).toHaveBeenCalledOnce();
});
it.each(['{"configured":true,"enabled":false,"private":"SYNTHETIC_PRIVATE"}','{"configured":true,"enabled":"false"}','{"configured":false,"enabled":false}','SYNTHETIC_PRIVATE'])
('refuses malformed positive metadata without reflection %s',async body=>{
 const request=vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(response(200,body));
 const result=await auditActiveStatus(environment(),request,options(false));expect(result).toMatchObject({stopped:'SIGNED_STATUS_UNAVAILABLE',requests:2,sharedSecretMatched:false});
 expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');expect(request).toHaveBeenCalledTimes(2);
});
it('bounds unresponsive STATUS at the unchanged8s deadline',async()=>{
 const request=vi.fn((_url:string,_init:RequestInit)=>new Promise<Response>(()=>{})),pending=auditActiveStatus(environment(),request,options(false));
 await vi.advanceTimersByTimeAsync(8000);expect(await pending).toMatchObject({stopped:'BAD_PROOF_UNAVAILABLE',requests:1,dispatchRequests:0,wakeRequests:0});
 expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][1].signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('bounds unresponsive positive body/cancel without retries or secret echo',async()=>{
 const never=()=>new Promise<never>(()=>{}),hanging=response(200,'{}');
 Object.defineProperty(hanging,'body',{value:new ReadableStream<Uint8Array>({pull:never,cancel:never})});
 const request=vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(hanging),pending=auditActiveStatus(environment(),request,options(true));
 await vi.advanceTimersByTimeAsync(8000);expect(await pending).toMatchObject({stopped:'SIGNED_STATUS_UNAVAILABLE',requests:2,sharedSecretMatched:false});
 expect(request).toHaveBeenCalledTimes(2);expect(request.mock.calls.every(([,init])=>init.signal.aborted)).toBe(true);expect(vi.getTimerCount()).toBe(0);
 expect(JSON.stringify(await auditActiveStatus(environment(),vi.fn(async()=>{throw Error(KEY);}),options(false)))).not.toContain(KEY);
});
it('CLI requires explicit SHA/boolean and exits without artifact or runtime import',()=>{
 const source=readFileSync(new URL('../../scripts/payments/audit-cluera-active-scheduler-status.cjs',import.meta.url),'utf8');
 expect(source).toContain('args.length===2');expect(source).toContain("['false','true'].includes(args[1])");expect(source).toContain('process.exitCode=1');
 expect(source).not.toMatch(/readFile|writeFile|@supabase|handleClueraBillingTick|schedulerHeaders\('(?:WAKE|DISPATCH)'/);
 require('../../scripts/payments/audit-cluera-active-scheduler-status.cjs');expect(fetch).not.toHaveBeenCalled();
});
