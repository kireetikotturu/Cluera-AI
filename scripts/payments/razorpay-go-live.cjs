'use strict';
// Go-live helper for Razorpay. Prints non-secret values and review-only SQL.
// It never reads environment credentials, never contacts a service, never
// writes files and never executes SQL. Secrets it generates are printed once
// to your terminal so you can paste them into Vercel/Render and Razorpay.
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { prepare } = require('./prepare-cluera-live-profile.cjs');

const ORIGIN = 'https://cluera-ai-staging.vercel.app';
const PROJECT = 'yhnqlfcgrmckhyjdxegg';
const USAGE = `Usage:
  node scripts/payments/razorpay-go-live.cjs secrets
  node scripts/payments/razorpay-go-live.cjs plan --key-id rzp_live_XXXX --account-id acc_XXXX [--epoch N]
  node scripts/payments/razorpay-go-live.cjs sql --phase profile|intake|promote --key-id rzp_live_XXXX --account-id acc_XXXX --epoch N [--acceptance <64 hex>]`;

const sha = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(48).toString('base64url');
const fail = message => { throw Object.assign(new Error(message), { friendly: true }); };

function merchantDigest(keyId, accountId) {
  if (!/^rzp_live_[A-Za-z0-9]{8,64}$/.test(keyId ?? '')) fail('--key-id must be your LIVE key id (rzp_live_...). Test keys are not accepted here.');
  if (!/^acc_[A-Za-z0-9]{8,64}$/.test(accountId ?? '')) fail('--account-id must look like acc_XXXXXXXX (Razorpay Dashboard > Account & Settings).');
  return sha(`razorpay:live:${accountId}:${keyId}`);
}
function parse(argv) {
  const [command, ...rest] = argv, options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!/^--(key-id|account-id|epoch|phase|acceptance)$/.test(name ?? '') || rest[i + 1] === undefined) fail(`Unknown or incomplete option: ${name}`);
    options[name.slice(2)] = rest[i + 1];
  }
  return { command, options };
}
function secrets() {
  return `Two NEW random secrets (shown once - paste them, do not save them in a file or chat):

RAZORPAY_LIVE_WEBHOOK_SECRET = ${secret()}
CLUERA_LIVE_WORKER_SECRET    = ${secret()}

Use the first as the Secret of the Razorpay LIVE webhook and as RAZORPAY_LIVE_WEBHOOK_SECRET in Vercel.
Use the second as CLUERA_LIVE_WORKER_SECRET in BOTH Vercel and Render. They must be different from each other.
`;
}
function plan({ 'key-id': keyId, 'account-id': accountId, epoch }) {
  const digest = merchantDigest(keyId, accountId), at = epoch ?? '<epoch from step 5>';
  return `LIVE merchant digest: ${digest}

=== Razorpay (Live mode) webhook ===
URL:    ${ORIGIN}/api/account/payments/cluera/live/webhook
Events: payment.captured, order.paid, refund.processed
        (for monthly plans later also: subscription.authenticated, subscription.activated, subscription.charged,
         subscription.pending, subscription.halted, subscription.cancelled, subscription.paused,
         subscription.resumed, subscription.completed, subscription.updated)
Secret: the RAZORPAY_LIVE_WEBHOOK_SECRET from "secrets"

=== Vercel (Production environment, all Sensitive except flags) ===
CLUERA_BILLING_V2_ENABLED=true
CLUERA_BILLING_UI_MODE=live
RAZORPAY_LIVE_KEY_ID=${keyId}
RAZORPAY_LIVE_KEY_SECRET=<paste from Razorpay>
RAZORPAY_LIVE_ACCOUNT_ID=${accountId}
RAZORPAY_LIVE_WEBHOOK_SECRET=<from "secrets">
CLUERA_LIVE_WORKER_SECRET=<from "secrets">
CLUERA_LIVE_PROJECT_REF=${PROJECT}
CLUERA_LIVE_ACCOUNT_ORIGIN=${ORIGIN}
CLUERA_LIVE_APPROVED_ORIGIN=${ORIGIN}
CLUERA_LIVE_MERCHANT_DIGEST=${digest}
CLUERA_LIVE_OWNER_APPROVED=true
CLUERA_LIVE_SECURITY_ACCEPTED=true
CLUERA_LIVE_TEST_ACCEPTED=true
CLUERA_LIVE_RUNTIME_ACCEPTED=true
CLUERA_LIVE_INTAKE_ENABLED=true
CLUERA_LIVE_SCHEDULER_ENABLED=true
CLUERA_LIVE_HISTORY_ENABLED=true
CLUERA_LIVE_ADMIN_ENABLED=true
CLUERA_LIVE_CHECKOUT_ENABLED=true
CLUERA_LIVE_PURCHASER_IDS=<your own Cluera user id - first real payment only>
# After the first real payment works, add:  CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED=true

=== Render (relay service) ===
CLUERA_LIVE_OWNER_APPROVED=true
CLUERA_LIVE_RUNTIME_ACCEPTED=true
CLUERA_LIVE_SCHEDULER_ENABLED=true
CLUERA_LIVE_WORKER_EPOCH=${at}
CLUERA_LIVE_WORKER_SECRET=<same as Vercel>
CLUERA_LIVE_ACCOUNT_ORIGIN=${ORIGIN}
CLUERA_LIVE_APPROVED_ORIGIN=${ORIGIN}
CLUERA_LIVE_MERCHANT_DIGEST=${digest}
NEXT_PUBLIC_SUPABASE_URL=https://${PROJECT}.supabase.co
`;
}
function sql({ phase, 'key-id': keyId, 'account-id': accountId, epoch, acceptance }) {
  if (!['profile', 'intake', 'promote'].includes(phase)) fail('--phase must be profile, intake or promote.');
  const merchant = merchantDigest(keyId, accountId), expectedEpoch = Number(epoch);
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) fail('--epoch must be the current number from: select epoch from cluera_live_billing_private.processing_owner;');
  // The acceptance digest only labels this approved change; promote must reuse the intake value.
  const acceptanceDigest = acceptance ?? sha(`cluera-live-go-live:${merchant}`);
  if (!/^[a-f0-9]{64}$/.test(acceptanceDigest)) fail('--acceptance must be 64 lowercase hex characters.');
  return prepare({ phase, merchantDigest: merchant, origin: ORIGIN, acceptanceDigest, operationId: randomUUID(), expectedEpoch });
}

module.exports = { merchantDigest, plan, sql, secrets };
if (require.main === module) {
  try {
    const { command, options } = parse(process.argv.slice(2));
    if (command === 'secrets' && !Object.keys(options).length) process.stdout.write(secrets());
    else if (command === 'plan') process.stdout.write(plan(options));
    else if (command === 'sql') process.stdout.write(sql(options));
    else { console.error(USAGE); process.exitCode = 1; }
  } catch (error) {
    console.error(error.friendly ? error.message : 'Could not complete. Check the options.\n' + USAGE);
    process.exitCode = 1;
  }
}
