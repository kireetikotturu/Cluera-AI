import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleNativeAccount } from '../lib/accounts/native';
const mocks = vi.hoisted(() => ({ clients: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));
const origin = 'https://cluera-ai-staging.vercel.app';
const uid = '00000000-0000-4000-8000-000000000001', sid = '00000000-0000-4000-8000-000000000002';
const token = `header.${Buffer.from(JSON.stringify({ sub: uid, session_id: sid })).toString('base64url')}.synthetic`;
const user = { id: uid, email: 'native@example.invalid', email_confirmed_at: '2026-10-04T00:00:00Z' };
let auth: ReturnType<typeof makeAuth>, rpc: ReturnType<typeof vi.fn>, signOut: ReturnType<typeof vi.fn>;
function makeAuth() {
  const session = { access_token: token, refresh_token: 'synthetic-native-refresh', expires_at: Math.floor(Date.now()/1000)+3600 };
  return { getUser: vi.fn(async () => ({ data: { user }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { session }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session }, error: null })),
    exchangeCodeForSession:vi.fn(async()=>({data:{session},error:null})) };
}
beforeEach(() => {
  vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','true'); vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN',origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://dwqltsqumiwsxtkzdoaa.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_synthetic_public_key_00000000000000000'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-key-placeholder');
  vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64',Buffer.alloc(32,3).toString('base64'));
  vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',Buffer.alloc(32,4).toString('base64'));
  auth = makeAuth(); signOut = vi.fn(async () => ({ error: null }));
  rpc = vi.fn(async (name: string) => ({ data: name === 'customer_auth_rate_limit' ? true : name === 'customer_usage_balance'
    ? { code:'ACTIVE',availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0 }
    : { code:'ACTIVE',userId:uid,trialSecondsGranted:900,remoteDesktop:false },error:null,status:200 }));
  mocks.clients.mockReturnValue({ auth:{auth},service:{rpc,auth:{admin:{signOut}}} });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function request(action: string, body: object = {}, headers: Record<string,string> = {}) {
  return new Request(`${origin}/api/account/native/${action}`, { method: action === 'session' ? 'GET' : 'POST',
    headers: { 'Content-Type':'application/json',...headers }, ...(action === 'session' ? {} : { body:JSON.stringify(body) }) });
}
const login = () => handleNativeAccount(request('login',{email:user.email,password:'synthetic-password'}),'login');
it('context commands bind verified account/session and reject browser, missing auth and caller identities',async()=>{
 expect((await handleNativeAccount(request('context',{action:'LIST'}),'context')).status).toBe(401);
 expect((await handleNativeAccount(request('context',{action:'LIST'},{origin,authorization:`Bearer ${token}`}),'context')).status).toBe(403);
 expect((await handleNativeAccount(request('context',{action:'LIST',userId:uid},{authorization:`Bearer ${token}`}),'context')).status).toBe(400);
 expect(rpc.mock.calls.some(call=>call[0]==='customer_context_command')).toBe(false);
 const result=await handleNativeAccount(request('context',{action:'READ',ids:[uid]},{authorization:`Bearer ${token}`}),'context');
 expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');
 expect(rpc).toHaveBeenCalledWith('customer_context_command',{p_user:uid,p_session:sid,p_input:{action:'READ',ids:[uid]}});
 expect(await result.text()).not.toContain(token);
});
it('returns native credentials only after verified identity and live session authorization; no usage is spent', async () => {
  const response = await login(); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({userId:uid,accessToken:token,refreshToken:'synthetic-native-refresh'});
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('set-cookie')).toBeNull();
  expect(rpc).toHaveBeenCalledWith('customer_authorize',{p_user_id:uid,p_session_id:sid});
  expect(rpc.mock.calls.filter(call=>call[0]==='customer_auth_rate_limit')).toHaveLength(2);
  expect(rpc.mock.calls.some(call=>call[0]==='customer_usage_command')).toBe(false);
});
it('fails closed on non-staging configuration, disabled accounts and browser credential requests', async () => {
  for (const headers of [{origin}, {cookie:'anything'}, {'sec-fetch-site':'same-origin'}]) {
    expect((await handleNativeAccount(request('login',{},headers),'login')).status).toBe(403);
  }
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://bzccuqforilpifhiysjk.supabase.co'); expect((await login()).status).toBe(503);
  vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','false'); expect((await login()).status).toBe(503);
});
it('refuses unverified, suspended and revoked users without returning credentials', async () => {
  auth.getUser.mockResolvedValueOnce({data:{user:{...user,email_confirmed_at:''}},error:null});
  const unverified = await login(); expect(unverified.status).toBe(401); expect(await unverified.text()).not.toContain(token);
  for (const code of ['SUSPENDED','UNAUTHENTICATED']) {
    rpc.mockImplementation(async name=>({data:name==='customer_auth_rate_limit'?true:{code},error:null,status:200}));
    expect((await login()).status).toBe(code==='SUSPENDED'?403:401);
  }
});
it('does not allow native caller to choose identity, entitlement or spend operation', async () => {
  expect((await handleNativeAccount(request('login',{email:user.email,password:'synthetic-password',userId:uid}),'login')).status).toBe(400);
  expect((await handleNativeAccount(request('start',{userId:uid}),'start')).status).toBe(404);
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
});
it('refreshes through Auth and returns no browser cookies', async () => {
  const response = await handleNativeAccount(request('refresh',{refreshToken:'synthetic-native-refresh'}),'refresh');
  expect(response.status).toBe(200); expect(auth.refreshSession).toHaveBeenCalledWith({refresh_token:'synthetic-native-refresh'});
  expect(response.headers.get('set-cookie')).toBeNull();
});
it('passes a 12-character opaque refresh token to Auth and still checks verified live ownership', async () => {
  const response = await handleNativeAccount(request('refresh',{refreshToken:'abcdefghijkl'}),'refresh');
  expect(response.status).toBe(200);
  expect(auth.refreshSession).toHaveBeenCalledWith({refresh_token:'abcdefghijkl'});
  expect(rpc).toHaveBeenCalledWith('customer_authorize',{p_user_id:uid,p_session_id:sid});
  auth.refreshSession.mockResolvedValueOnce({data:{session:null},error:{status:400,message:'sensitive-auth-error'}} as never);
  const denied=await handleNativeAccount(request('refresh',{refreshToken:'abcdefghijkl'}),'refresh');
  expect(denied.status).toBe(401);expect(await denied.text()).toBe('{"error":"UNAUTHENTICATED"}');
});
it('rejects empty/oversized refresh credentials before Auth without accepting caller identities', async () => {
  for(const refreshToken of ['', 'x'.repeat(12001)]){
    expect((await handleNativeAccount(request('refresh',{refreshToken}),'refresh')).status).toBe(400);
  }
  expect((await handleNativeAccount(request('refresh',{refreshToken:'abcdefghijkl',userId:uid}),'refresh')).status).toBe(400);
  expect(auth.refreshSession).not.toHaveBeenCalled();
});
it('exchanges only a PKCE-bound code in native main, with no supplied user or redirect authority',async()=>{
 const verifier='v'.repeat(64),response=await handleNativeAccount(request('oauth-exchange',{code:'synthetic-one-use-code',verifier}),'oauth-exchange');
 expect(response.status).toBe(200);expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('synthetic-one-use-code');
 expect(mocks.clients).toHaveBeenLastCalledWith(expect.anything(),{'sr-account-code-verifier':JSON.stringify(verifier)});
 expect(response.headers.get('set-cookie')).toBeNull();
 expect((await handleNativeAccount(request('oauth-exchange',{code:'code',verifier:'short'}),'oauth-exchange')).status).toBe(400);
 expect((await handleNativeAccount(request('oauth-exchange',{code:'code',verifier,redirect:'https://bad.invalid'}),'oauth-exchange')).status).toBe(400);
});
it('exposes safe balance state and requires authenticated ownership for logout scopes', async () => {
  expect((await handleNativeAccount(request('session'),'session')).status).toBe(401);
  const response = await handleNativeAccount(request('session',{}, {authorization:`Bearer ${token}`}), 'session');
  expect(response.status).toBe(200); expect(await response.text()).not.toContain(token);
  for (const allDevices of [false,true]) {
    expect((await handleNativeAccount(request('logout',{allDevices},{authorization:`Bearer ${token}`}), 'logout')).status).toBe(200);
    expect(signOut).toHaveBeenLastCalledWith(token,allDevices?'global':'local');
  }
});
it('does not expose upstream errors or provider secrets and reports transient auth failure as unavailable', async () => {
  auth.signInWithPassword.mockResolvedValueOnce({data:{session:null},error:{status:503,message:'private-upstream-payload'}} as never);
  const response = await login(); expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"UNAVAILABLE"}');
});
