import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schedulerHeaders, schedulerNonce, WEB_DISPATCH_URL } from '../../shared/billingDispatch';
import { externalClueraSchedulerEnabled, handleClueraExternalDispatch } from '../lib/payments/cluera/externalScheduler';
import { merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const clients = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: clients.create }));
const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true', CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: 'true',
  SIGMAROUND_BILLING_WORKER_SECRET: 'synthetic-fresh-external-worker-secret-00000000',
  VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production', VERCEL_PROJECT_ID: 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B', VERCEL_ORG_ID: 'team_AksnPXhi2VBXI5UsY2xBIakc' };
const now = Date.parse('2026-10-17T12:00:00Z');
function request(headers: Record<string, string> = {}, body = '{}', url = WEB_DISPATCH_URL, purpose: 'DISPATCH' | 'WAKE' | 'STATUS' = 'DISPATCH') {
  return new Request(url, { method: 'POST', body, headers: { ...schedulerHeaders(purpose, env.SIGMAROUND_BILLING_WORKER_SECRET, now), ...headers } });
}
function deps() {
  const consumed = new Set<string>();
  return { now: () => now, reconcile: vi.fn(async () => 'EMPTY'), rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'cluera_billing_owner') return { data: { owner: 'cluera', epoch: 1 }, error: null };
    expect(name).toBe('cluera_billing_worker_nonce'); const nonce = String(args.p_nonce);
    if (consumed.has(nonce)) return { data: 'REPLAY', error: null };
    consumed.add(nonce); return { data: 'CLAIMED', error: null };
  }) };
}
beforeEach(() => { clients.create.mockReset(); vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected real-network fallback'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('authenticates fixed dispatch, resolves server ownership and delegates once in-process to the unchanged worker', async () => {
  const d = deps(), response = await handleClueraExternalDispatch(request(), env, d);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ processed: true });
  expect(d.rpc.mock.calls.map(([name]) => name)).toEqual(['cluera_billing_owner', 'cluera_billing_worker_nonce']);
  expect(d.rpc.mock.calls[0][1]).toEqual({ p_account_digest: merchantDigest(env) });
  expect(d.rpc.mock.calls[1][1]).toEqual({ p_nonce: schedulerNonce('DISPATCH', now / 1000, env.SIGMAROUND_BILLING_WORKER_SECRET),
    p_issued_at: new Date(now).toISOString(), p_epoch: 1, p_account_digest: merchantDigest(env) });
  expect(d.reconcile).toHaveBeenCalledExactlyOnceWith(d.rpc, env); expect(fetch).not.toHaveBeenCalled(); expect(clients.create).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('same-minute repeated dispatch is durably rejected without another reconciliation or a grant', async () => {
  const d = deps(); expect((await handleClueraExternalDispatch(request(), env, d)).status).toBe(200);
  expect((await handleClueraExternalDispatch(request(), env, d)).status).toBe(401);
  expect(d.reconcile).toHaveBeenCalledTimes(1); expect(d.rpc.mock.calls.filter(([name]) => name === 'cluera_billing_worker_nonce')).toHaveLength(2);
  expect(d.rpc.mock.calls.some(([name]) => /grant|apply|checkout|bind/.test(name))).toBe(false);
});
it.each([
  { CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: undefined }, { CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: 'false' },
  { CLUERA_BILLING_V2_ENABLED: 'false' }, { CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false' },
  { SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false' }, { RAZORPAY_ENVIRONMENT: 'live' },
  { NEXT_PUBLIC_SUPABASE_URL: 'https://foreign.supabase.co' }, { SIGMAROUND_RAZORPAY_TEST_PROJECT_REF: 'foreign' },
  { SIGMAROUND_ACCOUNT_ORIGIN: 'https://sigmaround-account-staging.vercel.app' }, { SIGMAROUND_ACCOUNTS_ENABLED: 'false' },
  { SIGMAROUND_PAYMENT_PROVIDER: 'paddle' }, { VERCEL_ENV: 'preview' }, { VERCEL_TARGET_ENV: 'preview' },
  { VERCEL_PROJECT_ID: 'foreign' }, { VERCEL_ORG_ID: 'foreign' },
])('disabled/mistargeted external gate denies before privileged client/auth/body work: %j', async patch => {
  const d = deps(), configured = { ...env, ...patch };
  expect(externalClueraSchedulerEnabled(configured)).toBe(false);
  expect((await handleClueraExternalDispatch(request(), configured, d)).status).toBe(404);
  expect(d.rpc).not.toHaveBeenCalled(); expect(d.reconcile).not.toHaveBeenCalled(); expect(clients.create).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it.each([{ SIGMAROUND_BILLING_WORKER_SECRET: '' }, { SIGMAROUND_BILLING_WORKER_SECRET: 'short' },
  { SIGMAROUND_BILLING_WORKER_SECRET: 'x'.repeat(257) }, { SIGMAROUND_BILLING_WORKER_SECRET: 'x'.repeat(32) + '\n' }, { SUPABASE_SERVICE_ROLE_KEY: '' }])
('requires dedicated valid server secrets, never dummy credentials: %j', async patch => {
  const d = deps(); expect((await handleClueraExternalDispatch(request(), { ...env, ...patch }, d)).status).toBe(503);
  expect(d.rpc).not.toHaveBeenCalled(); expect(clients.create).not.toHaveBeenCalled();
});
it.each([{ 'x-cluera-scheduler-proof': '0'.repeat(64) }, { 'x-cluera-scheduler-proof': 'x'.repeat(64) },
  { 'x-cluera-scheduler-time': String(now / 1000 - 61) }, { 'x-cluera-scheduler-nonce': crypto.randomUUID() },
  { origin: 'https://cluera-ai-staging.vercel.app' }, { cookie: 'synthetic' }, { authorization: 'Bearer synthetic' },
  { 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }])('bad proof/browser request never reaches SDK or RPC: %j', async headers => {
  const d = deps(); expect((await handleClueraExternalDispatch(request(headers), env, d)).status).toBe(401);
  expect(d.rpc).not.toHaveBeenCalled(); expect(clients.create).not.toHaveBeenCalled();
});
it.each([' {}', '{"amount":54900}', '{}\n', 'x'.repeat(129)])('no financial/caller-selected body is accepted (%s)', async body => {
  const d = deps(); expect((await handleClueraExternalDispatch(request({}, body), env, d)).status).toBe(401); expect(d.rpc).not.toHaveBeenCalled();
});
it('different URL, query, method or proof domain cannot reach privileged work', async () => {
  const d = deps();
  for (const req of [request({}, '{}', WEB_DISPATCH_URL + '?event=1'), request({}, '{}', WEB_DISPATCH_URL.replace('cluera-ai-staging', 'sigmaround-account-staging')),
    request({}, '{}', WEB_DISPATCH_URL, 'WAKE'), request({}, '{}', WEB_DISPATCH_URL, 'STATUS'), new Request(WEB_DISPATCH_URL)]) {
    expect((await handleClueraExternalDispatch(req, env, d)).status).toBe(401);
  }
  expect(d.rpc).not.toHaveBeenCalled(); expect(clients.create).not.toHaveBeenCalled();
});
it('creates exactly one SDK only after proof verification and never performs self-HTTP', async () => {
  const d = deps(); clients.create.mockReturnValue({ rpc: d.rpc });
  const response = await handleClueraExternalDispatch(request(), env, { now: d.now, reconcile: d.reconcile });
  expect(response.status).toBe(200); expect(clients.create).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  expect(clients.create.mock.calls[0][0]).toBe('https://yhnqlfcgrmckhyjdxegg.supabase.co');
});
it.each([{ owner: 'account', epoch: 1 }, { owner: 'cluera', epoch: 0 }, { owner: 'cluera', epoch: 1.5 }, null])
('owner/epoch rejection cannot consume a nonce: %j', async owner => {
  const d = deps(); d.rpc.mockResolvedValue({ data: owner as any, error: null });
  expect((await handleClueraExternalDispatch(request(), env, d)).status).toBe(503); expect(d.rpc).toHaveBeenCalledTimes(1); expect(d.reconcile).not.toHaveBeenCalled();
});
it('durable rejection or reconciliation failure stays fixed and does not retry', async () => {
  const d = deps(); d.reconcile.mockRejectedValueOnce(Error('SYNTHETIC_PRIVATE_PROVIDER_BODY'));
  const failed = await handleClueraExternalDispatch(request(), env, d);
  expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('SYNTHETIC_PRIVATE'); expect(d.reconcile).toHaveBeenCalledTimes(1);
  expect((await handleClueraExternalDispatch(request(), env, d)).status).toBe(401); expect(d.reconcile).toHaveBeenCalledTimes(1);
});
