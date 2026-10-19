import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountAdminRequest} from '../lib/accounts/admin';
import {accountConfig} from '../lib/accounts/config';
import {seal,unseal} from '../lib/accounts/cookies';
const mocks=vi.hoisted(()=>({clients:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const origin='https://cluera-ai-staging.vercel.app';
const uid='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
function token(userId=uid,sessionId=sid,suffix='original'){
 return `header.${Buffer.from(JSON.stringify({sub:userId,session_id:sessionId,iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',
  aud:'authenticated',role:'authenticated',aal:'aal2',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.${suffix}`;
}
const session=(userId=uid,sessionId=sid,suffix='original')=>({access_token:token(userId,sessionId,suffix),refresh_token:`synthetic-refresh-${suffix}`,expires_in:3600});
let auth:any,rpc:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 for(const [key,value]of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,
  NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',
  SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_private_test_double',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),
  SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 const getUser=vi.fn(async(access:string)=>({data:{user:{id:JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString()).sub,
  email:'synthetic@example.invalid',email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}},error:null}));
 auth={getUser,setSession:vi.fn(async()=>({data:{session:session(uid,sid,'rotated')},error:null})),refreshSession:vi.fn(),
  mfa:{listFactors:vi.fn(),enroll:vi.fn(),challengeAndVerify:vi.fn()}};
 rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>({data:name==='customer_authorize'
  ?{code:'ACTIVE',userId:args.p_user_id,trialSecondsGranted:900,remoteDesktop:false}
  :name==='account_admin_read_v2'?{code:'ACTIVE',users:[],catalog:[]}:true,error:null,status:200}));
 mocks.clients.mockReturnValue({auth:{auth},service:{rpc}});vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network');}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
function request(body?:object){
 const config=accountConfig(),values={access:token(),refresh:session().refresh_token,session:{userId:uid,sessionId:sid}};
 const cookie=Object.entries(values).map(([kind,value])=>`__Host-sr-account-${kind}=${seal(value,kind as 'access'|'refresh'|'session',config,3600)}`).join('; ');
 return new Request(`${origin}/api/account/admin`,{headers:{origin,cookie,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
}
it('validates a real anchored customer session again before saving a rotated Admin SDK session',async()=>{
 const response=await accountAdminRequest(request());expect(response.status).toBe(200);expect(auth.getUser).toHaveBeenCalledTimes(2);
 expect(rpc.mock.calls.filter(([name])=>name==='customer_authorize').map(([,args])=>args)).toEqual([
  {p_user_id:uid,p_session_id:sid},{p_user_id:uid,p_session_id:sid}]);
 const encoded=response.headers.get('set-cookie')!.match(/__Host-sr-account-refresh=([^;]+)/)![1];
 expect(unseal(encoded,'refresh',accountConfig())).toBe('synthetic-refresh-rotated');expect(auth.refreshSession).not.toHaveBeenCalled();
});
it.each([[other,sid],[uid,other]])('refuses a changed restored owner/session before customer initialization or MFA (%s,%s)',async(userId,sessionId)=>{
 auth.setSession.mockResolvedValueOnce({data:{session:session(userId,sessionId,'other')},error:null});
 const response=await accountAdminRequest(request({action:'MFA_ENROLL'}));expect(response.status).toBe(401);
 expect(auth.getUser).toHaveBeenCalledTimes(2);expect(rpc.mock.calls.filter(([name])=>name==='customer_authorize')).toHaveLength(1);
 expect(auth.mfa.listFactors).not.toHaveBeenCalled();expect(auth.mfa.enroll).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toBeNull();
});
it('retains the already rotated credentials when a later release validation is rejected',async()=>{
 const response=await accountAdminRequest(request({action:'RELEASE_DRAFT',operationId:other,subjectId:null,reason:'Reviewed synthetic invalid release input',input:{}}));
 expect(response.status).toBe(400);expect(response.headers.get('set-cookie')).toContain('__Host-sr-account-refresh=');
 expect(rpc.mock.calls.some(([name])=>name==='cluera_release_admin')).toBe(false);
});
