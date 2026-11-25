import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleNativeAccount } from '../lib/accounts/native';
const mocks = vi.hoisted(() => ({ clients: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));

const origin = 'https://www.clueraai.in', uid = '00000000-0000-4000-8000-000000000001', sid = '00000000-0000-4000-8000-000000000002', doc = '00000000-0000-4000-8000-000000000003';
const token = `header.${Buffer.from(JSON.stringify({ sub: uid, session_id: sid, iss: 'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1', aud: 'authenticated',
  role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic`;
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const [key, value] of Object.entries({ SIGMAROUND_ACCOUNTS_ENABLED: 'true', SIGMAROUND_ACCOUNT_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: 'https://yhnqlfcgrmckhyjdxegg.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_public_key_00000000000000000', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic-service-key-placeholder',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'), SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: Buffer.alloc(32, 4).toString('base64') })) vi.stubEnv(key, value);
  rpc = vi.fn(async (name: string) => ({ error: null, data: name === 'customer_auth_rate_limit' ? true
    : name === 'customer_phone_session_command' ? { code: 'ACTIVE', sessions: [{ id: doc }] }
    : { code: 'ACTIVE', userId: uid, trialSecondsGranted: 900, remoteDesktop: false } }));
  mocks.clients.mockReturnValue({ auth: { auth: { getUser: vi.fn(async () => ({ data: { user: { id: uid, email: 'synthetic@example.invalid', email_confirmed_at: '2026-10-09' } }, error: null })) } }, service: { rpc } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const call = (body: object, headers: Record<string, string> = { authorization: `Bearer ${token}` }, method = 'POST') =>
  handleNativeAccount(new Request(`${origin}/api/account/native/phone-sessions`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), 'phone-sessions');

it('lets the Windows app list and read the phone sessions of the signed-in account', async () => {
  const listed = await call({ action: 'LIST' });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ code: 'ACTIVE', sessions: [{ id: doc }] });
  expect(rpc).toHaveBeenCalledWith('customer_phone_session_command', { p_user: uid, p_session: sid, p_input: { action: 'LIST' } });
  expect((await call({ action: 'READ', id: doc })).status).toBe(200);
  expect(rpc).toHaveBeenLastCalledWith('customer_phone_session_command', { p_user: uid, p_session: sid, p_input: { action: 'READ', id: doc } });
});

it('keeps saving and deleting on the website: the Windows app can only read', async () => {
  rpc.mockClear();
  for (const body of [{ action: 'DELETE', id: doc }, { action: 'SAVE', id: doc }, { action: 'READ' }, {}, []]) expect((await call(body)).status).toBe(400);
  expect(rpc.mock.calls.some(item => item[0] === 'customer_phone_session_command')).toBe(false);
});

it('needs a live sign-in and refuses browser credentials and other methods', async () => {
  expect((await call({ action: 'LIST' }, {})).status).toBe(401);
  for (const headers of [{ origin }, { cookie: 'synthetic' }, { 'sec-fetch-site': 'same-origin' }]) expect((await call({ action: 'LIST' }, { authorization: `Bearer ${token}`, ...headers })).status).toBe(403);
  expect((await call({}, { authorization: `Bearer ${token}` }, 'GET')).status).toBe(404);
});
