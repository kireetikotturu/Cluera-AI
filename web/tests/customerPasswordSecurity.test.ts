import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountConfig} from '../lib/accounts/config';
import {seal,unseal,type CookieKind} from '../lib/accounts/cookies';
import {handlePasswordSecurity} from '../lib/accounts/passwordSecurity';
const mocks=vi.hoisted(()=>({clients:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const origin='https://cluera-ai-staging.vercel.app',uid='00000000-0000-4000-8000-000000000001';
const sid='00000000-0000-4000-8000-000000000002',fid='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004';
const tokenExpiry=Math.floor(Date.now()/1000)+3600;
function token(userId=uid,sessionId=sid,aal='aal1',variant='original'){
 return 'header.'+Buffer.from(JSON.stringify({sub:userId,session_id:sessionId,aal,variant,
  iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',exp:tokenExpiry})).toString('base64url')+'.synthetic';
}
function session(userId=uid,sessionId=sid,aal='aal1',variant='original'){
 return {access_token:token(userId,sessionId,aal,variant),refresh_token:'synthetic-refresh-'+variant,expires_in:3600};
}
function cookie(kind:CookieKind,value:unknown){return `__Host-sr-account-${kind}=${seal(value,kind,accountConfig(),30*86400)}`;}
function credentials(recovery=false,deadline=Date.now()+600000){return [cookie('access',token()),cookie('refresh',session().refresh_token),
 cookie('session',{userId:uid,sessionId:sid}),...(recovery?[cookie('recovery-lock',{sessionId:sid,resetUntil:deadline})]:[])].join('; ');}
function request(action:'password-security'|'password-mfa',options:{body?:unknown;cookie?:string;query?:string;method?:string;requestOrigin?:string}={}){
 const method=options.method??(action==='password-security'?'GET':'POST');
 const query=options.query??(action==='password-security'?'?expectedAccountId='+uid:'');
 return new Request(origin+'/api/account/'+action+query,{method,headers:{origin:options.requestOrigin??origin,
  cookie:options.cookie??credentials(),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(options.body??{expectedAccountId:uid,factorId:fid,code:'123456'})}:{})});
}
function makeAuth(){return {
 getUser:vi.fn(async(access:string)=>{const claims=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString());
  return {data:{user:{id:claims.sub,email:'synthetic@example.invalid',email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}},error:null};}),
 refreshSession:vi.fn(async()=>({data:{session:session()},error:null})),
 setSession:vi.fn(async()=>({data:{session:session()},error:null})),
 mfa:{listFactors:vi.fn(async()=>({data:{all:[{id:fid,status:'verified',factor_type:'totp',secret:'DO_NOT_ECHO_SECRET',friendly_name:'DO_NOT_ECHO_NAME'}]},error:null})),
  challengeAndVerify:vi.fn(async()=>({data:session(uid,sid,'aal2','mfa'),error:null})),enroll:vi.fn(),unenroll:vi.fn()},
 updateUser:vi.fn(),reauthenticate:vi.fn(),signOut:vi.fn(),
};}
let auth:ReturnType<typeof makeAuth>,rpc:ReturnType<typeof vi.fn>,signOut:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 for(const [key,value]of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,
  NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',
  SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_private_test_double',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),
  SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real Auth/network request');}));
 auth=makeAuth();signOut=vi.fn();rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='customer_auth_rate_limit')return {data:true,error:null,status:200};
  if(name==='customer_authorize')return {data:{code:'ACTIVE',userId:args.p_user_id,trialSecondsGranted:900,remoteDesktop:false},error:null,status:200};
  throw Error('Unexpected business/financial RPC');
 });
 mocks.clients.mockReturnValue({auth:{auth},service:{rpc,auth:{admin:{signOut}}},flow:()=>({}),recovery:()=>false});
});
afterEach(()=>{
 expect(auth.mfa.enroll).not.toHaveBeenCalled();expect(auth.mfa.unenroll).not.toHaveBeenCalled();
 expect(auth.updateUser).not.toHaveBeenCalled();expect(auth.reauthenticate).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
 vi.unstubAllGlobals();vi.unstubAllEnvs();vi.clearAllMocks();
});
async function failure(response:Response,code:string,status:number){
 expect(response.status).toBe(status);expect(response.headers.get('cache-control')).toBe('no-store');
 const body=await response.json();expect(Object.keys(body).sort()).toEqual(['code','error']);expect(body.code).toBe(code);
 expect(JSON.stringify(body)).not.toMatch(/DO_NOT_ECHO|synthetic-refresh|header\./);
}
it('GET lists only verified TOTP IDs and requires MFA without challenging or exposing factor metadata',async()=>{
 auth.mfa.listFactors.mockResolvedValueOnce({data:{all:[
  {id:fid,status:'verified',factor_type:'totp',secret:'DO_NOT_ECHO_SECRET',friendly_name:'DO_NOT_ECHO_NAME'},
  {id:other,status:'unverified',factor_type:'totp'},
 ]},error:null} as never);
 const response=await handlePasswordSecurity(request('password-security'),'password-security');
 expect(response.status).toBe(200);expect(await response.json()).toEqual({accountId:uid,passwordRecovery:false,recoveryExpired:false,needsMfa:true,factors:[{id:fid,type:'totp'}]});
 expect(rpc.mock.calls.filter(([name])=>name==='customer_auth_rate_limit')).toHaveLength(1);
 expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toBeNull();
});
it.each(['phone','webauthn','unknown_future_factor'])('keeps unsupported verified %s factors required without exposing metadata',async factor_type=>{
 auth.mfa.listFactors.mockResolvedValueOnce({data:{all:[{id:fid,status:'verified',factor_type,phone:'DO_NOT_ECHO_PHONE'}]},error:null} as never);
 const response=await handlePasswordSecurity(request('password-security'),'password-security');
 expect(await response.json()).toEqual({accountId:uid,passwordRecovery:false,recoveryExpired:false,needsMfa:true,factors:[]});
 expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it.each([{all:[]},{all:[{id:fid,status:'unverified',factor_type:'totp'}]}])('does not require MFA when no factor is verified',async({all})=>{
 auth.mfa.listFactors.mockResolvedValueOnce({data:{all},error:null} as never);
 expect(await (await handlePasswordSecurity(request('password-security'),'password-security')).json()).toMatchObject({needsMfa:false,factors:[]});
 expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('uses the Auth-validated restored JWT assurance level and seals legitimate rotation',async()=>{
 const rotated=session(uid,sid,'aal2','rotated');auth.setSession.mockResolvedValueOnce({data:{session:rotated},error:null});
 const response=await handlePasswordSecurity(request('password-security'),'password-security');
 expect(await response.json()).toMatchObject({needsMfa:false});
 const header=response.headers.getSetCookie().find(value=>value.startsWith('__Host-sr-account-refresh='))!;
 expect(unseal(header.split(';')[0].split('=')[1],'refresh',accountConfig())).toBe(rotated.refresh_token);
 expect(auth.getUser).toHaveBeenCalledWith(rotated.access_token);expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it.each(['?expectedAccountId='+uid+'&extra=1','?expectedAccountId='+uid+'&expectedAccountId='+uid,'','?expectedAccountId=invalid'])('rejects non-exact GET query %s before MFA',async query=>{
 await failure(await handlePasswordSecurity(request('password-security',{query}),'password-security'),'FORBIDDEN',403);
 expect(auth.mfa.listFactors).not.toHaveBeenCalled();expect(auth.setSession).not.toHaveBeenCalled();
});
it('binds the requested customer before restoring or reading factors',async()=>{
 await failure(await handlePasswordSecurity(request('password-security',{query:'?expectedAccountId='+other}),'password-security'),'FORBIDDEN',403);
 expect(auth.setSession).not.toHaveBeenCalled();expect(auth.mfa.listFactors).not.toHaveBeenCalled();
});
it.each(['GET','PUT'])('rejects the wrong password-mfa method %s without Auth operations',async method=>{
 await failure(await handlePasswordSecurity(request('password-mfa',{method}),'password-mfa'),'FORBIDDEN',403);
 expect(auth.getUser).not.toHaveBeenCalled();
});
it('rejects cross-origin MFA and query-bearing MFA before calling Auth',async()=>{
 await failure(await handlePasswordSecurity(request('password-mfa',{requestOrigin:'https://untrusted.invalid'}),'password-mfa'),'FORBIDDEN',403);
 await failure(await handlePasswordSecurity(request('password-mfa',{query:'?unexpected=1'}),'password-mfa'),'FORBIDDEN',403);
 expect(auth.getUser).not.toHaveBeenCalled();
});
it.each([
 {expectedAccountId:uid,factorId:fid,code:'12345'},
 {expectedAccountId:uid,factorId:fid,code:'1234567'},
 {expectedAccountId:uid,factorId:fid,code:'12a456'},
 {expectedAccountId:uid,factorId:fid,code:'123456',password:'DO_NOT_ECHO_PASSWORD'},
 {expectedAccountId:uid,factorId:'invalid',code:'123456'},
])('strictly rejects malformed MFA input',async body=>{
 await failure(await handlePasswordSecurity(request('password-mfa',{body}),'password-mfa'),'MFA_CODE_INVALID',400);
 expect(auth.getUser).not.toHaveBeenCalled();expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('requires current authentication without clearing or granting browser recovery',async()=>{
 const response=await handlePasswordSecurity(request('password-security',{cookie:''}),'password-security');
 await failure(response,'AUTHENTICATION_REQUIRED',401);expect(response.headers.get('set-cookie')).toBeNull();expect(auth.mfa.listFactors).not.toHaveBeenCalled();
});
it.each([[other,sid],[uid,other]])('rejects a restored token for another owner/session before unrelated SQL or factors',async(userId,sessionId)=>{
 auth.setSession.mockResolvedValueOnce({data:{session:session(userId,sessionId)},error:null});
 const response=await handlePasswordSecurity(request('password-security'),'password-security');
 await failure(response,'AUTHENTICATION_REQUIRED',401);expect(response.headers.get('set-cookie')).toBeNull();expect(auth.mfa.listFactors).not.toHaveBeenCalled();
 expect(rpc.mock.calls.filter(([name])=>name==='customer_authorize')).toHaveLength(1);
});
it.each([{status:401},{status:400,code:'refresh_token_not_found'},{status:400,name:'AuthSessionMissingError'}])('classifies rejected SDK restoration as authentication required',async error=>{
 auth.setSession.mockResolvedValueOnce({data:{session:null},error:{...error,message:'DO_NOT_ECHO_RESTORE'}} as never);
 await failure(await handlePasswordSecurity(request('password-security'),'password-security'),'AUTHENTICATION_REQUIRED',401);
 expect(auth.mfa.listFactors).not.toHaveBeenCalled();
});
it('reports an expired recovery deadline on GET without attempting a challenge',async()=>{
 const response=await handlePasswordSecurity(request('password-security',{cookie:credentials(true,Date.now()-1000)}),'password-security');
 expect(await response.json()).toMatchObject({passwordRecovery:true,recoveryExpired:true,needsMfa:true});expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('rejects expired recovery before step-up and cannot renew its reset deadline',async()=>{
 const response=await handlePasswordSecurity(request('password-mfa',{cookie:credentials(true,Date.now()-1000)}),'password-mfa');
 await failure(response,'RECOVERY_SESSION_REQUIRED',403);expect(response.headers.get('set-cookie')).toBeNull();
 expect(auth.setSession).not.toHaveBeenCalled();expect(auth.mfa.listFactors).not.toHaveBeenCalled();expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it.each([{id:other,status:'verified',factor_type:'totp'},{id:fid,status:'unverified',factor_type:'totp'},
 {id:fid,status:'verified',factor_type:'phone'}])('rejects an unowned, unverified or unsupported MFA factor before challenge',async factor=>{
 auth.mfa.listFactors.mockResolvedValueOnce({data:{all:[factor]},error:null} as never);
 await failure(await handlePasswordSecurity(request('password-mfa'),'password-mfa'),'FORBIDDEN',403);expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('verifies exactly once and seals AAL2 rotation while preserving the exact recovery deadline',async()=>{
 const deadline=Date.now()+120000,response=await handlePasswordSecurity(request('password-mfa',{cookie:credentials(true,deadline)}),'password-mfa');
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true});
 expect(auth.mfa.challengeAndVerify).toHaveBeenCalledExactlyOnceWith({factorId:fid,code:'123456'});
 expect(rpc.mock.calls.filter(([name])=>name==='customer_auth_rate_limit')).toHaveLength(2);
 const headers=response.headers.getSetCookie(),value=(kind:CookieKind)=>headers.find(header=>header.startsWith('__Host-sr-account-'+kind+'='))!.split(';')[0].split('=')[1];
 expect(unseal(value('access'),'access',accountConfig())).toBe(session(uid,sid,'aal2','mfa').access_token);
 expect(unseal(value('refresh'),'refresh',accountConfig())).toBe(session(uid,sid,'aal2','mfa').refresh_token);
 expect(unseal(value('session'),'session',accountConfig())).toEqual({userId:uid,sessionId:sid});
 expect(unseal(value('recovery-lock'),'recovery-lock',accountConfig())).toEqual({sessionId:sid,resetUntil:deadline});
 expect(headers.join(' ')).not.toContain('synthetic-refresh');
});
it.each([[other,sid,'aal2'],[uid,other,'aal2'],[uid,sid,'aal1']])('rejects a verified response that changes owner/session or lacks AAL2',async(userId,sessionId,aal)=>{
 auth.mfa.challengeAndVerify.mockResolvedValueOnce({data:session(userId,sessionId,aal,'wrong'),error:null});
 const response=await handlePasswordSecurity(request('password-mfa'),'password-mfa');
 await failure(response,aal==='aal1'?'MFA_REQUIRED':'AUTHENTICATION_REQUIRED',aal==='aal1'?403:401);
 expect(response.headers.get('set-cookie')).toBeNull();expect(auth.mfa.challengeAndVerify).toHaveBeenCalledOnce();
 expect(rpc.mock.calls.filter(([name])=>name==='customer_authorize')).toHaveLength(aal==='aal1'?3:2);
});
it.each([
 [{status:400,code:'mfa_verification_failed'},'MFA_CODE_INVALID',400],
 [{status:401,code:'mfa_verification_failed'},'MFA_CODE_INVALID',400],
 [{status:403,code:'mfa_verification_failed'},'MFA_CODE_INVALID',400],
 [{status:403,code:'mfa_verification_rejected'},'MFA_CODE_INVALID',400],
 [{status:401,code:'mfa_challenge_expired'},'MFA_CODE_INVALID',400],
 [{status:403,code:'mfa_totp_verify_not_enabled'},'MFA_UNAVAILABLE',503],
 [{status:401,code:'mfa_factor_not_found'},'MFA_UNAVAILABLE',503],
 [{status:403,code:'provider_disabled'},'MFA_UNAVAILABLE',503],
 [{status:422,code:'mfa_ip_address_mismatch'},'MFA_UNAVAILABLE',503],
 [{status:401,code:'insufficient_aal'},'MFA_REQUIRED',403],
 [{status:401,code:'bad_jwt'},'AUTHENTICATION_REQUIRED',401],
 [{status:429},'RATE_LIMITED',429],
 [{status:503},'MFA_UNAVAILABLE',503],
 ] as const)('maps fixed MFA errors without exposing provider details or retrying',async(error,code,status)=>{
 auth.mfa.challengeAndVerify.mockResolvedValueOnce({data:null,error:{...error,message:'DO_NOT_ECHO_MFA'}} as never);
 const response=await handlePasswordSecurity(request('password-mfa'),'password-mfa');await failure(response,code,status);
 expect(response.headers.get('retry-after')).toBe(status===429?'60':null);expect(auth.mfa.challengeAndVerify).toHaveBeenCalledOnce();expect(response.headers.get('set-cookie')).toBeNull();
});
it('fails closed on factor-list failure and preserves a valid recovery session',async()=>{
 auth.mfa.listFactors.mockRejectedValueOnce(Error('DO_NOT_ECHO_LIST'));
 const response=await handlePasswordSecurity(request('password-security',{cookie:credentials(true)}),'password-security');
 await failure(response,'MFA_UNAVAILABLE',503);expect(response.headers.get('set-cookie')).toBeNull();expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('obeys account throttling before restoring, listing or challenging MFA',async()=>{
 rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>({data:name==='customer_auth_rate_limit'?false:
  {code:'ACTIVE',userId:args.p_user_id,trialSecondsGranted:900,remoteDesktop:false},error:null,status:200}));
 const response=await handlePasswordSecurity(request('password-mfa'),'password-mfa');await failure(response,'RATE_LIMITED',429);
 expect(response.headers.get('retry-after')).toBe('60');expect(auth.setSession).not.toHaveBeenCalled();expect(auth.mfa.listFactors).not.toHaveBeenCalled();expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
});
