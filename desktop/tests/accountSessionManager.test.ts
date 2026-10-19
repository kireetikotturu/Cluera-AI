import { afterEach, expect, it, vi } from 'vitest';
import { AccountSessionManager } from '../src/main/accounts/AccountSessionManager';
import { AccountApi, AccountApiError } from '../src/main/accounts/AccountApi';

const userId = '00000000-0000-4000-8000-000000000001';
const tokens = { userId, accessToken: 'synthetic-access-token-only', refreshToken: 'synthetic-refresh-token-only', validForMilliseconds: 3600000 };
const snapshot = { account: { userId, email: 'customer@example.invalid' },
  usage: { code: 'ACTIVE', availableMilliseconds: 900000, reservedMilliseconds: 0, spentMilliseconds: 0 } };
const input = { email: snapshot.account.email, password: 'synthetic-password' };
const managers: AccountSessionManager[] = [];
function fixture() {
  let saved: unknown = null;
  const store = { read: vi.fn(async () => saved), write: vi.fn(async (value: unknown) => { saved = value; }),
    clear: vi.fn(async () => { saved = null; }) };
  const api = { login: vi.fn(async () => tokens), refresh: vi.fn(async () => ({ ...tokens, refreshToken: 'rotated-synthetic-refresh' })),
    snapshot: vi.fn(async () => snapshot), logout: vi.fn(async () => undefined) };
  const changed = vi.fn();
  const manager = new AccountSessionManager(store, api as unknown as AccountApi, changed);
  managers.push(manager); return { manager, store, api, changed, saved: () => saved };
}
afterEach(() => { managers.splice(0).forEach(manager => manager.dispose()); vi.useRealTimers(); });
it('fresh state is signed out with no refresh, ledger write or timer', async () => {
  const f = fixture(); expect((await f.manager.restore()).state).toBe('signed-out');
  expect(f.api.refresh).not.toHaveBeenCalled(); expect(f.api.snapshot).not.toHaveBeenCalled();
});
it('stores only refresh material and returns safe balance state', async () => {
  const f = fixture(); const view = await f.manager.login(input);
  expect(view).toMatchObject({ state: 'active', availableMilliseconds: 900000 });
  expect(f.saved()).toEqual({ version: 1, userId, refreshToken: tokens.refreshToken });
  expect(JSON.stringify([view, f.changed.mock.calls])).not.toContain(tokens.accessToken);
  expect(JSON.stringify([view, f.changed.mock.calls])).not.toContain(tokens.refreshToken);
  expect(JSON.stringify(f.saved())).not.toContain(input.password);
});
it('serializes refresh requests, persists rotation, and does not poll balance', async () => {
  const f = fixture(); await f.manager.login(input); f.api.snapshot.mockClear();
  const first = f.manager.restore(), second = f.manager.restore(); expect(first).toBe(second);
  await first; expect(f.api.refresh).toHaveBeenCalledOnce(); expect(f.api.snapshot).toHaveBeenCalledOnce();
  expect(f.saved()).toMatchObject({ refreshToken: 'rotated-synthetic-refresh' });
});
it('logout aborts active work immediately, clears saved material and requests correct scope', async () => {
  const f = fixture(); await f.manager.login(input); const capability = await f.manager.authorizeWork();
  const ending = f.manager.logout(true); expect(capability.signal.aborted).toBe(true);
  await ending; expect(f.saved()).toBeNull(); expect(f.api.logout).toHaveBeenCalledWith(tokens.accessToken, true);
  await expect(f.manager.authorizeWork()).rejects.toThrow();
});
it('late login response cannot resurrect a logged-out owner', async () => {
  const f = fixture(); let finish!: (value: typeof tokens) => void;
  f.api.login.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const login = f.manager.login(input); await f.manager.logout(); finish(tokens); await login;
  expect(f.manager.status().state).toBe('signed-out'); expect(f.saved()).toBeNull(); expect(f.store.write).not.toHaveBeenCalled();
});
it('logout waits for an in-flight encrypted write and then removes it', async () => {
  const f = fixture(); let finish!: () => void; const original = f.store.write.getMockImplementation()!;
  f.store.write.mockImplementation(async value => { await new Promise<void>(resolve => { finish = resolve; }); await original(value); });
  const login = f.manager.login(input); await vi.waitFor(() => expect(f.store.write).toHaveBeenCalled());
  const ending = f.manager.logout(); finish(); await Promise.all([login, ending]);
  expect(f.saved()).toBeNull(); expect(f.manager.status().state).toBe('signed-out');
});
it('network failure stops owned work without labeling it revocation or discarding refresh', async () => {
  const f = fixture(); await f.manager.login(input); const work = await f.manager.authorizeWork();
  f.api.refresh.mockRejectedValueOnce(new AccountApiError(503));
  expect((await f.manager.restore()).state).toBe('unavailable'); expect(work.signal.aborted).toBe(true);
  expect(f.saved()).not.toBeNull(); expect((await f.manager.restore()).state).toBe('active');
});
it('revoked refresh clears storage; suspension stops access without a false active state', async () => {
  for (const status of [401, 403]) {
    const f = fixture(); await f.manager.login(input); f.api.refresh.mockRejectedValueOnce(new AccountApiError(status));
    expect((await f.manager.restore()).state).toBe(status === 401 ? 'signed-out' : 'suspended');
    if (status === 401) expect(f.saved()).toBeNull();
    await expect(f.manager.authorizeWork()).rejects.toThrow();
  }
});
it('rejects identity changes during refresh', async () => {
  const f = fixture(); await f.manager.login(input);
  f.api.refresh.mockResolvedValueOnce({ ...tokens, userId: '00000000-0000-4000-8000-000000000002' });
  expect((await f.manager.restore()).state).toBe('signed-out'); expect(f.saved()).toBeNull();
});
it('storage encryption failure fails closed and only exposes bounded errors', async () => {
  const f = fixture(); f.store.write.mockRejectedValueOnce(new Error('sensitive-store-details'));
  const view = await f.manager.login(input); expect(view.state).toBe('unavailable');
  expect(JSON.stringify(view)).not.toContain('sensitive'); await expect(f.manager.authorizeWork()).rejects.toThrow();
});
it('token deadline terminates work even while refresh is stuck', async () => {
  vi.useFakeTimers(); const f = fixture(); f.api.login.mockResolvedValueOnce({ ...tokens, validForMilliseconds: 2000 });
  await f.manager.login(input); const work = await f.manager.authorizeWork();
  f.api.refresh.mockImplementation(() => new Promise(() => undefined));
  await vi.advanceTimersByTimeAsync(2001); expect(work.signal.aborted).toBe(true); expect(f.manager.status().state).toBe('unavailable');
});
it('does not claim all-device revocation when offline, but still ends local access', async () => {
  const f = fixture(); await f.manager.login(input); f.api.logout.mockRejectedValueOnce(new Error('private failure'));
  const view = await f.manager.logout(true); expect(view.state).toBe('signed-out'); expect(view.message).toContain('could not be fully confirmed');
  expect(f.saved()).toBeNull();
});
it('bounds API bodies, redirects and errors without logging credentials', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify(tokens)));
  const api = new AccountApi(request as typeof fetch); await api.login(input);
  expect(request).toHaveBeenCalledWith('https://cluera-ai-staging.vercel.app/api/account/native/login', expect.objectContaining({ redirect: 'error', credentials: 'omit' }));
  request.mockResolvedValueOnce(new Response('x'.repeat(40001)));
  await expect(api.login(input)).rejects.toThrow('Account service is unavailable.');
  request.mockResolvedValueOnce(new Response(JSON.stringify({ ...tokens, privateSecret: 'do-not-expose' })));
  await expect(api.login(input)).rejects.toThrow('Account service is unavailable.');
});
it('accepts opaque 12-character refresh tokens through login, rotation and process restart', async () => {
  let saved: unknown = null;
  const store = { read: async () => saved, write: async (value: unknown) => { saved = value; }, clear: async () => { saved = null; } };
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return new Response(JSON.stringify(snapshot));
    const refresh = String(url).endsWith('/refresh');
    if (refresh) expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'abcdefghijkl' });
    return new Response(JSON.stringify({ ...tokens, refreshToken: refresh ? 'mnopqrstuvwx' : 'abcdefghijkl' }));
  });
  const api = new AccountApi(request as typeof fetch);
  const first = new AccountSessionManager(store, api); managers.push(first);
  expect((await first.login(input)).state).toBe('active');
  expect(saved).toEqual({ version: 1, userId, refreshToken: 'abcdefghijkl' });
  first.dispose();
  const restarted = new AccountSessionManager(store, api); managers.push(restarted);
  const restored = await restarted.restore();
  expect(restored).toMatchObject({ state: 'active', userId });
  expect(saved).toEqual({ version: 1, userId, refreshToken: 'mnopqrstuvwx' });
  expect(JSON.stringify(restored)).not.toMatch(/abcdefghijkl|mnopqrstuvwx|synthetic-access/);
  await restarted.logout(); expect(saved).toBeNull();
});
it.each(['', 'x'.repeat(12001)])('rejects invalid bounded refresh responses without exposing them', async refreshToken => {
  const diagnostic = vi.fn();
  const api = new AccountApi(async () => new Response(JSON.stringify({ ...tokens, refreshToken })), diagnostic);
  await expect(api.login(input)).rejects.toThrow('Account service is unavailable.');
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ operation: 'login', cause: 'response_schema_invalid', status: 503 });
});
it('keeps access token/strict response validation and diagnostic redaction', async () => {
  const diagnostic = vi.fn();
  const request = vi.fn(async () => new Response(JSON.stringify({ ...tokens, accessToken: 'short', refreshToken: 'abcdefghijkl' })));
  const api = new AccountApi(request as typeof fetch, diagnostic);
  await expect(api.oauthExchange('private-code', 'v'.repeat(64))).rejects.toThrow();
  expect(diagnostic).toHaveBeenLastCalledWith({ operation: 'oauth-exchange', cause: 'response_schema_invalid', status: 503 });
  request.mockRejectedValueOnce(new Error('private-upstream-token-password'));
  await expect(api.login(input)).rejects.toThrow();
  expect(diagnostic).toHaveBeenLastCalledWith({ operation: 'login', cause: 'request_or_response_failed', status: 503 });
  const text = JSON.stringify(diagnostic.mock.calls);
  for (const privateValue of ['private-code', input.password, input.email, tokens.accessToken, tokens.refreshToken, 'private-upstream']) {
    expect(text).not.toContain(privateValue);
  }
});
it('invalid Auth credentials remain signed-out rather than a service failure', async () => {
  const diagnostic = vi.fn();
  const api = new AccountApi(async () => new Response('{"error":"UNAUTHENTICATED"}', { status: 401 }), diagnostic);
  const f = fixture(); const manager = new AccountSessionManager(f.store, api); managers.push(manager);
  expect(await manager.login(input)).toMatchObject({ state: 'signed-out', message: 'Sign in with a verified email to continue.' });
  expect(diagnostic).not.toHaveBeenCalled(); expect(f.saved()).toBeNull();
});
it('reads only the bounded public capability endpoint and rejects extra or malformed fields', async () => {
  const request=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>Response.json({google:'enabled'})),diagnostic=vi.fn();
  const api=new AccountApi(request as typeof fetch,diagnostic);
  expect(await api.authOptions()).toEqual({google:'enabled'});
  expect(request).toHaveBeenCalledWith('https://cluera-ai-staging.vercel.app/api/account/auth-options',expect.objectContaining({method:'GET',credentials:'omit',redirect:'error',cache:'no-store'}));
  expect(request.mock.calls[0][1]).not.toHaveProperty('body');
  expect(request.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
  request.mockResolvedValueOnce(Response.json({google:'enabled',accessToken:'private'}));
  await expect(api.authOptions()).rejects.toThrow('Account service is unavailable.');
  expect(diagnostic).toHaveBeenCalledWith({operation:'auth-options',cause:'response_schema_invalid',status:503});
});
