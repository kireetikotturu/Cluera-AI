'use strict';

// Operator-only private GET diagnostic. Never imported by application routes,
// never mutates settings/resources, never builds or promotes a website artifact.
const { createHash, timingSafeEqual } = require('node:crypto');
const targets = Object.freeze({
  account: Object.freeze({ project: 'prj_VuG3xCUQqKmPhT0LIAmLuyUwBXg6', origin: 'https://sigmaround-account-staging.vercel.app' }),
  cluera: Object.freeze({ project: 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B', origin: 'https://cluera-ai-staging.vercel.app' }),
});
const endpoint = 'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook';
const webhookId = 'TmqOkUNGtvEPLz';
const requiredEvents = ['payment.captured', 'order.paid', 'refund.processed'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
  && timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
const flag = value => value === true || value === 1 || value === 'true' ? true
  : value === false || value === 0 || value === 'false' ? false : null;
function selection(value) {
  if (Array.isArray(value)) return value.every(item => typeof item === 'string')
    && new Set(value).size === value.length ? value : null;
  if (!value || typeof value !== 'object') return null;
  const rows = Object.entries(value); if (rows.some(([, active]) => flag(active) === null)) return null;
  return rows.filter(([, active]) => flag(active) === true).map(([name]) => name);
}
function webhookSummary(row, account, expected) {
  const events = selection(row?.events);
  return { idMatches: row?.id === expected, destinationMatches: row?.url === endpoint,
    testService: ['beta-api-test', 'api-test'].includes(row?.service), merchantOwner: row?.owner_type === 'merchant',
    merchantMatches: equal(row?.owner_id, account) || equal(row?.owner_id, account.slice(4)),
    // raw boolean current flag only; a historical disabled_at marker must not override it.
    active: row?.active === true, activeIsBoolean: typeof row?.active === 'boolean',
    exactEvents: Boolean(events && events.length === 3 && requiredEvents.every(event => events.includes(event))),
    eventCount: events?.length ?? 0, signerPresent: row?.secret_exists === true, signerMatch: 'UNVERIFIED' };
}
function configuration(env, options) {
  const target = targets[options.phase];
  const scoped = Boolean(target && env.VERCEL_PROJECT_ID === target.project && env.VERCEL_ENV === 'production'
    && env.SIGMAROUND_ACCOUNTS_ENABLED === 'true' && env.SIGMAROUND_ACCOUNT_ORIGIN === target.origin
    && env.NEXT_PUBLIC_SUPABASE_URL === 'https://dwqltsqumiwsxtkzdoaa.supabase.co'
    && env.SIGMAROUND_RAZORPAY_TEST_PROJECT_REF === 'dwqltsqumiwsxtkzdoaa'
    && env.SIGMAROUND_PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_ENVIRONMENT === 'test');
  const switches = env.SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED === 'false' && (options.phase === 'account'
    ? env.SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED === 'true' && env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED === 'true'
      && env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED === 'false'
    : env.SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED === 'false' && env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED === 'false'
      && env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED === 'true' && env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED === 'false'
      && (env.CLUERA_BILLING_V2_ENABLED === undefined || env.CLUERA_BILLING_V2_ENABLED === 'false'));
  const formats = { testKeyId: /^rzp_test_[A-Za-z0-9]{8,64}$/.test(env.RAZORPAY_TEST_KEY_ID ?? ''),
    apiSecret: typeof env.RAZORPAY_TEST_KEY_SECRET === 'string' && env.RAZORPAY_TEST_KEY_SECRET.length >= 16 && env.RAZORPAY_TEST_KEY_SECRET.length <= 256,
    webhookSecret: typeof env.RAZORPAY_TEST_WEBHOOK_SECRET === 'string' && env.RAZORPAY_TEST_WEBHOOK_SECRET.length >= 32 && env.RAZORPAY_TEST_WEBHOOK_SECRET.length <= 256,
    merchantId: /^acc_[A-Za-z0-9]{8,64}$/.test(env.RAZORPAY_TEST_ACCOUNT_ID ?? '') };
  return { exactTarget: scoped, switchesMatch: switches, formats };
}

async function auditCutover(env = process.env, request = fetch, options = {}) {
  const report = { component: 'cluera-billing-cutover-get-only', phase: Object.hasOwn(targets, options?.phase) ? options.phase : 'unknown',
    requests: 0, mutations: 0, signerMatch: 'UNVERIFIED' };
  const finish = stopped => ({ ...report, stopped, completedAt: new Date().toISOString() });
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['phase', 'expectedWebhookId', 'canonicalOrderId', 'canonicalIntentId'].includes(key))
    || !Object.hasOwn(targets, options.phase) || options.expectedWebhookId !== webhookId
    || !/^order_[A-Za-z0-9]{8,64}$/.test(options.canonicalOrderId ?? '') || !uuid.test(options.canonicalIntentId ?? '')) return finish('INPUT');
  report.configuration = configuration(env, options);
  if (!report.configuration.exactTarget || !report.configuration.switchesMatch
    || Object.values(report.configuration.formats).some(value => value !== true)) return finish('CONFIGURATION');
  const headers = { Authorization: 'Basic ' + Buffer.from(env.RAZORPAY_TEST_KEY_ID + ':' + env.RAZORPAY_TEST_KEY_SECRET).toString('base64'), Accept: 'application/json' };
  const allowed = path => path === '/v1/webhooks/' + webhookId
    || path === '/v1/orders/' + options.canonicalOrderId || path === '/v1/orders/' + options.canonicalOrderId + '/payments'
    || /^\/v1\/webhooks\?count=100&skip=(?:0|100|200|300|400|500|600|700|800|900)$/.test(path);
  async function get(path) {
    if (!allowed(path)) throw Error('Bounded read rejected.');
    report.requests++;
    const controller = new AbortController(); let reader, timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Read unavailable.')); }, 10_000); });
    try {
      const response = await Promise.race([request('https://api.razorpay.com' + path,
        { method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal, headers }), expired]);
      if (response.redirected || response.status !== 200 || !response.body
        || Number(response.headers.get('content-length')) > 262144) throw Error('Read unavailable.');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) { const chunk = await Promise.race([reader.read(), expired]); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 262144) throw Error('Bounded response rejected.'); chunks.push(chunk.value); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
      clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {});
      try { reader?.releaseLock(); } catch { /* cancellation already requested */ }
    }
  }
  let stage = 'WEBHOOK_READ';
  try {
    const ids = new Set(); let listed, matches = 0, complete = false, total = 0, pages = 0;
    for (let page = 0; page < 10; page++) {
      const raw = await get('/v1/webhooks?count=100&skip=' + page * 100);
      // Merchant-v1 listing has appeared as an array or items wrapper. Optional
      // wrapper metadata must be valid when supplied; identity is pinned below.
      const rows = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items)
        && (raw.entity === undefined || raw.entity === 'collection')
        && (raw.count === undefined || raw.count === raw.items.length) ? raw.items : null;
      if (!rows || rows.length > 100) throw Error('Invalid collection.');
      pages++; total += rows.length;
      for (const row of rows) {
        if (typeof row?.id !== 'string' || ids.has(row.id)) throw Error('Invalid collection.'); ids.add(row.id);
        if (row.id === webhookId) listed = row;
        if (row.url === endpoint) matches++;
      }
      if (rows.length < 100) { complete = true; break; }
    }
    report.webhookListing = { complete, pages, total, exactDestinationCount: matches, exactIdFound: Boolean(listed) };
    if (!complete || matches !== 1 || !listed) return finish('WEBHOOK_IDENTITY');
    report.listedWebhook = webhookSummary(listed, env.RAZORPAY_TEST_ACCOUNT_ID, webhookId);
    const accepted = row => ['idMatches', 'destinationMatches', 'testService', 'merchantOwner', 'merchantMatches', 'active', 'activeIsBoolean', 'exactEvents', 'signerPresent'].every(key => row[key] === true);
    if (!accepted(report.listedWebhook)) return finish('WEBHOOK_IDENTITY');
    const direct = await get('/v1/webhooks/' + webhookId);
    report.directWebhook = webhookSummary(direct, env.RAZORPAY_TEST_ACCOUNT_ID, webhookId);
    if (!accepted(report.directWebhook)) return finish('WEBHOOK_IDENTITY');
    report.testAuthentication = true; report.merchantIdentityVerified = true;
    stage = 'OWNED_ORDER_READ';
    const order = await get('/v1/orders/' + options.canonicalOrderId);
    const status = ['created', 'attempted', 'paid'].includes(order?.status) ? order.status.toUpperCase() : 'UNKNOWN';
    const owned = order?.entity === 'order' && order.id === options.canonicalOrderId && order.receipt === options.canonicalIntentId
      && order.notes?.sigma_intent === options.canonicalIntentId && order.notes?.sigma_offer === 'pro_3_hours'
      && order.notes?.sigma_environment === 'test';
    const policy = order?.amount === 54900 && order.currency === 'INR' && (order.offer_id === undefined || order.offer_id === null)
      && (order.partial_payment === undefined || order.partial_payment === false) && Number.isInteger(order.attempts) && order.attempts >= 0
      && (status === 'PAID' ? order.amount_paid === 54900 && order.amount_due === 0
        : ['CREATED', 'ATTEMPTED'].includes(status) && order.amount_paid === 0 && order.amount_due === 54900);
    report.order = { canonicalBinding: owned, approvedAmount: policy, status };
    if (!owned || !policy) return finish('OWNED_ORDER_IDENTITY');
    stage = 'OWNED_PAYMENTS_READ';
    const payments = await get('/v1/orders/' + options.canonicalOrderId + '/payments');
    if (payments?.entity !== 'collection' || !Array.isArray(payments.items) || payments.items.length > 100
      || payments.count !== payments.items.length) throw Error('Invalid collection.');
    const counts = { CREATED: 0, AUTHORIZED: 0, CAPTURED: 0, REFUNDED: 0, FAILED: 0 };
    const reportedStatuses = { ...counts, UNKNOWN: 0 }, paymentIds = new Set();
    // These are fixed policy checks, not provider values. Reported status is
    // independently tallied even when the record is unusable as financial
    // authority. Missing optional fields remain a strict failure here; this
    // diagnostic must never silently normalize application payment evidence.
    const validation = { knownStatus: true, paymentIdValid: true, paymentIdUnique: true, paymentEntity: true,
      canonicalOrder: true, approvedAmount: true, currencyINR: true, invoiceNull: true, domesticFalse: true,
      capturedBoolean: true, refundAmountBounded: true, refundStatusKnown: true, stateConsistent: true };
    const validationFailures = Object.fromEntries(Object.keys(validation).map(key => [key, 0]));
    const shape = { invoiceFieldPresent: true, internationalFieldPresent: true, capturedFieldPresent: true,
      amountRefundedFieldPresent: true, refundStatusFieldPresent: true };
    let valid = true;
    for (const payment of payments.items) {
      const state = typeof payment?.status === 'string' ? payment.status.toUpperCase() : 'UNKNOWN';
      const known = Object.hasOwn(counts, state), row = payment && typeof payment === 'object' && !Array.isArray(payment) ? payment : {};
      reportedStatuses[known ? state : 'UNKNOWN']++;
      const checks = { knownStatus: known, paymentIdValid: /^pay_[A-Za-z0-9]{8,64}$/.test(row.id ?? ''),
        paymentIdUnique: !paymentIds.has(row.id), paymentEntity: row.entity === 'payment', canonicalOrder: row.order_id === options.canonicalOrderId,
        approvedAmount: row.amount === 54900, currencyINR: row.currency === 'INR', invoiceNull: row.invoice_id === null,
        domesticFalse: row.international === false, capturedBoolean: typeof row.captured === 'boolean',
        refundAmountBounded: Number.isInteger(row.amount_refunded) && row.amount_refunded >= 0 && row.amount_refunded <= 54900,
        refundStatusKnown: [null, 'partial', 'full'].includes(row.refund_status),
        stateConsistent: known && (state === 'CAPTURED' ? row.captured === true && row.amount_refunded === 0 && row.refund_status === null
          : state === 'REFUNDED' ? row.captured === true && row.amount_refunded === 54900 && row.refund_status === 'full'
            : row.captured === false && row.amount_refunded === 0 && row.refund_status === null) };
      for (const key of Object.keys(validation)) if (!checks[key]) { validation[key] = false; validationFailures[key]++; }
      for (const [key, field] of [['invoiceFieldPresent', 'invoice_id'], ['internationalFieldPresent', 'international'],
        ['capturedFieldPresent', 'captured'], ['amountRefundedFieldPresent', 'amount_refunded'], ['refundStatusFieldPresent', 'refund_status']]) {
        shape[key] = shape[key] && Object.hasOwn(row, field);
      }
      if (typeof row.id === 'string') paymentIds.add(row.id);
      if (Object.values(checks).every(value => value === true)) counts[state]++;
      else valid = false;
    }
    report.payments = { count: payments.items.length, canonicalEvidence: valid, statuses: counts,
      reportedStatuses, validation, validationFailures, shape };
    if (!valid) return finish('OWNED_PAYMENT_EVIDENCE');
    report.financialState = counts.CAPTURED === 1 && counts.REFUNDED === 0 && counts.AUTHORIZED === 0 && status === 'PAID' ? 'CAPTURED'
      : counts.REFUNDED === 1 && counts.CAPTURED === 0 && counts.AUTHORIZED === 0 && status === 'PAID' ? 'REFUNDED'
        : counts.CAPTURED === 0 && counts.REFUNDED === 0 && counts.AUTHORIZED === 0 && status !== 'PAID' ? 'UNPAID' : 'REVIEW';
    return finish('COMPLETE');
  } catch { return finish(stage); }
}
function invocation(args) {
  return args.length === 4 ? { phase: args[0], expectedWebhookId: args[1], canonicalOrderId: args[2], canonicalIntentId: args[3] } : {};
}
if (require.main === module) {
  auditCutover(process.env, fetch, invocation(process.argv.slice(2)))
    .then(report => { console.log('CLUERA_SAFE_CUTOVER_AUDIT ' + JSON.stringify(report)); process.exitCode = 1; })
    .catch(() => { console.log('CLUERA_SAFE_CUTOVER_AUDIT ' + JSON.stringify({ component: 'cluera-billing-cutover-get-only', stopped: 'UNAVAILABLE', mutations: 0 })); process.exitCode = 1; });
}
module.exports = { auditCutover, invocation };
