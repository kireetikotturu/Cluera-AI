import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { handleLiveWebhook } from '../lib/payments/cluera/liveWorker';
import { createLiveBillingScope, liveBillingProfile } from '../lib/payments/cluera/modeProfile';
import { wakeClueraBillingRelay } from '../lib/payments/cluera/wakeRelay';
import { paymentLiveEnvironment as input } from './helpers/paymentLiveMode';

const scope = createLiveBillingScope(input as NodeJS.ProcessEnv), profile = liveBillingProfile(scope)!;
const proof = { mode: 'live', merchantDigest: profile.merchantDigest, origin: profile.origin, ledgerNamespace: profile.ledgerNamespace,
  grantPrefix: profile.grantPrefix, workerAudience: profile.workerAudience, checkoutEnabled: true, intakeEnabled: true, epoch: 2 };
const payload = JSON.stringify({ entity: 'event', account_id: input.RAZORPAY_LIVE_ACCOUNT_ID, event: 'payment.captured', created_at: Math.floor(Date.now() / 1000),
  payload: { payment: { entity: { id: 'pay_syntheticlive0001', order_id: 'order_syntheticlive0001' } } } });
const signed = () => new Request(profile.webhookUrl, { method: 'POST', body: payload, headers: { 'content-type': 'application/json',
  'x-razorpay-event-id': 'evt_syntheticlive0001', 'x-razorpay-signature': createHmac('sha256', input.RAZORPAY_LIVE_WEBHOOK_SECRET!).update(payload).digest('hex') } });
const rpcAnswering = (state: string) => vi.fn(async (name: string) => ({ error: null, data: name === 'cluera_live_billing_profile' ? proof : state }));

it('wakes the payment worker only after a Live receipt is durably STORED, never for a duplicate or a rejected request', async () => {
  const stored = vi.fn();
  expect((await handleLiveWebhook(signed(), input as NodeJS.ProcessEnv, rpcAnswering('STORED'), stored)).status).toBe(200);
  expect(stored).toHaveBeenCalledOnce();
  const duplicate = vi.fn();
  expect((await handleLiveWebhook(signed(), input as NodeJS.ProcessEnv, rpcAnswering('DUPLICATE'), duplicate)).status).toBe(200);
  expect(duplicate).not.toHaveBeenCalled();
  const bad = new Request(profile.webhookUrl, { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'x-razorpay-event-id': 'evt_syntheticlive0001', 'x-razorpay-signature': '0'.repeat(64) } });
  const rejected = vi.fn();
  expect((await handleLiveWebhook(bad, input as NodeJS.ProcessEnv, rpcAnswering('STORED'), rejected)).status).toBe(400);
  expect(rejected).not.toHaveBeenCalled();
});

it('a failing wake hint cannot change the acknowledged receipt', async () => {
  const response = await handleLiveWebhook(signed(), input as NodeJS.ProcessEnv, rpcAnswering('STORED'), () => { throw new Error('wake failed'); });
  expect(response.status).toBe(200);
});

it('the Live wake is signed with the dedicated Live worker secret and carries no payment data', async () => {
  const request = vi.fn(async () => Response.json({ accepted: true }, { status: 202, headers: { 'content-type': 'application/json' } }));
  expect(await wakeClueraBillingRelay(scope, request as unknown as typeof fetch)).toBe('ACCEPTED');
  const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(init.body).toBe('{}');
  expect(JSON.stringify(init.headers)).not.toContain(input.CLUERA_LIVE_WORKER_SECRET);
  // Without the Live scheduler switch there is no wake at all.
  const off = createLiveBillingScope({ ...input, CLUERA_LIVE_SCHEDULER_ENABLED: 'false' } as NodeJS.ProcessEnv);
  expect(await wakeClueraBillingRelay(off, request as unknown as typeof fetch)).toBe('DISABLED');
});
