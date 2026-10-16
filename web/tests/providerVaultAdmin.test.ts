import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {providerAdminRequest} from '../lib/aiProviders/admin';
import {vaultKeyring} from '../lib/aiProviders/vault';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn()}));
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
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
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
