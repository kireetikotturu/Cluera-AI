import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {providerUsageAdminRequest} from '../lib/aiProviders/usageAdmin';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,rateLimit:mocks.limit}));
const origin='https://cluera-ai-staging.vercel.app',actor='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002';
const report={code:'ACTIVE',scope:'LATEST_REQUESTS',limit:50,costStatus:'UNAVAILABLE',rows:[]};
let rpc:ReturnType<typeof vi.fn>;
const request=(headers:Record<string,string>={})=>new Request(origin+'/api/account/admin/ai-usage',{headers});
beforeEach(()=>{
 for(const [key,value] of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-infrastructure-service-key',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64'),CLUERA_PROVIDER_USAGE_READ_ENABLED:'true',CLUERA_PROVIDER_TELEMETRY_ENABLED:'false'}))vi.stubEnv(key,value);
 mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:sid})).toString('base64url')}.synthetic`}});
 mocks.limit.mockResolvedValue(undefined);
 rpc=vi.fn(async(name:string)=>({data:name==='account_admin_check'?true:report,error:null}));mocks.clients.mockReturnValue({service:{rpc}});vi.stubGlobal('fetch',vi.fn());
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
it('reads only sanitized latest-request metadata after current Admin and MFA authorization',async()=>{
 const response=await providerUsageAdminRequest(request());expect(response.status).toBe(200);expect(await response.json()).toEqual(report);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['account_admin_check','cluera_provider_usage_admin_read']);expect(fetch).not.toHaveBeenCalled();
});
it.each(['aal1','role','cross-site','origin','recovery'])('denies %s before telemetry reads or provider calls',async failure=>{
 let req=request();
 if(failure==='aal1')mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1'})).toString('base64url')}.synthetic`}});
 if(failure==='role')rpc.mockResolvedValue({data:false,error:null});
 if(failure==='cross-site')req=request({'sec-fetch-site':'cross-site'});
 if(failure==='origin')req=request({origin:'https://attacker.invalid'});
 if(failure==='recovery')req=request({cookie:`sr_account_recovery=${sid}`});
 if(failure==='recovery'){
  // Use the cookie class itself rather than guessing its encrypted format.
  const {AccountCookies}=await import('../lib/accounts/cookies');vi.spyOn(AccountCookies.prototype,'get').mockImplementation(name=>name==='recovery'?sid:undefined);
 }
 try{const response=await providerUsageAdminRequest(req);expect(response.status).toBe(403);expect(rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_admin_read')).toBe(false);expect(fetch).not.toHaveBeenCalled();}
 finally{vi.restoreAllMocks();}
});
it('requires explicit telemetry activation and rejects extra secret-bearing response fields',async()=>{
 vi.stubEnv('CLUERA_PROVIDER_USAGE_READ_ENABLED','false');const disabled=await providerUsageAdminRequest(request());expect(disabled.status).toBe(503);expect(await disabled.json()).toEqual({error:'USAGE_READ_NOT_ENABLED'});
 expect(rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_admin_read')).toBe(false);
 vi.stubEnv('CLUERA_PROVIDER_USAGE_READ_ENABLED','true');rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:{...report,apiKey:'private'},error:null}));
 const invalid=await providerUsageAdminRequest(request());expect(invalid.status).toBe(503);expect(JSON.stringify(await invalid.json())).not.toContain('private');
});
it('rejects query parameters and mutating methods without constructing an authorized client',async()=>{
 for(const req of [new Request(origin+'/api/account/admin/ai-usage?userId=untrusted'),new Request(origin+'/api/account/admin/ai-usage',{method:'POST'})])expect((await providerUsageAdminRequest(req)).status).toBe(404);
 expect(mocks.clients).not.toHaveBeenCalled();
});
