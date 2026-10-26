import { ACCOUNT_PAYMENT_ORIGIN, razorpayConfig } from '../core/config';
import { CLUERA_SUPABASE_URL } from '../../supabase/target';
import { assertBillingProfileProof, createLiveBillingScope, liveBillingProfile } from './modeProfile';
import type { Revision } from './contracts';

export type ReadinessItem = { id: string; area: 'Website' | 'Razorpay' | 'Database' | 'Catalog' | 'Buyers'; label: string; ok: boolean; fix: string };
export type ReadinessReport = {
  mode: 'test' | 'live'; items: ReadinessItem[]; ready: boolean; audience: 'nobody' | 'listed accounts' | 'every verified customer';
};
type Evidence = { liveProof?: unknown; catalog?: Pick<Revision, 'offerCode' | 'enabled'>[] | null };

const flag = (env: NodeJS.ProcessEnv, name: string) => env[name] === 'true';
const count = (value: string | undefined) => (value ?? '').split(',').map(item => item.trim()).filter(Boolean).length;
const guide = (step: string) => `See docs/GO_LIVE_GUIDE.md, ${step}.`;

/** Non-secret, boolean-only explanation of why the Buy buttons are or are not usable.
 * It reads configuration only: it never contacts Razorpay and never changes anything. */
export function billingReadiness(env: NodeJS.ProcessEnv, evidence: Evidence = {}): ReadinessReport {
  const live = env.CLUERA_BILLING_UI_MODE === 'live', mode = live ? 'live' as const : 'test' as const;
  const items: ReadinessItem[] = [];
  const add = (id: string, area: ReadinessItem['area'], label: string, ok: boolean, fix: string) => items.push({ id, area, label, ok, fix });
  let audience: ReadinessReport['audience'] = 'nobody';

  add('site', 'Website', 'Accounts are enabled on the Cluera website', flag(env, 'SIGMAROUND_ACCOUNTS_ENABLED')
    && env.SIGMAROUND_ACCOUNT_ORIGIN === ACCOUNT_PAYMENT_ORIGIN && env.NEXT_PUBLIC_SUPABASE_URL === CLUERA_SUPABASE_URL,
    `Vercel needs SIGMAROUND_ACCOUNTS_ENABLED=true, SIGMAROUND_ACCOUNT_ORIGIN=${ACCOUNT_PAYMENT_ORIGIN} and the Cluera NEXT_PUBLIC_SUPABASE_URL. ${guide('Step 3')}`);
  add('billing', 'Website', 'Billing is switched on', flag(env, 'CLUERA_BILLING_V2_ENABLED'),
    `Set CLUERA_BILLING_V2_ENABLED=true in Vercel and redeploy. ${guide('Step 3')}`);
  add('service-key', 'Database', 'The server can reach the database', Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
    `Add SUPABASE_SERVICE_ROLE_KEY in Vercel as a Sensitive, server-only variable. ${guide('Step 3')}`);

  if (!live) {
    let keys = false;
    try { razorpayConfig(env); keys = true; } catch { /* reported as a missing item */ }
    add('keys', 'Razorpay', 'Razorpay TEST keys, account id and webhook secret are valid', keys,
      `Set RAZORPAY_ENVIRONMENT=test, RAZORPAY_TEST_KEY_ID, RAZORPAY_TEST_KEY_SECRET, RAZORPAY_TEST_ACCOUNT_ID, RAZORPAY_TEST_WEBHOOK_SECRET and SIGMAROUND_RAZORPAY_TEST_PROJECT_REF. ${guide('Step 2 and Step 3')}`);
    add('rollout', 'Razorpay', 'Test payments are approved and not paused', flag(env, 'CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED')
      && env.SIGMAROUND_PAYMENT_PROVIDER === 'razorpay' && env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED === 'false',
      'Set CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED=true, SIGMAROUND_PAYMENT_PROVIDER=razorpay and SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED=false.');
    add('intake', 'Razorpay', 'Payment confirmations (webhook) are accepted', flag(env, 'SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED'),
      `Set SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED=true. Without it a paid order never becomes time. ${guide('Step 2')}`);
    add('checkout', 'Razorpay', 'The Buy button is switched on', flag(env, 'SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED'),
      'Set SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED=true.');
    add('worker', 'Database', 'The credit worker is switched on and has its secret', Boolean(env.SIGMAROUND_BILLING_WORKER_SECRET) && flag(env, 'CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED'),
      `Set CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED=true and the same SIGMAROUND_BILLING_WORKER_SECRET on Vercel and Render. ${guide('Step 4')}`);
    const testers = count(env.SIGMAROUND_PAYMENT_TESTER_IDS);
    if (testers) audience = 'listed accounts';
    add('buyers', 'Buyers', testers ? `${testers} account(s) may buy (Test mode)` : 'No account may buy yet (Test mode only allows listed accounts)', testers > 0,
      'Put your Cluera user id in SIGMAROUND_PAYMENT_TESTER_IDS, or use Live mode to sell to every verified customer.');
  } else {
    let scope: NodeJS.ProcessEnv | null = null;
    try { scope = createLiveBillingScope(env); } catch { /* reported as a missing item */ }
    add('keys', 'Razorpay', 'Razorpay LIVE keys, account id, webhook secret and worker secret are valid', scope !== null,
      `Set RAZORPAY_LIVE_KEY_ID, RAZORPAY_LIVE_KEY_SECRET, RAZORPAY_LIVE_ACCOUNT_ID, RAZORPAY_LIVE_WEBHOOK_SECRET, CLUERA_LIVE_WORKER_SECRET, CLUERA_LIVE_PROJECT_REF, CLUERA_LIVE_ACCOUNT_ORIGIN, CLUERA_LIVE_APPROVED_ORIGIN and CLUERA_LIVE_MERCHANT_DIGEST (scripts/payments/razorpay-go-live.cjs computes the digest). ${guide('Step 3')}`);
    add('approvals', 'Razorpay', 'The four Live approvals are set', ['CLUERA_LIVE_OWNER_APPROVED', 'CLUERA_LIVE_SECURITY_ACCEPTED',
      'CLUERA_LIVE_TEST_ACCEPTED', 'CLUERA_LIVE_RUNTIME_ACCEPTED'].every(name => flag(env, name)),
      'Set CLUERA_LIVE_OWNER_APPROVED, CLUERA_LIVE_SECURITY_ACCEPTED, CLUERA_LIVE_TEST_ACCEPTED and CLUERA_LIVE_RUNTIME_ACCEPTED to true.');
    add('intake', 'Razorpay', 'Live payment confirmations (webhook) are accepted', flag(env, 'CLUERA_LIVE_INTAKE_ENABLED'),
      `Set CLUERA_LIVE_INTAKE_ENABLED=true. ${guide('Step 2')}`);
    add('checkout', 'Razorpay', 'The Live Buy button is switched on', flag(env, 'CLUERA_LIVE_CHECKOUT_ENABLED'),
      'Set CLUERA_LIVE_CHECKOUT_ENABLED=true.');
    add('worker', 'Database', 'The Live credit worker is switched on', flag(env, 'CLUERA_LIVE_SCHEDULER_ENABLED'),
      `Set CLUERA_LIVE_SCHEDULER_ENABLED=true on Vercel and Render. ${guide('Step 4')}`);
    let proofOk = false;
    if (scope && 'liveProof' in evidence) {
      try { assertBillingProfileProof(liveBillingProfile(scope)!, evidence.liveProof, 'checkout', scope); proofOk = true; } catch { /* reported as a missing item */ }
    }
    add('profile', 'Database', 'The database Live profile is installed and promoted', proofOk,
      scope ? `Run the three generated SQL phases (profile, intake, promote) in the Supabase SQL editor. ${guide('Step 5')}`
        : 'Fix the Razorpay Live settings above first; this check needs them.');
    const ids = count(env.CLUERA_LIVE_PURCHASER_IDS), everyone = flag(env, 'CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED');
    audience = everyone ? 'every verified customer' : ids ? 'listed accounts' : 'nobody';
    add('buyers', 'Buyers', everyone ? 'Every verified customer may buy' : ids ? `${ids} account(s) may buy (first real payment)` : 'No account may buy yet', everyone || ids > 0,
      'Put your own Cluera user id in CLUERA_LIVE_PURCHASER_IDS for the first real payment, then set CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED=true to sell to everyone.');
  }
  const pack = evidence.catalog?.find(row => row.offerCode === 'cluera_pack_3h_v2');
  add('catalog', 'Catalog', 'The 3-hour pack is enabled in the catalog', Boolean(pack?.enabled),
    `Admin → Cluera billing → ${live ? 'Live' : 'Test'} catalog: refresh, then enable the 3-hour pack with your authenticator code. ${guide('Step 6')}`);
  return { mode, items, ready: items.every(item => item.ok), audience };
}
