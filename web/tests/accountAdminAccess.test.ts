import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountConfig,AccountError} from '../lib/accounts/config';
import {seal} from '../lib/accounts/cookies';
import {accountAdminAccessRequest} from '../lib/accounts/adminAccess';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),authorize:vi.fn(),rpc:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,authorizeCustomer:mocks.authorize}));
const origin='https://cluera-ai-staging.vercel.app',uid='00000000-0000-4000-8000-000000000801',sid='00000000-0000-4000-8000-000000000802';
let token:string,role:boolean,mfa:boolean;
const account={userId:uid,sessionId:sid,email:'clueraaisupport@gmail.com',trialSecondsGranted:900,remoteDesktop:false};
function request(kind='access',headers:Record<string,string>={}){
 const config=accountConfig(),cookie=kind==='none'?'':kind==='refresh'?'__Host-sr-account-refresh='+seal('synthetic-refresh','refresh',config,3600):'__Host-sr-account-access='+seal(token,'access',config,3600)+(kind==='recovery'?'; __Host-sr-account-recovery='+seal(sid,'recovery',config,600):'');
 return new Request(origin+'/api/account/admin/access',{headers:{cookie,...headers}});
}
beforeEach(()=>{
 vi.resetAllMocks();role=true;mfa=true;
 for(const [key,value]of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_server_key_0000000000',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,1).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,2).toString('base64')}))vi.stubEnv(key,value);
 token='header.'+Buffer.from(JSON.stringify({aal:'aal2',session_id:sid})).toString('base64url')+'.synthetic';
 mocks.session.mockImplementation(async()=>({account,session:{access_token:token,refresh_token:'synthetic-refresh'}}));mocks.authorize.mockResolvedValue(account);
 mocks.rpc.mockImplementation(async(name:string,args:{p_actor:string;p_session:string;p_require_mfa:boolean})=>{
  expect(name).toBe('account_admin_check');expect(args.p_actor).toBe(uid);expect(args.p_session).toBe(sid);return {data:args.p_require_mfa?mfa:role,error:null};});
 mocks.clients.mockReturnValue({service:{rpc:mocks.rpc}});vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network');}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('returns only protected role/MFA and a purpose-bound UI fence, never identity or credentials',async()=>{
 const response=await accountAdminAccessRequest(request());expect(response.status).toBe(200);
 expect(await response.json()).toEqual({admin:true,mfaVerified:true,navigationSession:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(response.headers.get('cache-control')).toBe('no-store');expect(mocks.rpc.mock.calls.map(([,args])=>args.p_require_mfa)).toEqual([false,true]);expect(fetch).not.toHaveBeenCalled();
});
it('matching support email without protected role is forbidden',async()=>{
 role=false;expect((await accountAdminAccessRequest(request())).status).toBe(403);expect(mocks.rpc).toHaveBeenCalledOnce();
});
it.each(['aal1','unreadable-aal','live-mfa-denied'])('role still exposes no MFA privilege for %s',async mode=>{
 if(mode==='aal1')token='header.'+Buffer.from(JSON.stringify({aal:'aal1'})).toString('base64url')+'.synthetic';
 if(mode==='unreadable-aal')token='malformed';if(mode==='live-mfa-denied')mfa=false;
 const response=await accountAdminAccessRequest(request());expect(response.status).toBe(200);expect((await response.json()).mfaVerified).toBe(false);
});
it('unauthenticated or recovery sessions cannot resolve a role',async()=>{
 mocks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));expect((await accountAdminAccessRequest(request('none'))).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled();
 expect((await accountAdminAccessRequest(request('recovery'))).status).toBe(403);expect(mocks.rpc).not.toHaveBeenCalled();
});
it('rejects cross-site/foreign-origin, query-selected identity and POST before SDK',async()=>{
 for(const headers of [{origin:'https://foreign.invalid'},{'sec-fetch-site':'cross-site'}])expect((await accountAdminAccessRequest(request('none',headers))).status).toBe(403);
 expect((await accountAdminAccessRequest(new Request(request().url+'?email=clueraaisupport%40gmail.com'))).status).toBe(404);
 expect((await accountAdminAccessRequest(new Request(request().url,{method:'POST',body:'{}'}))).status).toBe(404);expect(mocks.clients).not.toHaveBeenCalled();
});
it('RSC never refreshes missing or expired access, but verifies actual present access',async()=>{
 expect((await accountAdminAccessRequest(request('refresh'),false)).status).toBe(401);expect(mocks.clients).not.toHaveBeenCalled();
 mocks.authorize.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));expect((await accountAdminAccessRequest(request(),false)).status).toBe(401);
 const response=await accountAdminAccessRequest(request(),false);expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toBeNull();expect(mocks.session).not.toHaveBeenCalled();
});
it('lookup errors fail closed without raw upstream detail',async()=>{
 mocks.rpc.mockResolvedValue({data:null,error:{message:'PRIVATE_ROLE_ERROR'}});const response=await accountAdminAccessRequest(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE_ROLE_ERROR');
});
