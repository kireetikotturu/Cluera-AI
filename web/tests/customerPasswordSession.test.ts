import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountConfig} from '../lib/accounts/config';
import {seal,unseal,AccountCookies} from '../lib/accounts/cookies';
import {handleAccount} from '../lib/accounts/handler';
import {authFailure,emailNotice} from '../lib/accounts/publicAuth';
const mocks=vi.hoisted(()=>({clients:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const origin='https://cluera-ai-staging.vercel.app',uid='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002';
const other='00000000-0000-4000-8000-000000000003',TOKEN_EXP=Math.floor(Date.now()/1000)+3600;
function token(userId=uid,sessionId=sid,expired=false){return 'header.'+Buffer.from(JSON.stringify({sub:userId,session_id:sessionId,
 iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',exp:expired?1:TOKEN_EXP})).toString('base64url')+'.synthetic';}
function session(userId=uid,sessionId=sid){return {access_token:token(userId,sessionId),refresh_token:'synthetic-refresh-'+userId,expires_in:3600};}
function rotatedSession(userId=uid,sessionId=sid){return {...session(userId,sessionId),access_token:token(userId,sessionId)+'-rotated',refresh_token:'synthetic-rotated-refresh-'+userId};}
function responseCookie(response:Response,kind:'access'|'refresh'|'session'|'recovery-lock'){
 const prefix=`__Host-sr-account-${kind}=`,header=response.headers.getSetCookie().filter(value=>value.startsWith(prefix)).at(-1);
 return unseal(header?.slice(prefix.length).split(';')[0],kind,accountConfig());
}
function cookie(kind:'access'|'refresh'|'session'|'recovery',value:unknown){return `__Host-sr-account-${kind}=${seal(value,kind,accountConfig(),3600)}`;}
function cookies(recovery=false,anchor=true){return [cookie('access',token()),cookie('refresh',session().refresh_token),
 ...(anchor?[cookie('session',{userId:uid,sessionId:sid})]:[]),...(recovery?[cookie('recovery',sid)]:[])].join('; ');}
function request(action:string,input:unknown={},credentials=cookies(),method='POST'){
 return new Request(origin+'/api/account/'+action,{method,headers:{origin,cookie:credentials,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(input)}:{})});
}
function makeAuth(){return {
 getUser:vi.fn(async(access:string)=>{const claims=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString());
  return claims.exp<=Math.floor(Date.now()/1000)?{data:{user:null},error:{status:401}}:{data:{user:{id:claims.sub,email:'synthetic@example.invalid',email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}},error:null};}),
 refreshSession:vi.fn(async()=>({data:{session:session()},error:null})),setSession:vi.fn(async()=>({data:{session:session()},error:null})),
 getSession:vi.fn(async()=>({data:{session:session()},error:null})),
 updateUser:vi.fn(async()=>({data:{user:{id:uid}},error:null})),reauthenticate:vi.fn(async()=>({data:{user:null,session:null},error:null})),
 };}
let auth:ReturnType<typeof makeAuth>,rpc:ReturnType<typeof vi.fn>,signOut:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 for(const [key,value]of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,
  NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',
  SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_private_test_double',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),
  SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real Auth/network request');}));auth=makeAuth();signOut=vi.fn(async()=>({error:null}));
 rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='customer_auth_rate_limit')return {data:true,error:null,status:200};
  if(name==='customer_authorize')return {data:{code:'ACTIVE',userId:args.p_user_id,trialSecondsGranted:900,remoteDesktop:false},error:null,status:200};
  throw Error('Unexpected business/financial RPC');
 });mocks.clients.mockReturnValue({auth:{auth},service:{rpc,auth:{admin:{signOut}}},flow:()=>({}),recovery:()=>false});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
it('ordinary signed-in change-password is distinct from recovery and sends only approved security fields',async()=>{
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase',currentPassword:'current-test-password',nonce:'123456'}),'change-password');
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,sessionsRevoked:true,message:'Password updated. Sign in again.'});
 expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({password:'new-test-passphrase',current_password:'current-test-password',nonce:'123456'});
 expect(signOut).toHaveBeenCalledExactlyOnceWith(token(),'global');expect(response.headers.get('set-cookie')).toContain('sr-account-session=;');
});
it('ordinary reset rejection explains recovery rather than falsely blaming password length',async()=>{
 const response=await handleAccount(request('reset-password',{password:'a-valid-test-passphrase'}),'reset-password');
 expect(response.status).toBe(403);const body=await response.json();expect(body.code).toBe('RECOVERY_SESSION_REQUIRED');
 expect(authFailure(response.status,'reset-password',body.code)).toContain('password-reset email');expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
 expect(response.headers.get('set-cookie')).toBeNull();
});
it.each(['change-password','reset-password'])('MFA-required %s retains the live recovery/session and requests an authenticator step',async action=>{
 auth.updateUser.mockResolvedValueOnce({data:{user:null},error:{status:401,code:'insufficient_aal',message:'PRIVATE_UPSTREAM_DETAIL'}} as never);
 const response=await handleAccount(request(action,{expectedAccountId:uid,password:'new-test-passphrase'},cookies(action==='reset-password')),action);
 expect(response.status).toBe(403);expect(await response.json()).toEqual({code:'MFA_REQUIRED',error:'Verify your authenticator code before updating your password.'});
 expect(auth.updateUser).toHaveBeenCalledOnce();expect(signOut).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')??'').not.toContain('Max-Age=0');
});
it.each([8,128])('ordinary change accepts %i characters without relaxing upstream strength policy',async length=>{
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'x'.repeat(length)}),'change-password');expect(response.status).toBe(200);
 expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({password:'x'.repeat(length)});
});
it.each([7,129])('ordinary change rejects %i characters before Auth without clearing the valid browser session',async length=>{
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'x'.repeat(length)}),'change-password');
 expect(response.status).toBe(400);expect((await response.json()).code).toBe('WEAK_PASSWORD');expect(auth.getUser).not.toHaveBeenCalled();
 expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toBeNull();
});
it.each([['weak_password','WEAK_PASSWORD',400],['same_password','SAME_PASSWORD',400],['reauthentication_needed','REAUTHENTICATION_REQUIRED',403],
 ['reauthentication_not_valid','INVALID_REAUTHENTICATION',400],['current_password_required','CURRENT_PASSWORD_REQUIRED',400],
 ['current_password_mismatch','CURRENT_PASSWORD_MISMATCH',400]])('fixed upstream %s failure preserves the valid session',async(code,wanted,status)=>{
 auth.updateUser.mockResolvedValueOnce({data:{user:null},error:{status:400,code,message:'DO_NOT_ECHO_PRIVATE_AUTH_REASON'}} as never);
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(status);expect((await response.json()).code).toBe(wanted);expect(response.headers.get('set-cookie')).toBeNull();expect(signOut).not.toHaveBeenCalled();
});
it('unknown password-update transport outcome neither retries nor signs out or clears a valid session',async()=>{
 auth.updateUser.mockRejectedValueOnce(Error('DO_NOT_ECHO_PRIVATE_TRANSPORT'));
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(503);const body=await response.json();expect(body.code).toBe('PASSWORD_UPDATE_UNCERTAIN');expect(JSON.stringify(body)).not.toContain('DO_NOT_ECHO');
 expect(auth.updateUser).toHaveBeenCalledOnce();expect(signOut).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toBeNull();
});
it('known password success followed by revoke failure is reported truthfully and never calls update twice',async()=>{
 signOut.mockResolvedValueOnce({error:{status:503}} as never);
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(200);const body=await response.json();expect(body.ok).toBe(true);expect(body.sessionsRevoked).toBe(false);expect(body.message).toContain('Password updated');
 expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect(auth.updateUser).toHaveBeenCalledOnce();expect(signOut).toHaveBeenCalledOnce();
});
it('explicit reauthentication sends only once and never updates a password or creates a login session',async()=>{
 const response=await handleAccount(request('reauthenticate',{expectedAccountId:uid}),'reauthenticate');expect(response.status).toBe(200);
 expect(await response.json()).toEqual({ok:true,message:emailNotice});expect(auth.reauthenticate).toHaveBeenCalledOnce();expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
});
it.each(['success','returned-error','throw'])('reauthentication %s preserves an authorized SDK rotation without replaying email',async outcome=>{
 const latest=rotatedSession();auth.getSession.mockResolvedValueOnce({data:{session:latest},error:null});
 if(outcome==='returned-error')auth.reauthenticate.mockResolvedValueOnce({data:{user:null,session:null},error:{status:503}} as never);
 if(outcome==='throw')auth.reauthenticate.mockRejectedValueOnce(Error('DO_NOT_ECHO_EMAIL_TRANSPORT'));
 const response=await handleAccount(request('reauthenticate',{expectedAccountId:uid}),'reauthenticate');
 expect(response.status).toBe(outcome==='success'?200:503);
 expect(await response.json()).toEqual(outcome==='success'?{ok:true,message:emailNotice}
  :{code:'REAUTHENTICATION_UNAVAILABLE',error:'A verification code could not be sent. Try again later.'});
 expect(responseCookie(response,'refresh')).toBe(latest.refresh_token);expect(responseCookie(response,'session')).toEqual({userId:uid,sessionId:sid});
 expect(auth.getUser).toHaveBeenCalledWith(latest.access_token);expect(auth.reauthenticate).toHaveBeenCalledOnce();expect(auth.getSession).toHaveBeenCalledOnce();
 expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
});
it.each(['returned-error','throw'])('recovery password %s preserves SDK rotation and the exact original reset deadline',async outcome=>{
 const latest=rotatedSession(),lock={sessionId:sid,resetUntil:Date.now()+120000};
 auth.getSession.mockResolvedValueOnce({data:{session:latest},error:null});
 if(outcome==='returned-error')auth.updateUser.mockResolvedValueOnce({data:{user:null},error:{status:401,code:'insufficient_aal'}} as never);
 else auth.updateUser.mockRejectedValueOnce(Error('DO_NOT_ECHO_PASSWORD_TRANSPORT'));
 const credentials=cookies()+`; __Host-sr-account-recovery-lock=${seal(lock,'recovery-lock',accountConfig(),30*86400)}`;
 const response=await handleAccount(request('reset-password',{expectedAccountId:uid,password:'new-test-passphrase'},credentials),'reset-password');
 expect(response.status).toBe(outcome==='returned-error'?403:503);const body=await response.json();
 expect(body.code).toBe(outcome==='returned-error'?'MFA_REQUIRED':'PASSWORD_UPDATE_UNCERTAIN');expect(JSON.stringify(body)).not.toContain('synthetic-rotated');
 expect(responseCookie(response,'refresh')).toBe(latest.refresh_token);expect(responseCookie(response,'recovery-lock')).toEqual(lock);
 expect(auth.updateUser).toHaveBeenCalledOnce();expect(signOut).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).not.toContain('Max-Age=0');
});
it.each([[other,sid],[uid,other]])('post-operation capture refuses changed owner/session %s %s before unrelated customer RPC or sealing',async(userId,sessionId)=>{
 const latest=rotatedSession(userId,sessionId);auth.getSession.mockResolvedValueOnce({data:{session:latest},error:null});
 auth.updateUser.mockResolvedValueOnce({data:{user:null},error:{status:400,code:'same_password'}} as never);
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(400);expect((await response.json()).code).toBe('SAME_PASSWORD');expect(response.headers.get('set-cookie')).toBeNull();
 expect(rpc.mock.calls.filter(([name])=>name==='customer_authorize')).toEqual([
  ['customer_authorize',{p_user_id:uid,p_session_id:sid}],['customer_authorize',{p_user_id:uid,p_session_id:sid}]]);
 expect(auth.updateUser).toHaveBeenCalledOnce();expect(signOut).not.toHaveBeenCalled();
});
it('known password success revokes the latest Auth-validated SDK access token without exposing captured credentials',async()=>{
 const latest=rotatedSession();auth.getSession.mockResolvedValueOnce({data:{session:latest},error:null});
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,sessionsRevoked:true,message:'Password updated. Sign in again.'});
 expect(signOut).toHaveBeenCalledExactlyOnceWith(latest.access_token,'global');expect(auth.getUser).toHaveBeenCalledWith(latest.access_token);
 expect(responseCookie(response,'access')).toBeNull();expect(responseCookie(response,'refresh')).toBeNull();expect(auth.updateUser).toHaveBeenCalledOnce();
});
it.each(['missing','malformed','error','throw','wrong-owner','rejected-token'])('known password success stays truthful when SDK capture is %s',async outcome=>{
 const latest=rotatedSession(outcome==='wrong-owner'?other:uid);
 if(outcome==='throw')auth.getSession.mockRejectedValueOnce(Error('DO_NOT_ECHO_CAPTURE'));
 else auth.getSession.mockResolvedValueOnce({data:{session:outcome==='missing'?null:outcome==='malformed'?{...latest,expires_in:Infinity}:latest},error:outcome==='error'?{status:503}:null} as never);
 if(outcome==='rejected-token'){
  const original=auth.getUser.getMockImplementation()!;
  auth.getUser.mockImplementation(async access=>access===latest.access_token?{data:{user:null},error:{status:401}} as never:original(access));
 }
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,sessionsRevoked:true,message:'Password updated. Sign in again.'});
 expect(signOut).toHaveBeenCalledExactlyOnceWith(token(),'global');expect(responseCookie(response,'access')).toBeNull();expect(responseCookie(response,'refresh')).toBeNull();
 expect(auth.updateUser).toHaveBeenCalledOnce();expect(response.headers.get('set-cookie')).not.toContain(latest.refresh_token);
});
it('rate-limited reauthentication never sends an email or updates/signs out',async()=>{
 const original=rpc.getMockImplementation()!;
 rpc.mockImplementation(async(name,args)=>name==='customer_auth_rate_limit'?{data:false,error:null,status:200}:original(name,args));
 const response=await handleAccount(request('reauthenticate',{expectedAccountId:uid}),'reauthenticate');
 expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('60');
 expect(auth.reauthenticate).not.toHaveBeenCalled();expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
});
it('wrong expected account and recovery/ordinary action crossover are denied before password/reauth writes',async()=>{
 for(const [action,input,credentials]of [['change-password',{expectedAccountId:other,password:'new-test-passphrase'},cookies()],
  ['change-password',{expectedAccountId:uid,password:'new-test-passphrase'},cookies(true)],['reauthenticate',{expectedAccountId:uid},cookies(true)]] as const){
  expect((await handleAccount(request(action,input,credentials),action)).status).toBe(403);
 }expect(auth.updateUser).not.toHaveBeenCalled();expect(auth.reauthenticate).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
});
it('recovery update failure preserves recovery/session material and does not sign out',async()=>{
 auth.updateUser.mockResolvedValueOnce({data:{user:null},error:{status:400,code:'same_password'}} as never);
 const response=await handleAccount(request('reset-password',{password:'new-test-passphrase',expectedAccountId:uid},cookies(true)),'reset-password');
 expect(response.status).toBe(400);expect((await response.json()).code).toBe('SAME_PASSWORD');expect(response.headers.get('set-cookie')).toContain('sr-account-recovery-lock=');expect(response.headers.get('set-cookie')).not.toContain('Max-Age=0');expect(signOut).not.toHaveBeenCalled();
});
it('setSession identity change is rejected before an unrelated customer_authorize or password write',async()=>{
 auth.setSession.mockResolvedValueOnce({data:{session:session(other,other)},error:null});
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(401);expect(rpc.mock.calls.filter(([name])=>name==='customer_authorize')).toHaveLength(1);
 expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toBeNull();
});
it('refresh after access-cookie disappearance retains the encrypted owner/session anchor',async()=>{
 const credentials=[cookie('refresh',session().refresh_token),cookie('session',{userId:uid,sessionId:sid})].join('; ');
 const response=await handleAccount(request('session',{},credentials,'GET'),'session');expect(response.status).toBe(200);
 expect(auth.refreshSession).toHaveBeenCalledExactlyOnceWith({refresh_token:session().refresh_token});
 const encoded=response.headers.get('set-cookie')!.match(/__Host-sr-account-session=([^;]+)/)![1];
 expect(unseal(encoded,'session',accountConfig())).toEqual({userId:uid,sessionId:sid});
 expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');expect(response.headers.get('set-cookie')).toContain('; Secure');
 expect(JSON.stringify(await response.json())).not.toContain(session().refresh_token);
});
it.each([[other,sid],[uid,other]])('anchored refresh refuses changed owner/session %s %s before any customer initialization',async(userId,sessionId)=>{
 auth.refreshSession.mockResolvedValueOnce({data:{session:session(userId,sessionId)},error:null});
 const credentials=[cookie('refresh',session().refresh_token),cookie('session',{userId:uid,sessionId:sid})].join('; ');
 const response=await handleAccount(request('session',{},credentials,'GET'),'session');expect(response.status).toBe(401);
 expect(rpc).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
});
it('legacy refresh-only cookies authenticate once and upgrade without recreating a login or forcing customer logout',async()=>{
 const response=await handleAccount(request('session',{},cookie('refresh',session().refresh_token),'GET'),'session');expect(response.status).toBe(200);
 expect(auth.refreshSession).toHaveBeenCalledOnce();expect(auth.getUser).toHaveBeenCalledExactlyOnceWith(token());
 expect(rpc).toHaveBeenCalledExactlyOnceWith('customer_authorize',{p_user_id:uid,p_session_id:sid});
 expect(response.headers.get('set-cookie')).toContain('sr-account-session=');expect(signOut).not.toHaveBeenCalled();
});
it('valid pre-anchor browser sessions lazily establish the pin without refresh or changing public DTO',async()=>{
 const response=await handleAccount(request('session',{},cookies(false,false),'GET'),'session');expect(response.status).toBe(200);
 expect(auth.refreshSession).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toContain('sr-account-session=');
 expect(await response.json()).toEqual({account:{userId:uid,email:'synthetic@example.invalid',trialSecondsGranted:900,remoteDesktop:false},passwordRecovery:false});
});
it('malformed anchor rejects before refresh and cookie-kind binding remains cryptographic',async()=>{
 const malformed=seal({userId:uid,sessionId:sid,admin:true},'session',accountConfig(),3600);
 const response=await handleAccount(request('session',{},cookie('refresh',session().refresh_token)+'; __Host-sr-account-session='+malformed,'GET'),'session');
 expect(response.status).toBe(401);expect(auth.refreshSession).not.toHaveBeenCalled();expect(auth.getUser).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
 expect(unseal(seal({userId:uid,sessionId:sid},'refresh',accountConfig(),3600),'session',accountConfig())).toBeNull();
});
it('parallel refreshes for different anchored accounts cannot mix response owners or customer RPC identities',async()=>{
 const second=session(other,other);
 auth.refreshSession.mockImplementation(async({refresh_token}:{refresh_token:string})=>({data:{session:refresh_token===second.refresh_token?second:session()},error:null}));
 const firstCookies=[cookie('refresh',session().refresh_token),cookie('session',{userId:uid,sessionId:sid})].join('; ');
 const secondCookies=[cookie('refresh',second.refresh_token),cookie('session',{userId:other,sessionId:other})].join('; ');
 const [a,b]=await Promise.all([handleAccount(request('session',{},firstCookies,'GET'),'session'),handleAccount(request('session',{},secondCookies,'GET'),'session')]);
 expect(a.status).toBe(200);expect(b.status).toBe(200);expect((await a.json()).account.userId).toBe(uid);expect((await b.json()).account.userId).toBe(other);
 expect(rpc.mock.calls).toEqual(expect.arrayContaining([['customer_authorize',{p_user_id:uid,p_session_id:sid}],['customer_authorize',{p_user_id:other,p_session_id:other}]]));
 expect(auth.refreshSession).toHaveBeenCalledTimes(2);expect(signOut).not.toHaveBeenCalled();
});
it.each([null,{id:other}])('unconfirmed password success body never revokes or clears a valid session: %j',async user=>{
 auth.updateUser.mockResolvedValueOnce({data:{user},error:null} as never);
 const response=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'}),'change-password');
 expect(response.status).toBe(503);expect((await response.json()).code).toBe('PASSWORD_UPDATE_UNCERTAIN');expect(signOut).not.toHaveBeenCalled();expect(response.headers.get('set-cookie')).toBeNull();
});
it('invalid security fields are not falsely reported as password length failures',async()=>{
 const response=await handleAccount(request('reset-password',{expectedAccountId:uid,password:'new-test-passphrase',nonce:'12345'},cookies(true)),'reset-password');
 expect(response.status).toBe(400);const body=await response.json();expect(body.code).toBe('INVALID_SECURITY_FIELDS');expect(authFailure(400,'reset-password',body.code)).not.toContain('8 to 128');expect(auth.updateUser).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();
});
it('pinned logout revokes only the validated current identity and uses a rotated token once',async()=>{
 expect((await handleAccount(request('logout',{expectedAccountId:other}),'logout')).status).toBe(403);expect(signOut).not.toHaveBeenCalled();
 const credentials=[cookie('refresh',session().refresh_token),cookie('session',{userId:uid,sessionId:sid})].join('; ');
 expect((await handleAccount(request('logout',{expectedAccountId:uid},credentials),'logout')).status).toBe(200);expect(auth.refreshSession).toHaveBeenCalledOnce();expect(signOut).toHaveBeenCalledExactlyOnceWith(token(),'local');
});
it('explicit logout clears an ended recovery session without permitting a stale different-owner operation',async()=>{
 auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
 const response=await handleAccount(request('logout',{expectedAccountId:uid},cookies(true)),'logout');
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true});expect(response.headers.get('set-cookie')).toContain('sr-account-flow=;');
 expect(signOut).not.toHaveBeenCalled();
 const wrong=await handleAccount(request('logout',{expectedAccountId:other},cookies(true)),'logout');
 expect(wrong.status).toBe(403);expect(wrong.headers.get('set-cookie')).toBeNull();
});
it('recovery restriction survives reset-window expiry without extending reset authorization',async()=>{
 vi.useFakeTimers();const now=Date.now(),config=accountConfig(),lock={sessionId:sid,resetUntil:now+600_000};
 const credentials=cookies()+`; __Host-sr-account-recovery-lock=${seal(lock,'recovery-lock',config,30*86400)}`;
 vi.setSystemTime(now+601_000);const stored=new AccountCookies(request('session',{},credentials,'GET'),config);
 expect(stored.get('recovery')).toBe(sid);expect(stored.recoveryResetAllowed(sid)).toBe(false);
 const response=await handleAccount(request('reset-password',{expectedAccountId:uid,password:'new-test-passphrase'},credentials),'reset-password');
 expect(response.status).toBe(403);expect((await response.json()).code).toBe('RECOVERY_SESSION_REQUIRED');expect(auth.updateUser).not.toHaveBeenCalled();
 const ordinary=await handleAccount(request('change-password',{expectedAccountId:uid,password:'new-test-passphrase'},credentials),'change-password');expect(ordinary.status).toBe(403);expect((await ordinary.json()).code).toBe('PASSWORD_RECOVERY_ACTIVE');
});
