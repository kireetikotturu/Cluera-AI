import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {RELAY_STATUS_URL,verifySchedulerProof} from '../../shared/billingDispatch';
const {audit}=createRequire(import.meta.url)('../../scripts/payments/audit-cluera-scheduler-status.cjs');
const KEY='synthetic-scheduler-status-secret-0123456789-abcdefghijklmnopqrstuvwxyz',SHA='a'.repeat(40);
const NOW=Date.UTC(2026,9,17,12,0,1),options={expectedSourceSha:SHA};
function environment(overrides:Record<string,string|undefined>={}){return {
 CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',
 SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',CLUERA_PROVIDER_VAULT_ENABLED:'false',
 CLUERA_AI_BOOTSTRAP_MODE:'auth-only',SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
 NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_BILLING_WORKER_SECRET:KEY,
 VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',
 VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',VERCEL_GIT_COMMIT_SHA:SHA,...overrides};}
const response=(status:number,body:string,headers:Record<string,string>={})=>new Response(body,{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const denied=()=>response(401,'{"error":"Unauthorized."}'),accepted=()=>response(200,'{"configured":true,"enabled":false}');
function fixture(){return vi.fn(async(_url:string,init:RequestInit)=>verifySchedulerProof('STATUS',{url:RELAY_STATUS_URL,method:init.method!,headers:new Headers(init.headers),body:Buffer.from(String(init.body))},KEY,NOW)?accepted():denied());}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real network');}));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
it('loads actual protocol and verifies exactly two STATUS POSTs with no processing',async()=>{
 const request=fixture(),result=await audit(environment(),request,options);
 expect(result).toMatchObject({configurationAccepted:true,actualProtocolLoaded:true,badProofRejected:true,sharedSecretMatched:true,relayDisabled:true,
  requests:2,activationAuthorized:false,processingEnabled:false,dispatchRequests:0,wakeRequests:0,databaseRequests:0,providerRequests:0,mutations:0,
  fullTreeAttested:false,externalDeploymentVerificationRequired:true,stopped:'STATUS_VERIFIED_PROCESSING_DISABLED'});
 expect(request).toHaveBeenCalledTimes(2);
 for(const [url,init]of request.mock.calls){expect(url).toBe(RELAY_STATUS_URL);expect(init).toMatchObject({method:'POST',body:'{}',redirect:'error',credentials:'omit',cache:'no-store'});
  expect(Object.keys(init.headers!)).toEqual(['Content-Type','x-cluera-scheduler-time','x-cluera-scheduler-nonce','x-cluera-scheduler-proof']);expect(init.signal?.aborted).toBe(true);}
 expect(JSON.stringify(result)).not.toContain(KEY);expect(vi.getTimerCount()).toBe(0);
});
it.each(['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED',
 'SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED'])('rejects ambiguous/enabled %s before network',async key=>{
 for(const value of ['true',undefined,'FALSE','0']){const request=fixture();expect((await audit(environment({[key]:value}),request,options)).stopped).toBe('CONFIGURATION');expect(request).not.toHaveBeenCalled();}
});
it.each([{SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false'},{CLUERA_PROVIDER_VAULT_ENABLED:'true'},{CLUERA_PROVIDER_VAULT_ENABLED:undefined},
 {CLUERA_PROVIDER_VAULT_KEYRING_BASE64:'synthetic'},{CLUERA_AI_BOOTSTRAP_MODE:'vault'},{SIGMAROUND_ACCOUNTS_ENABLED:'false'},
 {SIGMAROUND_ACCOUNT_ORIGIN:'https://other.invalid'},{NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co'},
 {SIGMAROUND_BILLING_WORKER_SECRET:''},{SIGMAROUND_BILLING_WORKER_SECRET:'short'},{SIGMAROUND_BILLING_WORKER_SECRET:'x'.repeat(257)},
 {SIGMAROUND_BILLING_WORKER_SECRET:KEY+'\n'},{VERCEL_ENV:'preview'},{VERCEL_TARGET_ENV:'preview'},
 {VERCEL_PROJECT_ID:'wrong'},{VERCEL_ORG_ID:'wrong'},{VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)}])('rejects unsafe context before any request %j',async override=>{
 const request=fixture();expect((await audit(environment(override),request,options)).stopped).toBe('CONFIGURATION');expect(request).not.toHaveBeenCalled();
});
it('rejects accessors without invoking them, and never reads unrelated credentials',async()=>{
 const input=environment(),getter=vi.fn(()=>KEY);Object.defineProperty(input,'SIGMAROUND_BILLING_WORKER_SECRET',{get:getter});
 const request=fixture();expect((await audit(input,request,options)).stopped).toBe('CONFIGURATION');expect(getter).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
 const safe=environment();for(const name of ['SUPABASE_SERVICE_ROLE_KEY','RAZORPAY_TEST_KEY_SECRET','SIGMAROUND_MANAGED_GEMINI_API_KEY'])Object.defineProperty(safe,name,{get(){throw Error('Unexpected credential read');}});
 expect((await audit(safe,fixture(),options)).sharedSecretMatched).toBe(true);
});
it.each([{}, {expectedSourceSha:'short'},{expectedSourceSha:'A'.repeat(40)},{expectedSourceSha:SHA,extra:true}])('requires one reviewed SHA %j',async option=>{
 const request=fixture();expect((await audit(environment(),request,option)).stopped).toBe('CONFIGURATION');expect(request).not.toHaveBeenCalled();
});
it('does not falsely attest absent optional platform pins',async()=>{
 const input:Record<string,string|undefined>=environment();
 for(const name of ['VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA','VERCEL_TARGET_ENV','CLUERA_AI_BOOTSTRAP_MODE'])delete input[name];
 expect(await audit(input,fixture(),options))
  .toMatchObject({sharedSecretMatched:true,fullTreeAttested:false,deploymentContext:'external-deployment-pin-required'});
});
it.each([accepted,()=>response(401,'{"error":"Unauthorized.","extra":true}'),()=>response(401,'{"error":"wrong"}')])('requires exact bad-proof denial before real proof',async first=>{
 const request=vi.fn(async(_url:string,_init:RequestInit)=>first());expect(await audit(environment(),request,options))
  .toMatchObject({badProofRejected:false,sharedSecretMatched:false,stopped:'BAD_PROOF_UNAVAILABLE',requests:1});expect(request).toHaveBeenCalledOnce();
});
it.each([()=>response(200,'{"configured":true,"enabled":true}'),()=>response(200,'{"configured":true,"enabled":false,"extra":true}'),
 ()=>response(200,'{"configured":false,"enabled":false}'),()=>response(200,'[]'),()=>response(200,'not-json'),
 ()=>response(200,'{}',{'Cache-Control':'public'}),()=>response(200,'{}',{'X-Content-Type-Options':'other'}),
 ()=>response(200,'{}',{'Content-Type':'text/plain'}),()=>response(200,'{}',{'Content-Length':'257'}),
 ()=>response(200,'{}',{'Content-Length':'-1'}),()=>response(200,'x'.repeat(257)),()=>response(302,'{}'),
 ()=>{const r=accepted();Object.defineProperty(r,'redirected',{value:true});return r;},
 ()=>{const r=accepted();Object.defineProperty(r,'url',{value:'https://other.invalid/'});return r;}])('rejects unsafe/enabled positive metadata',async second=>{
 const request=vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(second());expect(await audit(environment(),request,options))
  .toMatchObject({badProofRejected:true,sharedSecretMatched:false,relayDisabled:false,requests:2,stopped:'SIGNED_STATUS_UNAVAILABLE'});
 expect(request.mock.calls.every(([,init])=>init.signal.aborted)).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('aborts unread response on early header rejection with no retry',async()=>{
 const request=vi.fn(async(_url:string,_init:RequestInit)=>new Response(new ReadableStream<Uint8Array>({start(){}}),{status:401,headers:{'Content-Type':'text/plain'}}));
 expect(await audit(environment(),request,options)).toMatchObject({requests:1,stopped:'BAD_PROOF_UNAVAILABLE'});expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
});
it('bounds unresponsive request at eight seconds',async()=>{
 const request=vi.fn((_url:string,_init:RequestInit)=>new Promise<Response>(()=>{})),pending=audit(environment(),request,options);
 await vi.advanceTimersByTimeAsync(8000);expect(await pending).toMatchObject({requests:1,stopped:'BAD_PROOF_UNAVAILABLE'});expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][1].signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('bounds hanging positive body and redacts exceptions',async()=>{
 const hanging=response(200,'{}');Object.defineProperty(hanging,'body',{value:new ReadableStream<Uint8Array>({start(){}})});
 const request=vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(hanging),pending=audit(environment(),request,options);
 await vi.advanceTimersByTimeAsync(8000);expect(await pending).toMatchObject({requests:2,badProofRejected:true,sharedSecretMatched:false,stopped:'SIGNED_STATUS_UNAVAILABLE'});
 expect(JSON.stringify(await audit(environment(),vi.fn(async()=>{throw Error(KEY);}),options))).not.toContain(KEY);
});
it.each([()=>NaN,()=>Infinity])('rejects invalid monotonic time',async clock=>{
 const request=fixture();expect((await audit(environment(),request,options,clock)).stopped).toBe('DEADLINE');expect(request).not.toHaveBeenCalled();
});
it('rejects backwards or expired clocks before sending',async()=>{
 for(const times of [[10,9],[0,20001]]){const request=fixture(),clock=vi.fn(()=>times.shift()??20002);expect((await audit(environment(),request,options,clock)).requests).toBe(0);expect(request).not.toHaveBeenCalled();}
});
it('CLI always exits without artifact and imports no private files/SDK/worker',()=>{
 const source=readFileSync(new URL('../../scripts/payments/audit-cluera-scheduler-status.cjs',import.meta.url),'utf8');
 expect(source).toContain('process.exitCode=1');expect(source).toContain('args.length===1');expect(source).not.toMatch(/readFile|writeFile|@supabase|handleClueraBillingTick|schedulerHeaders\('(?:WAKE|DISPATCH)'/);
});
