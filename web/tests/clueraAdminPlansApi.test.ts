import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clueraPlanAdminRequest } from '../lib/payments/cluera/adminPlans';
import { createLiveBillingScope } from '../lib/payments/cluera/modeProfile';
import { paymentLiveEnvironment } from './helpers/paymentLiveMode';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const mocks = vi.hoisted(() => ({ clients: vi.fn(), session: vi.fn(), limit: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));
vi.mock('../lib/accounts/handler', async original => ({ ...await original<typeof import('../lib/accounts/handler')>(), activeSession: mocks.session, rateLimit: mocks.limit }));
const origin = 'https://cluera-ai-staging.vercel.app', actor = paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS;
const sid = '00000000-0000-4000-8000-000000000002', planId = '00000000-0000-4000-8000-000000000005', revisionId = '00000000-0000-4000-8000-000000000004';
const plan = { planId, revisionId, offerCode: 'cluera_pack_3h_v2', name: 'Cluera 3 Hours', amountPaise: 54900, currency: 'INR', allowanceSeconds: 10800,
  kind: 'PACK', version: 1, enabled: false, archived: false, createdAt: '2026-10-24T00:00:00Z', openCheckouts: 0 };
let rpc: ReturnType<typeof vi.fn>, planResult: unknown;
const liveEnv = () => createLiveBillingScope({ ...paymentLiveEnvironment, CLUERA_LIVE_ADMIN_ENABLED: 'true' } as NodeJS.ProcessEnv);
const url = `${origin}/api/account/payments/cluera/live/plans`;
const get = (query = '', headers: Record<string, string> = {}) => new Request(url + query, { headers });
const post = (body: unknown, headers: Record<string, string> = {}) => new Request(url, { method: 'POST',
  headers: { origin, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const change = (extra: object = {}) => ({ action: 'SET_ENABLED', operationId: crypto.randomUUID(), planId, expectedRevisionId: revisionId, input: { enabled: true }, ...extra });
const token = (aal: string) => `header.${Buffer.from(JSON.stringify({ aal, session_id: sid })).toString('base64url')}.synthetic`;
const planCalls = () => rpc.mock.calls.filter(([name]) => /plan_change|plans_read/.test(name as string));

beforeEach(() => {
  for (const [key, value] of Object.entries({ ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_public_key_00000000000000000',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'), SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: Buffer.alloc(32, 4).toString('base64') }))
    vi.stubEnv(key, value);
  mocks.session.mockResolvedValue({ account: { userId: actor, sessionId: sid, email: 'admin@example.invalid' }, session: { access_token: token('aal2'), refresh_token: 'synthetic-refresh' } });
  mocks.limit.mockResolvedValue(undefined);
  planResult = { code: 'APPLIED', plan: { ...plan, enabled: true } };
  rpc = vi.fn(async (name: string) => ({ error: null, data: name === 'account_admin_check' ? true
    : name === 'cluera_live_billing_plans_read' ? { code: 'ACTIVE', plans: [plan] }
      : name === 'cluera_live_billing_plan_change' ? planResult : null }));
  mocks.clients.mockReturnValue({ service: { rpc }, auth: { auth: {} } });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('lists plans for a signed-in MFA Admin through the Live ledger only, with no provider call and no cache', async () => {
  const response = await clueraPlanAdminRequest(get(), liveEnv());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 'ACTIVE', plans: [plan], history: [] });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['account_admin_check', 'cluera_live_billing_plans_read']);
  expect(rpc.mock.calls[1][1]).toEqual({ p_actor: actor, p_session: sid, p_operation: null });
  expect(fetch).not.toHaveBeenCalled();
});

it('changes a plan with the Admin session alone: no authenticator code, factor or token is read or accepted', async () => {
  const body = change(), response = await clueraPlanAdminRequest(post(body), liveEnv());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 'APPLIED', plan: { ...plan, enabled: true } });
  const call = rpc.mock.calls.find(([name]) => name === 'cluera_live_billing_plan_change')![1];
  expect(call).toEqual({ p_actor: actor, p_session: sid, p_operation: body.operationId, p_action: 'SET_ENABLED', p_plan: planId,
    p_expected_revision: revisionId, p_reason: null, p_input: { enabled: true } });
  for (const extra of [{ code: '123456' }, { factorId: crypto.randomUUID() }, { price: 1 }]) {
    rpc.mockClear();
    const denied = await clueraPlanAdminRequest(post(change(extra)), liveEnv());
    expect(denied.status).toBe(400);
    expect(planCalls()).toHaveLength(0);
  }
});

it('creates, edits, removes and restores with exact server-validated values and an optional reason', async () => {
  const create = { action: 'CREATE', operationId: crypto.randomUUID(), reason: 'Launch offer', input: { name: ' Cluera 10 Hours ', amountPaise: 149900, allowanceSeconds: 36000, enabled: true } };
  expect((await clueraPlanAdminRequest(post(create), liveEnv())).status).toBe(200);
  expect(rpc.mock.calls.find(([name]) => name === 'cluera_live_billing_plan_change')![1]).toMatchObject({
    p_action: 'CREATE', p_plan: null, p_expected_revision: null, p_reason: 'Launch offer',
    p_input: { name: 'Cluera 10 Hours', amountPaise: 149900, allowanceSeconds: 36000, enabled: true } });
  for (const [action, input] of [['EDIT', { name: 'Cluera 4 Hours', amountPaise: 60000, allowanceSeconds: 14400 }], ['ARCHIVE', {}], ['RESTORE', {}]] as const) {
    rpc.mockClear();
    expect((await clueraPlanAdminRequest(post(change({ action, input })), liveEnv())).status).toBe(200);
    expect(rpc.mock.calls.find(([name]) => name === 'cluera_live_billing_plan_change')![1]).toMatchObject({ p_action: action, p_input: input });
  }
});

it.each([
  ['a price below one rupee', { action: 'CREATE', operationId: crypto.randomUUID(), input: { name: 'Cheap', amountPaise: 50, allowanceSeconds: 3600, enabled: true } }],
  ['a fractional price', { action: 'CREATE', operationId: crypto.randomUUID(), input: { name: 'Odd', amountPaise: 150.5, allowanceSeconds: 3600, enabled: true } }],
  ['too little time', { action: 'CREATE', operationId: crypto.randomUUID(), input: { name: 'Short', amountPaise: 5000, allowanceSeconds: 10, enabled: true } }],
  ['a one-letter name', { action: 'CREATE', operationId: crypto.randomUUID(), input: { name: 'x', amountPaise: 5000, allowanceSeconds: 3600, enabled: true } }],
  ['an unknown action', change({ action: 'DELETE' })],
  ['a hard delete field', change({ action: 'ARCHIVE', input: { delete: true } })],
  ['a missing plan', { action: 'EDIT', operationId: crypto.randomUUID(), input: { name: 'Okay', amountPaise: 5000, allowanceSeconds: 3600 } }],
  ['a very long reason', change({ reason: 'x'.repeat(401) })],
])('refuses %s with a plain message and writes nothing', async (_name, body) => {
  const response = await clueraPlanAdminRequest(post(body), liveEnv()), data = await response.json();
  expect(response.status).toBe(400);
  expect(data).toEqual({ code: 'INVALID', message: 'Please check the name, price and hours and try again.' });
  expect(planCalls()).toHaveLength(0);
});

it.each([
  ['a session without MFA', async () => mocks.session.mockResolvedValue({ account: { userId: actor, sessionId: sid, email: 'a@example.invalid' }, session: { access_token: token('aal1') } }), () => post(change()), 403],
  ['a non-admin account', async () => { rpc.mockImplementation(async () => ({ data: false, error: null })); }, () => post(change()), 403],
  ['a foreign origin', async () => undefined, () => post(change(), { origin: 'https://attacker.invalid' }), 403],
  ['a cross-site read', async () => undefined, () => get('', { 'sec-fetch-site': 'cross-site' }), 403],
  ['a non-JSON body', async () => undefined, () => new Request(url, { method: 'POST', headers: { origin, 'Content-Type': 'text/plain' }, body: '{}' }), 400],
])('rejects %s before any plan change', async (_name, arrange, make, status) => {
  await arrange();
  const response = await clueraPlanAdminRequest(make(), liveEnv());
  expect(response.status).toBe(status);
  expect(rpc.mock.calls.some(([rpcName]) => rpcName === 'cluera_live_billing_plan_change')).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it('is unavailable unless Live Admin is enabled, and never serves the Test ledger', async () => {
  // A plain environment object is not a server-created Live scope, so it cannot reach the Live ledger.
  expect((await clueraPlanAdminRequest(get(), { ...paymentLiveEnvironment } as NodeJS.ProcessEnv)).status).toBe(404);
  const scope = createLiveBillingScope({ ...paymentLiveEnvironment, CLUERA_LIVE_ADMIN_ENABLED: 'false' } as NodeJS.ProcessEnv);
  expect((await clueraPlanAdminRequest(get(), scope)).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  ['CONFLICT', 409, 'changed in another window'], ['DUPLICATE_NAME', 409, 'Another plan already has that name'],
  ['ARCHIVED', 409, 'was removed'], ['TOO_MANY_PLANS', 409, 'maximum number of plans'], ['NO_CHANGE', 409, 'Nothing was changed'],
  ['NOT_FOUND', 404, 'no longer exists'], ['FORBIDDEN', 403, 'authenticator'],
])('turns the database answer %s into plain English', async (code, status, text) => {
  planResult = { code };
  const response = await clueraPlanAdminRequest(post(change()), liveEnv()), data = await response.json();
  expect(response.status).toBe(status);
  expect(data.message).toContain(text);
  expect(JSON.stringify(data)).not.toMatch(/sql|rpc|cluera_live_billing/i);
});

it('treats any failure after the write was sent as UNKNOWN, never as a correctable input error', async () => {
  rpc.mockImplementation(async (name: string) => name === 'account_admin_check' ? { data: true, error: null } : { data: null, error: { message: 'timeout' } });
  const lost = await clueraPlanAdminRequest(post(change()), liveEnv());
  expect(lost.status).toBe(503);
  expect((await lost.json()).code).toBe('UNKNOWN');
  planResult = { code: 'APPLIED', plan: { notAPlan: true } };
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'account_admin_check' ? true : planResult }));
  const garbled = await clueraPlanAdminRequest(post(change()), liveEnv());
  expect(garbled.status).toBe(503);
  expect((await garbled.json()).code).toBe('UNKNOWN');
});

it('returns the recent audited changes (who, when, what) with the list, and refuses a malformed history', async () => {
  const entry = { at: '2026-10-24T10:00:00+00:00', by: 'owner@example.invalid', action: 'PLAN_EDIT', reason: 'Reason given: Better value',
    before: { name: 'Cluera 3 Hours', amountPaise: 54900 }, after: { name: 'Cluera 3 Hours', amountPaise: 59900 } };
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'account_admin_check' ? true : { code: 'ACTIVE', plans: [plan], history: [entry] } }));
  expect(await (await clueraPlanAdminRequest(get(), liveEnv())).json()).toEqual({ code: 'ACTIVE', plans: [plan], history: [entry] });
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'account_admin_check' ? true : { code: 'ACTIVE', plans: [plan], history: [{ ...entry, extra: 1 }] } }));
  expect((await clueraPlanAdminRequest(get(), liveEnv())).status).toBe(503);
});

it('lets the owner check whether an earlier change was saved by its operation id', async () => {
  const operation = crypto.randomUUID();
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'account_admin_check' ? true : { code: 'APPLIED', plan } }));
  expect(await (await clueraPlanAdminRequest(get(`?operation=${operation}`), liveEnv())).json()).toEqual({ code: 'APPLIED', plan });
  expect(rpc.mock.calls[1][1]).toMatchObject({ p_operation: operation });
  rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'account_admin_check' ? true : { code: 'NOT_FOUND' } }));
  expect(await (await clueraPlanAdminRequest(get(`?operation=${operation}`), liveEnv())).json()).toEqual({ code: 'PENDING' });
  expect((await clueraPlanAdminRequest(get('?operation=not-a-uuid'), liveEnv())).status).toBe(400);
  expect((await clueraPlanAdminRequest(get('?x=1'), liveEnv())).status).toBe(400);
});
