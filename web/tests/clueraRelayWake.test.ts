import { afterEach, expect, it, vi } from 'vitest';
import { RELAY_WAKE_URL, verifySchedulerRequest } from '../../shared/billingDispatch';
import { wakeClueraBillingRelay } from '../lib/payments/cluera/wakeRelay';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true', CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: 'true',
  SIGMAROUND_BILLING_WORKER_SECRET: 'synthetic-fresh-external-worker-secret-00000000' };
const now = Date.parse('2026-10-17T12:00:00Z');
afterEach(() => vi.useRealTimers());
it('sends a single fixed WAKE proof with no event/customer/provider data or secret body', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe(RELAY_WAKE_URL); expect(init).toMatchObject({ method: 'POST', body: '{}', redirect: 'error', cache: 'no-store', credentials: 'omit' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(await verifySchedulerRequest(new Request(String(url), init), 'WAKE', env.SIGMAROUND_BILLING_WORKER_SECRET, now)).not.toBeNull();
    expect(JSON.stringify(init)).not.toContain(env.SIGMAROUND_BILLING_WORKER_SECRET);
    return Response.json({ accepted: true }, { status: 202 });
  });
  expect(await wakeClueraBillingRelay(env, request, now)).toBe('ACCEPTED'); expect(request).toHaveBeenCalledTimes(1);
});
it.each([{ CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: 'false' }, { CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: undefined },
  { CLUERA_BILLING_V2_ENABLED: 'false' }, { CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false' },
  { SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false' }, { RAZORPAY_ENVIRONMENT: 'live' }, { NEXT_PUBLIC_SUPABASE_URL: 'https://foreign.supabase.co' }])
('current disabled/mistargeted configuration makes zero outbound wake attempts: %j', async patch => {
  const request = vi.fn(); expect(await wakeClueraBillingRelay({ ...env, ...patch }, request, now)).toBe('DISABLED'); expect(request).not.toHaveBeenCalled();
});
it('invalid secret, network failure and raw errors reduce to fixed unavailable without a retry', async () => {
  const request = vi.fn(async () => { throw Error('SYNTHETIC_PRIVATE_NETWORK_BODY'); });
  expect(await wakeClueraBillingRelay({ ...env, SIGMAROUND_BILLING_WORKER_SECRET: 'short' }, request, now)).toBe('UNAVAILABLE'); expect(request).not.toHaveBeenCalled();
  expect(await wakeClueraBillingRelay(env, request, now)).toBe('UNAVAILABLE'); expect(request).toHaveBeenCalledTimes(1);
});
it.each([() => Response.json({ accepted: true }, { status: 500 }), () => new Response('', { status: 302, headers: { location: 'https://foreign.invalid' } }),
  () => Response.json({ accepted: true, raw: 'PRIVATE' }, { status: 202 }), () => Response.json({ accepted: false }, { status: 202 }),
  () => new Response('x'.repeat(257), { status: 202, headers: { 'content-type': 'application/json' } }),
  () => new Response('{}', { status: 202, headers: { 'content-type': 'text/plain' } }),
  () => new Response('{}', { status: 202, headers: { 'content-type': 'application/json', 'content-length': '257' } })])
('rejects redirect/unknown/oversized wake responses', async response => {
  const request = vi.fn(async () => response()); expect(await wakeClueraBillingRelay(env, request, now)).toBe('UNAVAILABLE'); expect(request).toHaveBeenCalledTimes(1);
});
it('bounds an uncooperative fetch or response body without waiting for cancellation', async () => {
  vi.useFakeTimers();
  for (const streaming of [false, true]) {
    const request = vi.fn(() => streaming ? Promise.resolve(new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }),
      { status: 202, headers: { 'content-type': 'application/json' } })) : new Promise<Response>(() => {}));
    const pending = wakeClueraBillingRelay(env, request, now); await vi.advanceTimersByTimeAsync(2501);
    expect(await pending).toBe('UNAVAILABLE'); expect(request).toHaveBeenCalledTimes(1);
  }
});
