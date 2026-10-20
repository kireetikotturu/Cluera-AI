import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createLiveBillingTransport } from '../../backend/liveBillingTransport';
import { liveDispatchConfig, liveDispatchHeaders } from '../../shared/liveBillingDispatch';
import { workerProofMessage } from '../lib/payments/cluera/scheduler';
import { paymentLiveEnvironment } from './helpers/paymentLiveMode';
const env = { ...paymentLiveEnvironment, CLUERA_LIVE_WORKER_EPOCH: '1' };
afterEach(() => vi.useRealTimers());
it('is inactive without the Live scheduler gate and rejects reused signers or mismatched origins', async () => {
  const request = vi.fn();
  const transport = createLiveBillingTransport({}, { fetch: request }); transport.start(); await transport.stop();
  expect(request).not.toHaveBeenCalled();
  expect(() => liveDispatchConfig({ ...env, CLUERA_LIVE_WORKER_SECRET: env.SIGMAROUND_BILLING_WORKER_SECRET })).toThrow();
  expect(() => liveDispatchConfig({ ...env, CLUERA_LIVE_APPROVED_ORIGIN: 'https://other.example.com' })).toThrow();
});
it('signs the exact Live receiver audience with a fresh nonce and pinned epoch', () => {
  const config = liveDispatchConfig(env)!, now = Date.now(), headers = liveDispatchHeaders(config, now);
  expect(headers['x-cluera-billing-proof']).toBe(createHmac('sha256', config.secret)
    .update(workerProofMessage(1, Math.floor(now / 1000), headers['x-cluera-billing-nonce'], config.digest, config.origin)).digest('hex'));
  expect(liveDispatchHeaders(config, now)['x-cluera-billing-nonce']).not.toBe(headers['x-cluera-billing-nonce']);
});
it('settles an abort-ignoring request at the deadline, never overlaps and stops without waiting on that transport', async () => {
  vi.useFakeTimers();
  const request = vi.fn(() => new Promise<Response>(() => {})), observe = vi.fn();
  const transport = createLiveBillingTransport(env, { fetch: request, observe }); transport.start();
  await vi.advanceTimersByTimeAsync(14999); expect(request).toHaveBeenCalledTimes(1); expect(observe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(observe).toHaveBeenCalledWith('unavailable');
  await vi.advanceTimersByTimeAsync(44999); expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2);
  await transport.stop(); await vi.advanceTimersByTimeAsync(120000); expect(request).toHaveBeenCalledTimes(2);
});
it.each([{processed:true},{processed:false},{processed:true,private:'do-not-reflect'},'html'])(
  'only an exact bounded worker acknowledgement is recorded as accepted: %j', async body => {
    vi.useFakeTimers();
    const observe=vi.fn(),request=vi.fn(async()=>Response.json(body));
    const transport=createLiveBillingTransport(env,{fetch:request,observe});transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledWith(JSON.stringify(body)==='{"processed":true}'?'accepted':'unavailable');
    expect(JSON.stringify(observe.mock.calls)).not.toContain('do-not-reflect');
    await transport.stop();
  });
