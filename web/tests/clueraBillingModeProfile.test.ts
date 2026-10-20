import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertBillingProfileProof, billingModeProfile } from '../lib/payments/cluera/modeProfile';
import { clueraCheckoutEnabled, merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true',
  RAZORPAY_LIVE_KEY_ID: 'rzp_live_syntheticmode123456', RAZORPAY_LIVE_KEY_SECRET: 'synthetic-live-api-private-material-000000',
  RAZORPAY_LIVE_WEBHOOK_SECRET: 'synthetic-live-webhook-private-material-000000',
  RAZORPAY_LIVE_ACCOUNT_ID: 'acc_syntheticlivemode123456', CLUERA_LIVE_PROJECT_REF: 'yhnqlfcgrmckhyjdxegg',
  CLUERA_LIVE_ACCOUNT_ORIGIN: 'https://cluera-ai-staging.vercel.app',
  CLUERA_LIVE_APPROVED_ORIGIN: 'https://cluera-ai-staging.vercel.app',
  CLUERA_LIVE_MERCHANT_DIGEST: createHash('sha256').update('razorpay:live:acc_syntheticlivemode123456:rzp_live_syntheticmode123456').digest('hex'),
};
const accepted = { ...env, CLUERA_LIVE_OWNER_APPROVED: 'true', CLUERA_LIVE_SECURITY_ACCEPTED: 'true',
  CLUERA_LIVE_TEST_ACCEPTED: 'true', CLUERA_LIVE_RUNTIME_ACCEPTED: 'true',
  CLUERA_LIVE_CHECKOUT_ENABLED: 'true', CLUERA_LIVE_INTAKE_ENABLED: 'true' };
function proof(mode: 'test' | 'live' = 'live') {
  const p = billingModeProfile(mode, env);
  return { mode, merchantDigest: p.merchantDigest, origin: p.origin, ledgerNamespace: p.ledgerNamespace,
    grantPrefix: p.grantPrefix, workerAudience: p.workerAudience, epoch: 1, checkoutEnabled: true, intakeEnabled: true };
}
it('prepares independent Test and Live profiles without switching the current Test runtime', () => {
  const test = billingModeProfile('test', env), live = billingModeProfile('live', env);
  expect(test.merchantDigest).toBe(merchantDigest(env));
  for (const field of ['keyId', 'keySecret', 'webhookSecret', 'merchantDigest', 'webhookUrl', 'ledgerNamespace',
    'grantPrefix', 'workerAudience', 'rpcPrefix'] as const) expect(test[field]).not.toBe(live[field]);
  expect(clueraCheckoutEnabled(env)).toBe(true);
  expect(() => assertBillingProfileProof(live, proof(), 'checkout', env)).toThrow();
});
it.each(['RAZORPAY_LIVE_KEY_ID', 'RAZORPAY_LIVE_KEY_SECRET', 'RAZORPAY_LIVE_WEBHOOK_SECRET', 'RAZORPAY_LIVE_ACCOUNT_ID',
  'CLUERA_LIVE_PROJECT_REF', 'CLUERA_LIVE_ACCOUNT_ORIGIN', 'CLUERA_LIVE_APPROVED_ORIGIN', 'CLUERA_LIVE_MERCHANT_DIGEST'])(
  'never falls back to Test when %s is missing', key => {
    expect(() => billingModeProfile('live', { ...env, [key]: undefined })).toThrow();
    expect(clueraCheckoutEnabled({ ...env, [key]: undefined })).toBe(true);
  });
it.each([
  { RAZORPAY_LIVE_KEY_ID: env.RAZORPAY_TEST_KEY_ID }, { RAZORPAY_LIVE_KEY_SECRET: env.RAZORPAY_TEST_KEY_SECRET },
  { RAZORPAY_LIVE_WEBHOOK_SECRET: env.RAZORPAY_TEST_WEBHOOK_SECRET },
  { RAZORPAY_LIVE_WEBHOOK_SECRET: env.RAZORPAY_LIVE_KEY_SECRET }, { CLUERA_LIVE_MERCHANT_DIGEST: 'a'.repeat(64) },
  { NEXT_PUBLIC_SUPABASE_URL: 'https://foreign.supabase.co' },
])('rejects credential reuse, merchant/target mismatch %j', patch => {
  expect(() => billingModeProfile('live', { ...env, ...patch })).toThrow();
});
it.each(['http://example.com', 'https://example.com/', 'https://evil.example.com@other.com', 'https://example.com:8443',
  'https://example.com/path', 'https://*.example.com', 'https://127.0.0.1', 'https://localhost', 'https://example.com?mode=live'])(
  'refuses unsafe migration origin %s', origin => {
    expect(() => billingModeProfile('live', { ...env, CLUERA_LIVE_ACCOUNT_ORIGIN: origin, CLUERA_LIVE_APPROVED_ORIGIN: origin })).toThrow();
  });
it('supports an explicitly approved new exact domain while rejecting the old database origin proof', () => {
  const next = { ...accepted, CLUERA_LIVE_ACCOUNT_ORIGIN: 'https://app.cluera.com', CLUERA_LIVE_APPROVED_ORIGIN: 'https://app.cluera.com' };
  const profile = billingModeProfile('live', next);
  expect(() => assertBillingProfileProof(profile, proof(), 'checkout', next)).toThrow();
  expect(assertBillingProfileProof(profile, { ...proof(), origin: profile.origin }, 'checkout', next).epoch).toBe(1);
  expect(profile.merchantDigest).toBe(billingModeProfile('live', env).merchantDigest);
});
it.each(['mode', 'merchantDigest', 'ledgerNamespace', 'grantPrefix', 'workerAudience'] as const)('rejects cross-mode %s database proof', field => {
  expect(() => assertBillingProfileProof(billingModeProfile('live', env), { ...proof(), [field]: proof('test')[field] },
    'checkout', accepted)).toThrow();
});
it.each(['CLUERA_LIVE_OWNER_APPROVED', 'CLUERA_LIVE_SECURITY_ACCEPTED', 'CLUERA_LIVE_TEST_ACCEPTED',
  'CLUERA_LIVE_RUNTIME_ACCEPTED', 'CLUERA_LIVE_CHECKOUT_ENABLED'])('requires independent %s approval', key => {
  expect(() => assertBillingProfileProof(billingModeProfile('live', env), proof(), 'checkout', { ...accepted, [key]: 'false' })).toThrow();
});
it('requires database and runtime capabilities independently for checkout and intake', () => {
  const profile = billingModeProfile('live', env);
  expect(assertBillingProfileProof(profile, proof(), 'checkout', accepted).mode).toBe('live');
  expect(() => assertBillingProfileProof(profile, { ...proof(), checkoutEnabled: false }, 'checkout', accepted)).toThrow();
  expect(() => assertBillingProfileProof(profile, proof(), 'intake', { ...accepted, CLUERA_LIVE_INTAKE_ENABLED: 'false' })).toThrow();
});
it.each([
  {VERCEL_ENV:'preview'}, {VERCEL_TARGET_ENV:'preview'}, {VERCEL_PROJECT_ID:'foreign-project'}, {VERCEL_ORG_ID:'foreign-team'},
])('refuses Live credentials in a foreign or preview deployment: %j', platform => {
  expect(()=>billingModeProfile('live',{...env,...platform})).toThrow();
});
