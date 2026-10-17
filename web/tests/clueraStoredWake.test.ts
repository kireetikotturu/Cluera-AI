import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { handleClueraWebhook } from '../lib/payments/cluera/events';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true' };
function request(patch: Record<string, unknown> = {}, signature?: string) {
  const raw = JSON.stringify({ entity: 'event', account_id: env.RAZORPAY_TEST_ACCOUNT_ID,
    event: 'payment.captured', created_at: Math.floor(Date.now() / 1000),
    payload: { payment: { entity: { id: 'pay_syntheticwake001', order_id: 'order_syntheticwake001' } } }, ...patch });
  return new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook', {
    method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-event-id': 'event_syntheticwake001',
      'x-razorpay-signature': signature ?? createHmac('sha256', env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex') },
  });
}
afterEach(() => vi.unstubAllGlobals());
it('schedules a context-free wake only after the verified receipt is durably STORED', async () => {
  const order: string[] = [], rpc = vi.fn(async () => { order.push('stored'); return { data: 'STORED', error: null }; });
  const onStored = vi.fn(() => { order.push('scheduled'); });
  const response = await handleClueraWebhook(request(), env, rpc, onStored);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true });
  expect(order).toEqual(['stored', 'scheduled']); expect(onStored).toHaveBeenCalledExactlyOnceWith();
  expect(rpc).toHaveBeenCalledExactlyOnceWith('cluera_billing_event_accept', expect.any(Object));
});
it.each(['DUPLICATE', 'CONFLICT', 'UNAVAILABLE'])('never schedules another wake for %s', async state => {
  const rpc = vi.fn(async () => ({ data: state, error: null })), onStored = vi.fn();
  const response = await handleClueraWebhook(request(), env, rpc, onStored);
  expect(response.status).toBe(state === 'DUPLICATE' ? 200 : state === 'CONFLICT' ? 409 : 503);
  expect(onStored).not.toHaveBeenCalled();
});
it('invalid signature or foreign merchant never stores or schedules anything', async () => {
  const rpc = vi.fn(), onStored = vi.fn();
  for (const req of [request({}, 'a'.repeat(64)), request({ account_id: 'acc_foreignmerchant01' })]) {
    expect((await handleClueraWebhook(req, env, rpc, onStored)).status).toBe(400);
  }
  expect(rpc).not.toHaveBeenCalled(); expect(onStored).not.toHaveBeenCalled();
});
it('ignored event, failed durable write and disabled intake cannot schedule a wake', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'SYNTHETIC_PRIVATE' } })), onStored = vi.fn();
  expect((await handleClueraWebhook(request({ event: 'unknown.synthetic' }), env, rpc, onStored)).status).toBe(200);
  expect(rpc).not.toHaveBeenCalled();
  const failed = await handleClueraWebhook(request(), env, rpc, onStored);
  expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('SYNTHETIC_PRIVATE');
  expect((await handleClueraWebhook(request(), { ...env, SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false' }, rpc, onStored)).status).toBe(404);
  expect(rpc).toHaveBeenCalledTimes(1); expect(onStored).not.toHaveBeenCalled();
});
it('failed optional wake registration cannot turn a stored receipt into an uncertain error', async () => {
  const rpc = vi.fn(async () => ({ data: 'STORED', error: null }));
  const onStored = vi.fn(() => { throw Error('SYNTHETIC_PRIVATE_REGISTRATION'); });
  const response = await handleClueraWebhook(request(), env, rpc, onStored);
  expect(onStored).toHaveBeenCalledOnce(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true });
});
