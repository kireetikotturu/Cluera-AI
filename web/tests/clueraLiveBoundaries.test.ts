import { afterEach, expect, it, vi } from 'vitest';
import { handleLiveBilling, type LiveBillingAction } from '../lib/payments/cluera/liveRoutes';
import { handleLiveTick, handleLiveWebhook } from '../lib/payments/cluera/liveWorker';
import { billingUiCapabilities, billingUiEnvironment } from '../lib/payments/cluera/billingUi';
import { createLiveBillingScope, liveBillingRpc } from '../lib/payments/cluera/modeProfile';
import { clueraBillingConfig } from '../lib/payments/cluera/config';
import { paymentLiveEnvironment as env } from './helpers/paymentLiveMode';
afterEach(() => vi.unstubAllGlobals());
it.each(['catalog','checkout','callback','resume','history','cancellation'] as LiveBillingAction[])(
  'Live %s is absent by default without Auth/database/provider side effects', async action => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const response = await handleLiveBilling(new Request(env.CLUERA_LIVE_ACCOUNT_ORIGIN + '/api/account/payments/cluera/live/' + action), action, {});
    expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(request).not.toHaveBeenCalled();
  });
it('disabled Live receipts and workers do not touch Test or any RPC', async () => {
  const rpc = vi.fn();
  expect((await handleLiveWebhook(new Request(env.CLUERA_LIVE_ACCOUNT_ORIGIN + '/api/account/payments/cluera/live/webhook', {method:'POST'}), {}, rpc)).status).toBe(404);
  expect((await handleLiveTick(new Request(env.CLUERA_LIVE_ACCOUNT_ORIGIN + '/api/internal/billing/cluera/live/tick', {method:'POST'}), {}, {rpc})).status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});
it('mode selection exposes only UI capabilities and cannot change existing Test handlers', () => {
  const input = {...env, CLUERA_BILLING_UI_MODE:'live'};
  expect(clueraBillingConfig(input).keyId).toBe(env.RAZORPAY_TEST_KEY_ID);
  expect(clueraBillingConfig(billingUiEnvironment(input)).keyId).toBe(env.RAZORPAY_LIVE_KEY_ID);
  expect(Object.keys(billingUiCapabilities(input)).sort()).toEqual(['cancellationEnabled','checkoutWindowSeconds','enabled','historyEnabled','mode']);
  expect(billingUiCapabilities(input).checkoutWindowSeconds).toBe(600);
  expect(JSON.stringify(billingUiCapabilities(input))).not.toContain(env.RAZORPAY_LIVE_KEY_SECRET);
  expect(billingUiCapabilities({...input, RAZORPAY_LIVE_KEY_SECRET:undefined}).enabled).toBe(false);
});
it('Live RPC mapping rejects legacy, private bypasses and double-scoping', () => {
  const raw = vi.fn(), rpc = liveBillingRpc(raw);
  for(const name of ['account_payment_apply','cluera_billing_apply_pre_native','cluera_live_billing_apply','cluera_billing_legacy_apply'])
    expect(()=>rpc(name,{})).toThrow();
  expect(raw).not.toHaveBeenCalled();
});
it.each(['RAZORPAY_TEST_KEY_SECRET','RAZORPAY_TEST_WEBHOOK_SECRET','SUPABASE_SERVICE_ROLE_KEY'])(
  'Live credentials and signer cannot reuse %s', key => {
    const value = env[key as keyof typeof env];
    expect(()=>createLiveBillingScope({...env,RAZORPAY_LIVE_KEY_SECRET:value})).toThrow();
    expect(()=>createLiveBillingScope({...env,CLUERA_LIVE_WORKER_SECRET:value})).toThrow();
  });
