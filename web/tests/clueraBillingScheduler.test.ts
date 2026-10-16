import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { handleClueraBillingTick, workerProofMessage, CLUERA_WORKER_URL } from '../lib/payments/cluera/scheduler';
import { merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true',
  SIGMAROUND_BILLING_WORKER_SECRET: 'synthetic-worker-proof-secret-000000000000', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic-server-key' };
const now = Date.parse('2026-10-14T02:00:00Z'), seconds = now / 1000;
const nonce = '00000000-0000-4000-8000-000000000910';
function request(overrides: Record<string, string> = {}, body = '{}', url = CLUERA_WORKER_URL) {
  const proof = createHmac('sha256', env.SIGMAROUND_BILLING_WORKER_SECRET)
    .update(workerProofMessage(2, seconds, nonce, merchantDigest(env))).digest('hex');
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'x-cluera-billing-time': String(seconds), 'x-cluera-billing-nonce': nonce,
    'x-cluera-billing-epoch': '2', 'x-cluera-billing-proof': proof, ...overrides }, body });
}
function deps(state = 'CLAIMED') {
  return { now: () => now, rpc: vi.fn(async () => ({ data: state, error: null })), reconcile: vi.fn(async () => 'EMPTY') };
}
it('consumes a short-lived proof nonce before processing exactly one lease', async () => {
  const d = deps(); const response = await handleClueraBillingTick(request(), env, d);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ processed: true });
  expect(d.rpc).toHaveBeenCalledExactlyOnceWith('cluera_billing_worker_nonce', expect.objectContaining({ p_epoch: 2, p_nonce: nonce }));
  expect(d.reconcile).toHaveBeenCalledTimes(1); expect(response.headers.get('cache-control')).toBe('no-store');
});
it.each([
  { 'x-cluera-billing-proof': 'a'.repeat(64) }, { 'x-cluera-billing-proof': 'x'.repeat(64) },
  { 'x-cluera-billing-time': String(seconds - 61) }, { 'x-cluera-billing-time': String(seconds + 6) },
  { 'x-cluera-billing-time': `0${seconds}` }, { 'x-cluera-billing-nonce': `${nonce},${nonce}` },
  { 'x-cluera-billing-epoch': '0' }, { 'x-cluera-billing-epoch': '9007199254740992' },
])('rejects malformed, expired or changed proof fields without a database/provider call', async headers => {
  const d = deps(); expect((await handleClueraBillingTick(request(headers), env, d)).status).toBe(401);
  expect(d.rpc).not.toHaveBeenCalled(); expect(d.reconcile).not.toHaveBeenCalled();
});
it.each([{ origin: 'https://cluera-ai-staging.vercel.app' }, { cookie: 'anything' }, { authorization: 'Bearer synthetic' }, { 'content-type': 'text/plain' }])
('rejects browser or legacy bearer requests', async headers => {
  const d = deps(); expect((await handleClueraBillingTick(request(headers), env, d)).status).toBe(400); expect(d.rpc).not.toHaveBeenCalled();
});
it.each([' {}', '{"event":"anything"}', ' '.repeat(129)])('only accepts the exact empty scheduler body', async body => {
  const d = deps(); const response = await handleClueraBillingTick(request({}, body), env, d);
  expect(response.status).toBe(400); expect(d.rpc).not.toHaveBeenCalled(); expect(d.reconcile).not.toHaveBeenCalled();
});
it.each([`${CLUERA_WORKER_URL}?event=1`, CLUERA_WORKER_URL.replace('cluera-ai-staging', 'sigmaround-account-staging')])('pins the destination and forbids financial query inputs', async url => {
  const d = deps(); expect((await handleClueraBillingTick(request({}, '{}', url), env, d)).status).toBe(400); expect(d.rpc).not.toHaveBeenCalled();
});
it.each(['REPLAY', 'INVALID', 'UNAVAILABLE'])('never processes a rejected nonce (%s)', async state => {
  const d = deps(state); expect((await handleClueraBillingTick(request(), env, d)).status).toBe(state === 'UNAVAILABLE' ? 503 : 401);
  expect(d.reconcile).not.toHaveBeenCalled();
});
it.each([{ CLUERA_BILLING_V2_ENABLED: 'false' }, { CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false' },
  { SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false' }, { RAZORPAY_ENVIRONMENT: 'live' }, { SIGMAROUND_ACCOUNT_ORIGIN: 'https://other.invalid' }])
('fails closed before auth or schema access while disabled/mis-targeted', async override => {
  const d = deps(); expect((await handleClueraBillingTick(request(), { ...env, ...override }, d)).status).toBe(404); expect(d.rpc).not.toHaveBeenCalled();
});
it('returns a fixed error and does not reuse a consumed nonce after processing failure', async () => {
  const d = deps(); d.reconcile.mockRejectedValueOnce(new Error('synthetic PRIVATE payload'));
  const response = await handleClueraBillingTick(request(), env, d);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE'); expect(d.reconcile).toHaveBeenCalledTimes(1);
});
