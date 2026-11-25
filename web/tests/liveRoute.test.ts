import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ clients: vi.fn(), session: vi.fn(), rate: vi.fn(), origin: vi.fn(), authorize: vi.fn(), save: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));
vi.mock('../lib/accounts/handler', () => ({ activeSession: mocks.session, rateLimit: mocks.rate, assertAccountOrigin: mocks.origin,
  authorizeCustomer: mocks.authorize, saveSession: mocks.save }));
import { liveRequest } from '../lib/accounts/live';
import { AccountError } from '../lib/accounts/config';

const user = '00000000-0000-4000-8000-000000000001', session = '00000000-0000-4000-8000-000000000002', doc = '00000000-0000-4000-8000-000000000003';
const jwt = (secondsFromNow: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url')}.s`;
let rpc: ReturnType<typeof vi.fn>;
let refreshSession: ReturnType<typeof vi.fn>;
const request = (body: object, method = 'POST') => new Request('https://www.clueraai.in/api/account/live', { method, headers: { 'Content-Type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
const saveBody = (extra: object = {}) => ({ action: 'SAVE', id: doc, kind: 'interview', title: 'Java developer · Acme', role: 'Java developer', company: 'Acme',
  model: 'gemini-3.5-flash', setup: { language: 'English' }, turns: [{ id: 'q1', question: 'What is a thread?', answer: 'A unit of execution.', at: '2026-11-25T10:00:00Z', source: 'voice' }],
  startedAt: '2026-11-25T10:00:00Z', endedAt: null, ...extra });

beforeEach(() => {
  vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED', 'true'); vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN', 'https://www.clueraai.in');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://yhnqlfcgrmckhyjdxegg.supabase.co'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_synthetic_public_key_00000000000000000');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_synthetic-service-key-placeholder');
  vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64', Buffer.alloc(32, 3).toString('base64')); vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64', Buffer.alloc(32, 4).toString('base64'));
  rpc = vi.fn(async () => ({ data: { code: 'ACTIVE', sessions: [], documents: [] }, error: null, status: 200 }));
  refreshSession = vi.fn(async () => ({ data: { session: { access_token: jwt(3600), refresh_token: 'synthetic-rotated' } }, error: null }));
  mocks.clients.mockReturnValue({ service: { rpc }, auth: { auth: { refreshSession } } });
  mocks.session.mockResolvedValue({ session: { access_token: jwt(3000), refresh_token: 'synthetic-refresh' }, account: { userId: user, sessionId: session, email: 'synthetic@example.invalid' } });
  mocks.rate.mockResolvedValue(undefined); mocks.authorize.mockResolvedValue({ userId: user, sessionId: session, email: 'synthetic@example.invalid' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('hands the signed-in browser its own short-lived access token and the relay address, and nothing else', async () => {
  const response = await liveRequest(request({ action: 'ACCESS' }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresInMs', 'relayEndpoint', 'userId']);
  expect(body.relayEndpoint).toBe('wss://cluera-ai-relay-staging.onrender.com/v1/session');
  expect(body.userId).toBe(user);
  expect(body.expiresInMs).toBeGreaterThan(2_900_000);
  expect(body.expiresInMs).toBeLessThanOrEqual(3_600_000);
  expect(refreshSession).not.toHaveBeenCalled();
  expect(mocks.rate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'synthetic@example.invalid', 'billing-read');
});

it('renews a sign-in that is about to end first, so the live connection does not stop at once', async () => {
  mocks.session.mockResolvedValue({ session: { access_token: jwt(40), refresh_token: 'synthetic-refresh' }, account: { userId: user, sessionId: session, email: 'a@example.invalid' } });
  const response = await liveRequest(request({ action: 'ACCESS' }));
  expect(response.status).toBe(200);
  expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'synthetic-refresh' });
  expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), expect.any(String), { userId: user, sessionId: session });
  expect(mocks.save).toHaveBeenCalledOnce();
  expect((await response.json()).expiresInMs).toBeGreaterThan(3_000_000);
});

it('refuses when the sign-in cannot be renewed', async () => {
  mocks.session.mockResolvedValue({ session: { access_token: jwt(40), refresh_token: 'synthetic-refresh' }, account: { userId: user, sessionId: session, email: 'a@example.invalid' } });
  refreshSession.mockResolvedValue({ data: { session: null }, error: { status: 400 } });
  expect((await liveRequest(request({ action: 'ACCESS' }))).status).toBe(401);
});

it('refuses other websites, signed-out visitors and anything but POST before touching the database', async () => {
  mocks.origin.mockImplementationOnce(() => { throw new AccountError('FORBIDDEN', 403); });
  expect((await liveRequest(request({ action: 'ACCESS' }))).status).toBe(403);
  expect(mocks.session).not.toHaveBeenCalled();
  mocks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED', 401));
  expect((await liveRequest(request({ action: 'ACCESS' }))).status).toBe(401);
  expect((await liveRequest(request({}, 'GET'))).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});

it('reads only the chosen saved documents, for the verified account', async () => {
  rpc.mockResolvedValueOnce({ data: { code: 'ACTIVE', documents: [{ id: doc, kind: 'RESUME', name: 'CV', bytes: 12, body: 'Ravi Kumar' }] }, error: null });
  const response = await liveRequest(request({ action: 'DOCUMENTS', ids: [doc] }));
  expect(response.status).toBe(200);
  expect((await response.json()).documents[0].body).toBe('Ravi Kumar');
  expect(rpc).toHaveBeenCalledWith('customer_context_command', { p_user: user, p_session: session, p_input: { action: 'READ', ids: [doc] } });
  expect((await liveRequest(request({ action: 'DOCUMENTS', ids: Array(9).fill(doc) }))).status).toBe(400);
  expect((await liveRequest(request({ action: 'DOCUMENTS', ids: ['not-an-id'] }))).status).toBe(400);
});

it('saves a phone session for the account in the server-side sign-in, never one named by the page', async () => {
  const response = await liveRequest(request(saveBody()));
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('customer_phone_session_command', { p_user: user, p_session: session, p_input: expect.objectContaining({ action: 'SAVE', id: doc, kind: 'interview' }) });
  expect(mocks.rate).not.toHaveBeenCalled();
  rpc.mockClear();
  for (const bad of [saveBody({ userId: session }), saveBody({ kind: 'other' }), saveBody({ title: '' }), saveBody({ startedAt: 'yesterday' }),
    saveBody({ turns: Array(301).fill({ id: 'q', question: 'a', answer: 'b', at: 'x' }) }),
    saveBody({ turns: [{ id: 'q', question: 'a', answer: 'b'.repeat(24001), at: 'x' }] }), saveBody({ id: 'nope' })]) {
    expect((await liveRequest(request(bad))).status).toBe(400);
  }
  expect(rpc).not.toHaveBeenCalled();
});

it('lists, reads and deletes only through the owner-checked database function', async () => {
  rpc.mockResolvedValueOnce({ data: { code: 'ACTIVE', sessions: [{ id: doc }] }, error: null });
  expect(await (await liveRequest(request({ action: 'LIST' }))).json()).toEqual({ code: 'ACTIVE', sessions: [{ id: doc }] });
  expect(rpc).toHaveBeenLastCalledWith('customer_phone_session_command', { p_user: user, p_session: session, p_input: { action: 'LIST' } });
  await liveRequest(request({ action: 'READ', id: doc }));
  expect(rpc).toHaveBeenLastCalledWith('customer_phone_session_command', { p_user: user, p_session: session, p_input: { action: 'READ', id: doc } });
  await liveRequest(request({ action: 'DELETE', id: doc }));
  expect(rpc).toHaveBeenLastCalledWith('customer_phone_session_command', { p_user: user, p_session: session, p_input: { action: 'DELETE', id: doc } });
  expect((await liveRequest(request({ action: 'READ' }))).status).toBe(400);
  rpc.mockResolvedValueOnce({ data: { code: 'NOT_FOUND' }, error: null });
  expect((await liveRequest(request({ action: 'READ', id: doc }))).status).toBe(400);
  rpc.mockResolvedValueOnce({ data: { code: 'UNAUTHENTICATED' }, error: null });
  expect((await liveRequest(request({ action: 'LIST' }))).status).toBe(401);
});

it('lists only answer models that are on, with whether each can read photos, and the Admin starting texts', async () => {
  const model = (id: string, extra: object = {}) => ({ modelId: id, displayName: id, provider: 'gemini', enabled: true, isDefault: false, priority: 5,
    capabilities: ['text', 'image'], health: 'HEALTHY', ...extra });
  rpc.mockImplementation(async (name: string) => name === 'account_models_read'
    ? { data: [model('fast-one', { isDefault: true }), model('text-only', { capabilities: ['text'], provider: 'openai' }), model('off', { enabled: false }),
      model('down', { health: 'UNAVAILABLE' }), model('deepgram-x', { provider: 'deepgram', capabilities: ['audio'] })], error: null }
    : name === 'account_session_defaults_read' ? { data: { assignmentModel: 'text-only' }, error: null } : { data: null, error: null });
  const body = await (await liveRequest(request({ action: 'MODELS' }))).json();
  expect(body.models.map((item: { modelId: string }) => item.modelId)).toEqual(['fast-one', 'text-only']);
  expect(body.models.map((item: { image: boolean }) => item.image)).toEqual([true, false]);
  expect(body.sessionDefaults.assignmentModel).toBe('text-only');
  expect(body.sessionDefaults.interviewContext).toContain('direct, clear answers');
});
