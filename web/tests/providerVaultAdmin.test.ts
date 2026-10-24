import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {providerAdminRequest} from '../lib/aiProviders/admin';
import {vaultKeyring} from '../lib/aiProviders/vault';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn(),discover:vi.fn()}));
vi.mock('../lib/aiProviders/discovery',async original=>({...await original<typeof import('../lib/aiProviders/discovery')>(),discoverModels:mocks.discover}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,rateLimit:mocks.limit}));
const origin='https://cluera-ai-staging.vercel.app',actor='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002',factor='00000000-0000-4000-8000-000000000003';
const secret='synthetic-vault-provider-only-secret';
const env={CLUERA_PROVIDER_VAULT_KEYRING_BASE64:Buffer.from(JSON.stringify({active:'test-1',keys:{'test-1':Buffer.alloc(32,8).toString('base64')}})).toString('base64')};
let rpc:any,mfa:any,getUser:any,token:string;
const metadata=()=>({provider:'gemini',revision:1,credentialPresent:true,enabled:false,defaultModel:null,probeStatus:'UNVERIFIED',probeAt:null,models:[],complete:false,updatedAt:'2026-10-13T00:00:00Z'});
const body=()=>({action:'REPLACE',provider:'gemini',revision:0,operationId:crypto.randomUUID(),factorId:factor,code:'123456',apiKey:secret});
const request=(input?:object,headers:Record<string,string>={})=>new Request(`${origin}/api/account/admin/ai-providers`,input?{method:'POST',headers:{origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)}:{headers});
beforeEach(()=>{
 for(const [key,value] of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-infrastructure-service-key',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64'),CLUERA_PROVIDER_VAULT_ENABLED:'true',...env}))vi.stubEnv(key,value);
 token=`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:sid})).toString('base64url')}.synthetic`;
 mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:token,refresh_token:'synthetic-refresh'}});
 mocks.limit.mockResolvedValue(undefined);
 mfa={listFactors:vi.fn(async()=>({data:{all:[{id:factor,status:'verified',factor_type:'totp'}]},error:null})),challengeAndVerify:vi.fn(async()=>({data:{access_token:token,refresh_token:'synthetic-new-refresh',expires_in:3600},error:null}))};
 getUser=vi.fn(async()=>({data:{user:{id:actor,email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}},error:null}));
 rpc=vi.fn(async(name:string)=>({data:name==='account_admin_check'?true:name==='cluera_provider_admin_read'?{code:'ACTIVE',providers:[metadata()]}:name==='cluera_provider_mutate'?{code:'APPLIED',metadata:metadata()}:null,error:null}));
 mocks.clients.mockReturnValue({service:{rpc},auth:{auth:{setSession:vi.fn(async()=>({error:null})),getUser,mfa}}});
 vi.stubGlobal('fetch',vi.fn());
 mocks.discover.mockResolvedValue({status:'VERIFIED',models:[{id:'gemini-3.5-flash',runtimeCompatible:true}],complete:true});
});
const operationRequest=(query:string)=>new Request(`${origin}/api/account/admin/ai-providers?${query}`);
function retryFixture({applied=false,revision=1,mutation='APPLIED'}:{applied?:boolean;revision?:number;mutation?:string}={}){
 const input={action:'TEST',provider:'gemini',revision:1,operationId:crypto.randomUUID(),factorId:factor,code:'654321',retry:true};
 const credentialId=crypto.randomUUID(),sealed=vaultKeyring().seal(secret,{provider:'gemini',credentialId});
 let current={...metadata(),revision};
 rpc.mockImplementation(async(name:string,args:any)=>{
  if(name==='account_admin_check')return {data:true,error:null};
  if(name==='cluera_provider_admin_read')return {data:args.p_operation?(applied?{code:'APPLIED',provider:'gemini',metadata:{...metadata(),revision:2}}:{code:'NOT_FOUND'}):{code:'ACTIVE',providers:[current]},error:null};
  if(name==='cluera_provider_read')return {data:{provider:'gemini',revision:current.revision,credential_id:credentialId,sealed,enabled:false,default_model:null,probe_status:'UNVERIFIED',probe_at:null,models:[],complete:false,updated_at:current.updatedAt},error:null};
  if(name==='cluera_provider_mutate'){
   if(mutation==='APPLIED'){applied=true;current={...current,revision:2};}
   return {data:{code:mutation,...(applied?{metadata:current}:{})},error:null};
  }
  throw Error('Unexpected fixture RPC');
 });return input;
}
it('verifies through authenticated metadata-only reads and returns the latest provider revision',async()=>{
 const input=retryFixture({applied:true,revision:3});const response=await providerAdminRequest(operationRequest(`operation=${input.operationId}&provider=gemini&revision=1`));
 expect(response.status).toBe(200);expect(await response.json()).toEqual({code:'APPLIED',operationId:input.operationId,metadata:{...metadata(),revision:3}});
 expect(rpc.mock.calls.every(([name]:any)=>['account_admin_check','cluera_provider_admin_read'].includes(name))).toBe(true);expect(mfa.challengeAndVerify).not.toHaveBeenCalled();expect(mocks.discover).not.toHaveBeenCalled();
});
it('reports not-recorded separately and rejects malformed verification query contexts',async()=>{
 const input=retryFixture();expect(await (await providerAdminRequest(operationRequest(`operation=${input.operationId}`))).json()).toEqual({code:'NOT_RECORDED',operationId:input.operationId,metadata:null});
 for(const query of [`operation=${input.operationId}&provider=gemini`,`operation=${input.operationId}&provider=gemini&revision=-1`,`operation=${input.operationId}&operation=${input.operationId}`,`operation=${input.operationId}&factors=1`])expect((await providerAdminRequest(operationRequest(query))).status).toBe(400);
});
it.each(['FORBIDDEN','MALFORMED'])('distinguishes %s audit read failure without exposing raw data or changing state',async code=>{
 const input=retryFixture();rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:code==='FORBIDDEN'?{code}:{code:'APPLIED',metadata:{apiKey:secret}},error:null}));
 const response=await providerAdminRequest(operationRequest(`operation=${input.operationId}`));expect(response.status).toBe(code==='FORBIDDEN'?403:503);expect(JSON.stringify(await response.json())).not.toContain(secret);expect(mocks.discover).not.toHaveBeenCalled();
});
it('retries a missing metadata operation with fresh MFA and the original digest, applying at most once',async()=>{
 const input=retryFixture();const response=await providerAdminRequest(request(input));expect(response.status).toBe(200);expect((await response.json()).code).toBe('APPLIED');
 const mutation=rpc.mock.calls.find(([name]:any)=>name==='cluera_provider_mutate')![1];
 const original={operationId:input.operationId,provider:'gemini',revision:1,action:'TEST'};
 expect(mutation.p_operation).toBe(input.operationId);expect(mutation.p_digest).toBe(vaultKeyring().digest(JSON.stringify({actor,session:sid,...original})));
 expect(mutation.p_action).toBe('TEST');expect(mutation.p_input).not.toHaveProperty('enabled');expect(mutation.p_input).not.toHaveProperty('sealed');
 expect((await providerAdminRequest(request({...input,code:'987654'}))).status).toBe(200);
 expect(mfa.challengeAndVerify).toHaveBeenCalledTimes(2);expect(mocks.discover).toHaveBeenCalledOnce();expect(rpc.mock.calls.filter(([name]:any)=>name==='cluera_provider_mutate')).toHaveLength(1);
});
it.each(['applied','superseded'])('does not rediscover or mutate when retry finds the original %s',async state=>{
 const input=retryFixture({applied:state==='applied',revision:3});const response=await providerAdminRequest(request(input));expect(response.status).toBe(200);expect((await response.json()).code).toBe(state==='applied'?'APPLIED':'SUPERSEDED');
 expect(mfa.challengeAndVerify).toHaveBeenCalledOnce();expect(mocks.discover).not.toHaveBeenCalled();expect(rpc.mock.calls.some(([name]:any)=>name==='cluera_provider_read'||name==='cluera_provider_mutate')).toBe(false);
});
it('rejects retry before discovery when fresh authenticator approval fails',async()=>{
 const input=retryFixture();mfa.challengeAndVerify.mockResolvedValue({data:null,error:{message:secret}});expect((await providerAdminRequest(request(input))).status).toBe(403);expect(mocks.discover).not.toHaveBeenCalled();expect(rpc.mock.calls.every(([name]:any)=>name==='account_admin_check')).toBe(true);
});
it('never accepts a key replacement retry marker',async()=>{
 expect((await providerAdminRequest(request({...body(),retry:true}))).status).toBe(400);expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('returns a rejected settings retry without asserting the original can never commit',async()=>{
 const input=retryFixture({mutation:'INVALID'});const response=await providerAdminRequest(request({...input,action:'CONFIGURE',enabled:true,defaultModel:'gemini-3.5-flash',fallback:'NONE'}));
 expect(response.status).toBe(200);expect(await response.json()).toEqual({code:'REJECTED',operationId:input.operationId,metadata:metadata()});expect(mocks.discover).not.toHaveBeenCalled();
});
it('preserves uncertainty for an unexplained conflict with no audit or newer revision',async()=>{
 const input=retryFixture({mutation:'CONFLICT'});expect((await providerAdminRequest(request(input))).status).toBe(503);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
it('fails at missing infrastructure before any session, vault, MFA, SQL or provider action',async()=>{
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','');const r=await providerAdminRequest(request(body()));expect(r.status).toBe(503);expect(mocks.clients).not.toHaveBeenCalled();expect(mfa.challengeAndVerify).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it.each(['aal1','non-admin','foreign-origin','cross-site','step-up-denied','changed-owner','changed-session'])('rejects %s before encrypted mutation or provider calls',async failure=>{
 let req=request(body());
 if(failure==='aal1')mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1'})).toString('base64url')}.synthetic`}});
 if(failure==='non-admin')rpc.mockResolvedValue({data:false,error:null});
 if(failure==='foreign-origin')req=request(body(),{origin:'https://attacker.invalid'});
 if(failure==='cross-site')req=request(body(),{'sec-fetch-site':'cross-site'});
 if(failure==='step-up-denied')mfa.challengeAndVerify.mockResolvedValue({data:null,error:{message:secret}});
 if(failure==='changed-owner')getUser.mockResolvedValue({data:{user:{id:factor,email_confirmed_at:'x'}},error:null});
 if(failure==='changed-session')mfa.challengeAndVerify.mockResolvedValue({data:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:factor})).toString('base64url')}.synthetic`},error:null});
 const r=await providerAdminRequest(req);expect(r.status).toBe(403);expect(JSON.stringify(await r.json())).not.toContain(secret);expect(rpc.mock.calls.some(([name]:any)=>name==='cluera_provider_mutate')).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
it('requires reviewed bootstrap and supports metadata-only reads without browser Origin header',async()=>{
 vi.stubEnv('CLUERA_PROVIDER_VAULT_ENABLED','false');const blocked=await providerAdminRequest(request());expect(blocked.status).toBe(503);expect(await blocked.json()).toEqual({error:'VAULT_BOOTSTRAP_REQUIRED'});
 vi.stubEnv('CLUERA_PROVIDER_VAULT_ENABLED','true');const ready=await providerAdminRequest(request());expect(ready.status).toBe(200);expect(await ready.json()).toEqual({code:'ACTIVE',providers:[metadata()]});expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('encrypts a replacement before SQL, never returns credentials/tokens and never grants or calls providers',async()=>{
 const op=body();const r=await providerAdminRequest(request(op));expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('x-content-type-options')).toBe('nosniff');
 const mutation=rpc.mock.calls.find(([name]:any)=>name==='cluera_provider_mutate')[1];expect(JSON.stringify(mutation)).not.toContain(secret);expect(mutation.p_input.credentialId).toBe(op.operationId);
 expect(vaultKeyring(env).open(mutation.p_input.sealed,{provider:'gemini',credentialId:op.operationId})).toBe(secret);
 const output=JSON.stringify(await r.json());expect(output).not.toContain(secret);expect(output).not.toContain('sealed');expect(output).not.toContain(token);expect(mfa.challengeAndVerify).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
});
it('decrypts accepted uppercase operation IDs after canonical database read-back',async()=>{
 const op={...body(),operationId:'ABCDEF00-1234-4234-8234-ABCDEF123456'};
 const r=await providerAdminRequest(request(op));expect(r.status).toBe(200);
 const mutation=rpc.mock.calls.find(([name]:any)=>name==='cluera_provider_mutate')[1];
 // PostgreSQL uuid text output is lowercase, independently of the input case.
 const storedCredentialId=mutation.p_input.credentialId.toLowerCase();
 expect(vaultKeyring(env).open(mutation.p_input.sealed,{provider:'gemini',credentialId:storedCredentialId})).toBe(secret);
 expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(await r.json())).not.toContain(secret);
});
it('rejects schema/secret injection, arbitrary fallback and provider-host control without logging bodies',async()=>{
 for(const patch of [{endpoint:'https://attacker.invalid'},{apiKey:'bad\nsecret'},{action:'CONFIGURE',enabled:true,defaultModel:'x-model',fallback:'OPENAI'}]){
  const r=await providerAdminRequest(request({...body(),...patch}));expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'INVALID_INPUT'});
 }
 expect(mfa.challengeAndVerify).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('validates metadata allowlist instead of reflecting a malformed server result or plaintext',async()=>{
 rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:{code:'ACTIVE',providers:[{...metadata(),apiKey:secret}]},error:null}));
 const r=await providerAdminRequest(request());expect(r.status).toBe(400);expect(JSON.stringify(await r.json())).not.toContain(secret);
});
it.each(['read','cancel'] as const)('an untrusted Admin body cannot extend the existing2s limit through hanging %s',async failure=>{
 vi.useFakeTimers();
 const never=()=>new Promise<never>(()=>{}),cancel=vi.fn(never),releaseLock=vi.fn();let part=0;
 const read=vi.fn(()=>failure==='read'?never():Promise.resolve(part++===0
  ?{done:false,value:Buffer.from('{malformed-json')}:{done:true,value:undefined}));
 const req=request(body());Object.defineProperty(req,'body',{value:{getReader:()=>({read,cancel,releaseLock})}});
 let finished=false;const pending=providerAdminRequest(req).then(response=>{finished=true;return response;});
 await vi.advanceTimersByTimeAsync(0);
 if(failure==='read'){
  expect(finished).toBe(false);await vi.advanceTimersByTimeAsync(1999);expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
 }
 expect(finished).toBe(true);const response=await pending;
 expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'INVALID_INPUT'});
 expect(cancel).toHaveBeenCalled();expect(releaseLock).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 expect(mfa.challengeAndVerify).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 expect(rpc.mock.calls.every(([name]:any)=>name==='account_admin_check')).toBe(true);
});
it.each([['CONFLICT',409,'CONFLICT'],['INVALID',409,'CHANGE_REJECTED'],['FORBIDDEN',403,'FORBIDDEN']] as const)('returns a definitive %s refusal without exposing the database response',async(code,status,error)=>{
 rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:{code,privateValue:secret},error:null}));
 const response=await providerAdminRequest(request(body()));expect(response.status).toBe(status);expect(await response.json()).toEqual({error});
 expect(mfa.challengeAndVerify).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
});
it.each([null,{code:'UNEXPECTED'},{code:'APPLIED',metadata:{...metadata(),apiKey:secret}}])('preserves an unknown mutation outcome for an unexpected or malformed result',async result=>{
 rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:result,error:null}));
 const response=await providerAdminRequest(request(body()));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'PROVIDER_SERVICE_UNAVAILABLE'});
 expect(mfa.challengeAndVerify).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
});
