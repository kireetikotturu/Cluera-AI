import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountConfig } from '../lib/accounts/config';
import { AccountCookies, seal, unseal } from '../lib/accounts/cookies';
import { handleAccount } from '../lib/accounts/handler';
import {accountAdminRequest} from '../lib/accounts/admin';
const mocks = vi.hoisted(() => ({ clients: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));
const uid = '00000000-0000-4000-8000-000000000001', sid = '00000000-0000-4000-8000-000000000002';
const token = `header.${Buffer.from(JSON.stringify({ sub: uid, session_id: sid })).toString('base64url')}.synthetic`;
const session = { access_token: token, refresh_token: 'synthetic-refresh-credential', expires_in: 3600 };
let auth: ReturnType<typeof makeAuth>; let rpc: ReturnType<typeof vi.fn>; let signOut: ReturnType<typeof vi.fn>;
const user = { id: uid, email: 'account@example.invalid', email_confirmed_at: '2026-10-03T00:00:00Z', is_anonymous: false };
function makeAuth() {
  return { mfa:{listFactors:vi.fn(async()=>({data:{all:[]},error:null}))},getUser: vi.fn(async () => ({ data: { user }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { session }, error: null })),
    setSession: vi.fn(async () => ({ data: { session }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session }, error: null })),
    exchangeCodeForSession: vi.fn(async () => ({ data: { session }, error: null })),
    signUp: vi.fn(async () => ({ error: null })), resend:vi.fn(async()=>({error:null})), resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    updateUser: vi.fn(async () => ({ error: null })),
    signInWithOAuth: vi.fn(async () => ({ data: { url: 'https://dwqltsqumiwsxtkzdoaa.supabase.co/auth/v1/authorize?provider=google' }, error: null })) };
}
beforeEach(() => {
  vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED', 'true'); vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN', 'https://cluera-ai-staging.vercel.app');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://dwqltsqumiwsxtkzdoaa.supabase.co'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_synthetic_public_key_00000000000000000');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-placeholder');
  vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64', Buffer.alloc(32, 3).toString('base64'));
  vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64', Buffer.alloc(32, 4).toString('base64'));
  auth = makeAuth(); signOut = vi.fn(async () => ({ error: null }));
  rpc = vi.fn(async (name: string) => ({ data: name === 'customer_auth_rate_limit' ? true : {
    code: 'ACTIVE', userId: uid, trialSecondsGranted: 900, remoteDesktop: false }, error: null, status: 200 }));
  mocks.clients.mockReturnValue({ auth: { auth }, service: { rpc, auth: { admin: { signOut } } },
    flow: () => ({ 'sr-account-code-verifier': 'synthetic-pkce-only' }), recovery: () => true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function request(action: string, body: object = {}, cookie = '', method = 'POST', origin = 'https://cluera-ai-staging.vercel.app') {
  return new Request(`https://cluera-ai-staging.vercel.app/api/account/${action}`, { method, headers: { origin, cookie, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
function cookiePair(kind: 'access' | 'refresh' | 'recovery' | 'flow', value: unknown) {
  return `__Host-sr-account-${kind}=${seal(value, kind, accountConfig(), 3600)}`;
}
const login = () => handleAccount(request('login', { email: user.email, password: 'synthetic-password' }), 'login');
describe('customer BFF authentication', () => {
  it('resends only signup verification with sealed fresh PKCE, no account grant or token DTO',async()=>{
    const response=await handleAccount(request('resend-verification',{email:user.email}),'resend-verification');
    expect(response.status).toBe(200);expect(auth.resend).toHaveBeenCalledExactlyOnceWith({type:'signup',email:user.email,options:{emailRedirectTo:'https://cluera-ai-staging.vercel.app/api/account/callback'}});
    expect(response.headers.get('set-cookie')).toContain('__Host-sr-account-flow=');expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    const body=await response.text();expect(body).toContain('If this request is eligible');expect(body).not.toContain('synthetic-pkce-only');
    expect(rpc.mock.calls.every(([name])=>name==='customer_auth_rate_limit')).toBe(true);expect(auth.signUp).not.toHaveBeenCalled();expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it('does not enumerate verification eligibility, and distinguishes transport failure',async()=>{
    auth.resend.mockResolvedValueOnce({error:{status:400,message:'private-user-status'}} as never);
    const rejected=await handleAccount(request('resend-verification',{email:user.email}),'resend-verification');
    expect(rejected.status).toBe(200);expect(await rejected.text()).not.toContain('private-user-status');
    auth.resend.mockResolvedValueOnce({error:{status:503,message:'private-provider-status'}} as never);
    const failed=await handleAccount(request('resend-verification',{email:user.email}),'resend-verification');expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('private-provider-status');
  });
  it('rejects foreign-origin, malformed and throttled resend before sending mail',async()=>{
    expect((await handleAccount(request('resend-verification',{email:user.email},'','POST','https://foreign.invalid'),'resend-verification')).status).toBe(403);
    expect((await handleAccount(request('resend-verification',{email:user.email,password:'must-not-accept'}),'resend-verification')).status).toBe(400);
    rpc.mockResolvedValue({data:false,error:null});expect((await handleAccount(request('resend-verification',{email:user.email}),'resend-verification')).status).toBe(429);
    expect(auth.resend).not.toHaveBeenCalled();
  });
  it('exposes only the verified account balance and never exposes public spending operations', async () => {
    vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN','https://cluera-ai-staging.vercel.app');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://dwqltsqumiwsxtkzdoaa.supabase.co');
    const original=rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name,args) => name==='customer_usage_balance'
      ? {data:{code:'ACTIVE',availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0},error:null}
      : original(name,args));
    expect((await handleAccount(request('usage',{},'', 'GET'),'usage')).status).toBe(401);
    const cookies=`${cookiePair('access',token)}; ${cookiePair('refresh',session.refresh_token)}`;
    const result=await handleAccount(request('usage',{},cookies,'GET'),'usage');
    expect(result.status).toBe(200); expect(await result.json()).toEqual({usage:{code:'ACTIVE',availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0}});
    expect(rpc).toHaveBeenCalledWith('customer_usage_balance',{p_user_id:uid,p_session_id:sid});
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await handleAccount(request('usage',{action:'START',userId:uid},cookies,'POST','https://cluera-ai-staging.vercel.app'),'usage')).status).toBe(404);
    expect(rpc.mock.calls.some(call=>call[0]==='customer_usage_command')).toBe(false);
  });
  it('fails closed while disabled without provider or database access', async () => {
    vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED', 'false');
    expect((await login()).status).toBe(503); expect(mocks.clients).not.toHaveBeenCalled();
  });
  it('rejects cross-origin POST before any authentication/network call', async () => {
    expect((await handleAccount(request('login', {}, '', 'POST', 'https://attacker.invalid'), 'login')).status).toBe(403);
    expect(auth.signInWithPassword).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('logs in using verified identity and encrypted HttpOnly cookies only', async () => {
    const response = await login(); expect(response.status).toBe(200);
    const body = await response.text(); const cookies = response.headers.get('set-cookie')!;
    expect(JSON.parse(body).account).toMatchObject({ userId: uid, trialSecondsGranted: 900, remoteDesktop: false });
    for (const secret of [token, session.refresh_token, 'synthetic-service-placeholder']) {
      expect(body).not.toContain(secret); expect(cookies).not.toContain(secret);
    }
    expect(cookies).toContain('HttpOnly'); expect(cookies).toContain('Secure'); expect(cookies).toContain('SameSite=Lax');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).toHaveBeenCalledWith('customer_authorize', { p_user_id: uid, p_session_id: sid });
  });
  it('cannot obtain access for unverified emails, forged metadata or revoked sessions', async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: { ...user, email_confirmed_at: '' } }, error: null });
    expect((await login()).status).toBe(401);
    rpc.mockImplementation(async name => ({ data: name === 'customer_auth_rate_limit' ? true : { code: 'UNAUTHENTICATED' }, error: null }));
    expect((await login()).status).toBe(401);
  });
  it('denies suspended accounts and throttles before sign-in', async () => {
    rpc.mockImplementation(async name => ({ data: name === 'customer_auth_rate_limit' ? true : { code: 'SUSPENDED' }, error: null }));
    expect((await login()).status).toBe(403);
    auth.signInWithPassword.mockClear(); rpc.mockResolvedValue({ data: false, error: null });
    expect((await login()).status).toBe(429); expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it('keeps authentication cookies on temporary upstream failure and never logs raw errors', async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 503, message: 'private-upstream-error' } } as never);
    const cookies = `${cookiePair('access', token)}; ${cookiePair('refresh', session.refresh_token)}`;
    const response = await handleAccount(request('session', {}, cookies, 'GET'), 'session');
    expect(response.status).toBe(503); expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('private-upstream-error');
    expect(auth.setSession).not.toHaveBeenCalled(); expect(auth.refreshSession).not.toHaveBeenCalled();
  });
  it('refreshes an expired access cookie, revalidates the same live owner/session and seals rotated material', async () => {
    const expired = `header.${Buffer.from(JSON.stringify({sub:uid,session_id:sid,exp:Math.floor(Date.now()/1000)-1,aal:'aal2'})).toString('base64url')}.synthetic`;
    auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
    const cookies = `${cookiePair('access',expired)}; ${cookiePair('refresh',session.refresh_token)}`;
    const response = await handleAccount(request('session',{},cookies,'GET'),'session');
    expect(response.status).toBe(200);
    expect(auth.refreshSession).toHaveBeenCalledExactlyOnceWith({refresh_token:session.refresh_token});
    expect(auth.getUser.mock.calls.map(call=>call[0])).toEqual([expired,token]);
    expect(rpc).toHaveBeenCalledWith('customer_authorize',{p_user_id:uid,p_session_id:sid});
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await response.text()).not.toContain(session.refresh_token);
  });
  it('does not refresh a non-expired denial, and rejects refreshed owner or session changes', async () => {
    auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
    const cookies = `${cookiePair('access',token)}; ${cookiePair('refresh',session.refresh_token)}`;
    expect((await handleAccount(request('session',{},cookies,'GET'),'session')).status).toBe(401);
    expect(auth.refreshSession).not.toHaveBeenCalled();
    for(const changed of [{sub:'00000000-0000-4000-8000-000000000003',session_id:sid},{sub:uid,session_id:'00000000-0000-4000-8000-000000000003'}]){
      const expired = `header.${Buffer.from(JSON.stringify({...changed,exp:1})).toString('base64url')}.synthetic`;
      auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
      const result=await handleAccount(request('session',{},`${cookiePair('access',expired)}; ${cookiePair('refresh',session.refresh_token)}`,'GET'),'session');
      expect(result.status).toBe(401);expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });
  it('does not inherit AAL2 from an expired Admin cookie after refresh and persists valid rotated cookies',async()=>{
    vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN','https://cluera-ai-staging.vercel.app');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://dwqltsqumiwsxtkzdoaa.supabase.co');
    const expired=`header.${Buffer.from(JSON.stringify({sub:uid,session_id:sid,exp:1,aal:'aal2'})).toString('base64url')}.synthetic`;
    auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
    const original=rpc.getMockImplementation()!;
    rpc.mockImplementation(async(name,args)=>name==='account_admin_check'?{data:true,error:null,status:200}:original(name,args));
    const result=await accountAdminRequest(new Request('https://cluera-ai-staging.vercel.app/api/account/admin',{headers:{cookie:`${cookiePair('access',expired)}; ${cookiePair('refresh',session.refresh_token)}`}}));
    expect(await result.json()).toEqual({needsMfa:true,factors:[]});
    expect(result.headers.get('set-cookie')).toContain('HttpOnly');
    expect(rpc.mock.calls.some(call=>call[0]==='account_admin_read_v2'||(call[0]==='account_admin_check'&&call[1]?.p_require_mfa===true))).toBe(false);
  });
  it('fails closed on expired-cookie refresh failure, unverified identity or suspension',async()=>{
    const expired=`header.${Buffer.from(JSON.stringify({sub:uid,session_id:sid,exp:1})).toString('base64url')}.synthetic`;
    const cookies=`${cookiePair('access',expired)}; ${cookiePair('refresh',session.refresh_token)}`;
    auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
    auth.refreshSession.mockResolvedValueOnce({data:{session:null},error:{status:503}} as never);
    const outage=await handleAccount(request('session',{},cookies,'GET'),'session');
    expect(outage.status).toBe(503);expect(outage.headers.get('set-cookie')).toBeNull();
    auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never)
      .mockResolvedValueOnce({data:{user:{...user,email_confirmed_at:''}},error:null});
    expect((await handleAccount(request('session',{},cookies,'GET'),'session')).status).toBe(401);
    auth.getUser.mockResolvedValueOnce({data:{user:null},error:{status:401}} as never);
    rpc.mockResolvedValueOnce({data:{code:'SUSPENDED'},error:null,status:200});
    expect((await handleAccount(request('session',{},cookies,'GET'),'session')).status).toBe(403);
  });
  it('does not allow browser-supplied user, tier or trial amount', async () => {
    const response = await handleAccount(request('signup', { email: user.email, password: 'synthetic-password', trialSeconds: 99999 }), 'signup');
    expect(response.status).toBe(400); expect(auth.signUp).not.toHaveBeenCalled();
  });
  it('uses generic signup/reset responses and fixed redirect origins', async () => {
    for (const action of ['signup', 'forgot-password']) {
      const response = await handleAccount(request(action, { email: user.email, ...(action === 'signup' ? { password: 'synthetic-password' } : {}) }), action);
      expect(response.status).toBe(200); expect(await response.text()).not.toContain(user.email);
    }
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(user.email, { redirectTo: 'https://cluera-ai-staging.vercel.app/api/account/callback' });
  });
  it('starts only Google via PKCE and requires bound verifier on callback', async () => {
    const start = await handleAccount(request('google'), 'google'); expect(start.status).toBe(200);
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: 'https://cluera-ai-staging.vercel.app/api/account/callback', skipBrowserRedirect: true } });
    const callback = new Request('https://cluera-ai-staging.vercel.app/api/account/callback?code=synthetic');
    expect((await handleAccount(callback, 'callback')).status).toBe(401);
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    const bound = new Request(callback.url, { headers: { cookie: cookiePair('flow', { 'sr-account-code-verifier': 'test' }) } });
    const complete = await handleAccount(bound, 'callback'); expect(complete.status).toBe(303);
    expect(complete.headers.get('location')).toBe('https://cluera-ai-staging.vercel.app/account');
    expect(complete.headers.get('set-cookie')).toContain('sr-account-recovery=');
  });
  it('requires the password-recovery session, updates then revokes sessions', async () => {
    const cookies = `${cookiePair('access', token)}; ${cookiePair('refresh', session.refresh_token)}`;
    expect((await handleAccount(request('reset-password', { password: 'replacement-password' }, cookies), 'reset-password')).status).toBe(403);
    const valid = `${cookies}; ${cookiePair('recovery', sid)}`;
    expect((await handleAccount(request('reset-password', { password: 'replacement-password' }, valid), 'reset-password')).status).toBe(200);
    expect(signOut).toHaveBeenCalledWith(token, 'global');
  });
  it('logout revokes only the current browser session and clears cookies', async () => {
    const response = await handleAccount(request('logout', {}, cookiePair('access', token)), 'logout');
    expect(response.status).toBe(200); expect(signOut).toHaveBeenCalledWith(token, 'local');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('does not expose arbitrary database messages or customer data in diagnostics', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'sensitive-customer-secret' }, status: 403 });
    const response = await login(); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('sensitive-customer-secret');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-customer-secret');
    expect(JSON.stringify(log.mock.calls)).toContain('account.rateLimit'); log.mockRestore();
  });
});
describe('account cookie boundary', () => {
  it('rejects tampering, expiry, wrong purpose and wrong deployment origin', () => {
    const config = accountConfig(), sealed = seal('private', 'access', config, 60, 1000);
    expect(unseal(sealed, 'access', config, 2000)).toBe('private');
    expect(unseal(sealed, 'access', config, 61000)).toBeNull();
    expect(unseal(sealed, 'refresh', config, 2000)).toBeNull();
    expect(unseal(sealed, 'access', { ...config, origin: 'https://elsewhere.invalid' }, 2000)).toBeNull();
    const bytes = Buffer.from(sealed, 'base64url'); bytes[30] ^= 1;
    expect(unseal(bytes.toString('base64url'), 'access', config, 2000)).toBeNull();
    expect(() => seal('x'.repeat(4000), 'access', config, 60)).toThrow();
  });
  it('needs account secrets but not legacy license pepper/signing credentials', () => {
    vi.stubEnv('LICENSE_HASH_PEPPER_BASE64', ''); vi.stubEnv('LICENSE_SIGNING_PRIVATE_KEY_BASE64', '');
    expect(accountConfig().origin).toBe('https://cluera-ai-staging.vercel.app');
    vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN', 'https://cluera-ai-staging.vercel.app/evil');
    expect(() => accountConfig()).toThrow();
  });
  it('never returns raw cookie values from its reader', () => {
    const config = accountConfig(), cookies = new AccountCookies(request('session', {}, cookiePair('refresh', 'fixture')), config);
    expect(cookies.get('refresh')).toBe('fixture'); expect(cookies.get('access')).toBeNull();
  });
});
