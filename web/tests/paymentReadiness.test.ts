import { describe, expect, it } from 'vitest';
import { billingReadiness } from '../lib/payments/cluera/readiness';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import { paymentLiveEnvironment } from './helpers/paymentLiveMode';
import { createLiveBillingScope, liveBillingProfile } from '../lib/payments/cluera/modeProfile';

const catalog = [{ offerCode: 'cluera_pack_3h_v2' as const, enabled: true }];
const testEnv = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true', CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: 'true', SIGMAROUND_BILLING_WORKER_SECRET: 'synthetic-billing-worker-private-material-0' } as NodeJS.ProcessEnv;
const liveEnv = { ...paymentLiveEnvironment, CLUERA_BILLING_UI_MODE: 'live' } as NodeJS.ProcessEnv;
const ids = (report: ReturnType<typeof billingReadiness>) => report.items.filter(item => !item.ok).map(item => item.id);

describe('payment readiness checklist', () => {
  it('reports Test mode ready only when every item is satisfied', () => {
    const ready = billingReadiness(testEnv, { catalog });
    expect(ready).toMatchObject({ mode: 'test', ready: true, audience: 'listed accounts' });
    expect(ids(billingReadiness(testEnv, { catalog: [] }))).toEqual(['catalog']);
  });
  it('names each missing Test setting with its fix and never prints a secret value', () => {
    const report = billingReadiness({ ...testEnv, CLUERA_BILLING_V2_ENABLED: undefined, SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: undefined,
      SIGMAROUND_PAYMENT_TESTER_IDS: '', RAZORPAY_TEST_KEY_SECRET: 'short' }, { catalog: null });
    expect(report.ready).toBe(false);
    expect(ids(report)).toEqual(expect.arrayContaining(['billing', 'keys', 'intake', 'buyers', 'catalog']));
    expect(report.audience).toBe('nobody');
    const text = JSON.stringify(report);
    for (const secret of ['short', paymentTestEnvironment.RAZORPAY_TEST_WEBHOOK_SECRET, paymentTestEnvironment.SUPABASE_SERVICE_ROLE_KEY]) expect(text).not.toContain(secret);
    expect(report.items.find(item => item.id === 'intake')!.fix).toContain('SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED=true');
  });
  it('requires a matching database proof in Live mode', () => {
    const profile = liveBillingProfile(createLiveBillingScope(liveEnv))!;
    const proof = { mode: 'live', merchantDigest: profile.merchantDigest, origin: profile.origin, ledgerNamespace: profile.ledgerNamespace,
      grantPrefix: profile.grantPrefix, workerAudience: profile.workerAudience, checkoutEnabled: true, intakeEnabled: true, epoch: 2 };
    expect(ids(billingReadiness(liveEnv, { catalog, liveProof: proof }))).toEqual([]);
    expect(ids(billingReadiness(liveEnv, { catalog }))).toEqual(['profile']);
    expect(ids(billingReadiness(liveEnv, { catalog, liveProof: { ...proof, merchantDigest: 'f'.repeat(64) } }))).toEqual(['profile']);
    expect(ids(billingReadiness({ ...liveEnv, CLUERA_LIVE_PURCHASER_IDS: '' }, { catalog, liveProof: proof }))).toEqual(['buyers']);
  });
  it('describes the audience and flags broken Live keys without exposing them', () => {
    expect(billingReadiness({ ...liveEnv, CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED: 'true' }).audience).toBe('every verified customer');
    const broken = billingReadiness({ ...liveEnv, RAZORPAY_LIVE_KEY_SECRET: undefined, CLUERA_LIVE_OWNER_APPROVED: 'false' }, { catalog });
    expect(ids(broken)).toEqual(expect.arrayContaining(['keys', 'approvals', 'profile']));
    expect(JSON.stringify(broken)).not.toContain(paymentLiveEnvironment.CLUERA_LIVE_WORKER_SECRET);
  });
});
