import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { auditCutover, invocation } = require('../../scripts/payments/audit-cluera-cutover.cjs');
const webhookId = 'TmqOkUNGtvEPLz', orderId = 'order_synthetic0001';
const intentId = '00000000-0000-4000-8000-000000000821';
const accountId = 'acc_synthetic123456';
const options = { phase: 'account', expectedWebhookId: webhookId, canonicalOrderId: orderId, canonicalIntentId: intentId };
const env = () => ({ VERCEL_PROJECT_ID: 'prj_VuG3xCUQqKmPhT0LIAmLuyUwBXg6', VERCEL_ENV: 'production',
  SIGMAROUND_ACCOUNTS_ENABLED: 'true', SIGMAROUND_ACCOUNT_ORIGIN: 'https://sigmaround-account-staging.vercel.app',
  NEXT_PUBLIC_SUPABASE_URL: 'https://dwqltsqumiwsxtkzdoaa.supabase.co', SIGMAROUND_RAZORPAY_TEST_PROJECT_REF: 'dwqltsqumiwsxtkzdoaa',
  SIGMAROUND_PAYMENT_PROVIDER: 'razorpay', RAZORPAY_ENVIRONMENT: 'test',
  SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED: 'true', SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED: 'false', SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED: 'false',
  RAZORPAY_TEST_KEY_ID: 'rzp_test_synthetic123456', RAZORPAY_TEST_KEY_SECRET: 'synthetic-api-secret-not-a-real-key',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'synthetic-webhook-secret-not-a-real-secret-1234', RAZORPAY_TEST_ACCOUNT_ID: accountId });
const webhook = () => ({ id: webhookId, url: 'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook',
  owner_type: 'merchant', owner_id: accountId.slice(4), service: 'beta-api-test', active: true, disabled_at: 123,
  secret_exists: true, events: { 'payment.captured': 1, 'order.paid': 1, 'refund.processed': 1, 'payment.failed': 0 } });
const order = () => ({ id: orderId, entity: 'order', amount: 54900, currency: 'INR', receipt: intentId,
  amount_paid: 0, amount_due: 54900, attempts: 0, status: 'created', notes: { sigma_intent: intentId,
    sigma_offer: 'pro_3_hours', sigma_environment: 'test' } });
const payment = (id = 'pay_synthetic0001') => ({ id, entity: 'payment', order_id: orderId, amount: 54900, currency: 'INR',
  invoice_id: null, international: false, status: 'captured', captured: true, amount_refunded: 0, refund_status: null });
function fake(overrides: { webhook?: any; order?: any; payments?: any[]; direct?: any; list?: any } = {}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET'); expect(init.redirect).toBe('error'); expect(init.cache).toBe('no-store');
    expect(new URL(url).origin).toBe('https://api.razorpay.com');
    const path = new URL(url).pathname;
    return Response.json(path === '/v1/webhooks' ? overrides.list ?? { entity: 'collection', count: 1, items: [overrides.webhook ?? webhook()] }
      : path.startsWith('/v1/webhooks/') ? overrides.direct ?? overrides.webhook ?? webhook()
        : path.endsWith('/payments') ? { entity: 'collection', count: overrides.payments?.length ?? 0, items: overrides.payments ?? [] }
          : overrides.order ?? order());
  });
}
afterEach(() => vi.useRealTimers());

it('imports without side effects and requires exact non-secret canonical CLI pins', () => {
  expect(invocation(['account', webhookId, orderId, intentId])).toEqual(options);
  expect(invocation([])).toEqual({}); expect(invocation(['account', webhookId, orderId, intentId, '--live'])).toEqual({});
});
it('reads only the exact Test webhook and canonical order/payments; emits no identifiers or secrets and changes no actual flag', async () => {
  const source = env(), original = { ...source }, request = fake();
  const report = await auditCutover(source, request, options);
  expect(report.stopped).toBe('COMPLETE'); expect(report.financialState).toBe('UNPAID'); expect(report.requests).toBe(4); expect(report.mutations).toBe(0);
  expect(report.directWebhook).toMatchObject({ active: true, activeIsBoolean: true, merchantMatches: true, exactEvents: true, signerMatch: 'UNVERIFIED' });
  expect(source).toEqual(original);
  const output = JSON.stringify(report);
  for (const secret of [source.RAZORPAY_TEST_KEY_ID, source.RAZORPAY_TEST_KEY_SECRET, source.RAZORPAY_TEST_WEBHOOK_SECRET,
    accountId, orderId, intentId, webhookId, Buffer.from(source.RAZORPAY_TEST_KEY_ID + ':' + source.RAZORPAY_TEST_KEY_SECRET).toString('base64')]) expect(output).not.toContain(secret);
  expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/v1/webhooks', '/v1/webhooks/' + webhookId, '/v1/orders/' + orderId, '/v1/orders/' + orderId + '/payments']);
});
it.each([
  { VERCEL_PROJECT_ID: 'other-project' }, { VERCEL_ENV: 'preview' }, { SIGMAROUND_ACCOUNTS_ENABLED: undefined, SIGMAROUND_ACCOUNT_ENABLED: 'true' },
  { SIGMAROUND_ACCOUNT_ORIGIN: 'https://cluera-ai-staging.vercel.app' }, { NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co' },
  { RAZORPAY_ENVIRONMENT: 'live' }, { RAZORPAY_TEST_KEY_ID: 'rzp_live_synthetic123456' }, { RAZORPAY_TEST_WEBHOOK_SECRET: 'short' },
  { SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED: 'false' }, { SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false' },
])('rejects wrong-target/Live/singular/disabled compatibility configuration before any provider request: %j', async change => {
  const request = fake(); const report = await auditCutover({ ...env(), ...change }, request, options);
  expect(report.stopped).toBe('CONFIGURATION'); expect(report.requests).toBe(0); expect(request).not.toHaveBeenCalled();
});
it('supports only the fixed disabled Cluera pre-cutover phase without changing the still-old provider destination', async () => {
  const source = { ...env(), VERCEL_PROJECT_ID: 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B', SIGMAROUND_ACCOUNT_ORIGIN: 'https://cluera-ai-staging.vercel.app',
    SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED: 'false', SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false', SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED: 'true',
    CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false', CLUERA_BILLING_V2_ENABLED: 'false' };
  const request = fake(), report = await auditCutover(source, request, { ...options, phase: 'cluera' });
  expect(report.stopped).toBe('COMPLETE'); expect(report.configuration.switchesMatch).toBe(true);
  const active = await auditCutover({ ...source, CLUERA_BILLING_V2_ENABLED: 'true' }, request, { ...options, phase: 'cluera' });
  expect(active.stopped).toBe('CONFIGURATION'); expect(active.requests).toBe(0);
});
it.each([
  { expectedWebhookId: 'differentId0001' }, { canonicalOrderId: 'order_synthetic0001?extra=1' }, { canonicalIntentId: 'invalid' },
  { phase: 'live' }, { target: 'https://foreign.example' },
])('rejects unsupported input/target/financial-list overrides before requests: %j', async change => {
  const request = fake(); const report = await auditCutover(env(), request, { ...options, ...change });
  expect(report.stopped).toBe('INPUT'); expect(report.requests).toBe(0); expect(request).not.toHaveBeenCalled();
});
it.each([
  { active: false }, { active: 1 }, { active: 'true' }, { owner_id: 'foreignMerchant0001' }, { owner_type: 'account' }, { service: 'api-live' },
  { url: 'https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook' }, { secret_exists: false },
  { events: ['payment.captured', 'order.paid', 'order.paid'] }, { events: ['payment.captured', 'order.paid', 'refund.processed', 'subscription.charged'] },
])('stops on unmatched/raw-inactive destination before reading any financial record: %j', async change => {
  const request = fake({ webhook: { ...webhook(), ...change } }); const report = await auditCutover(env(), request, options);
  expect(report.stopped).toBe('WEBHOOK_IDENTITY'); expect(report.requests).toBe(1); expect(request.mock.calls.some(([url]) => url.includes('/orders'))).toBe(false);
});
it('requires direct primary-v1 identity equality after complete listing; unavailable/foreign records never authorize order reads', async () => {
  const request = fake({ direct: { ...webhook(), owner_id: 'foreignMerchant0001' } });
  const report = await auditCutover(env(), request, options); expect(report.stopped).toBe('WEBHOOK_IDENTITY'); expect(report.requests).toBe(2);
});
it('unknown disabled_at history never overrides a raw true active flag', async () => {
  const request = fake({ webhook: { ...webhook(), disabled_at: 1791941000 } });
  expect((await auditCutover(env(), request, options)).stopped).toBe('COMPLETE');
});
it('supports documented/observed array and items listing wrappers, while rejecting malformed supplied metadata', async () => {
  for (const list of [[webhook()], { items: [webhook()] }, { count: 1, items: [webhook()] }]) {
    expect((await auditCutover(env(), fake({ list }), options)).stopped).toBe('COMPLETE');
  }
  expect((await auditCutover(env(), fake({ list: { entity: 'foreign', count: 1, items: [webhook()] } }), options)).stopped).toBe('WEBHOOK_READ');
});
it('rejects duplicate literal destinations and duplicate listing IDs without making guessed direct/order requests', async () => {
  const duplicate = [webhook(), { ...webhook(), id: 'anotherWebhook0001' }];
  const request = fake({ list: { entity: 'collection', count: 2, items: duplicate } });
  expect((await auditCutover(env(), request, options)).stopped).toBe('WEBHOOK_IDENTITY'); expect(request).toHaveBeenCalledOnce();
  const repeated = fake({ list: { entity: 'collection', count: 2, items: [webhook(), webhook()] } });
  expect((await auditCutover(env(), repeated, options)).stopped).toBe('WEBHOOK_READ'); expect(repeated).toHaveBeenCalledOnce();
});
it.each([
  { receipt: '00000000-0000-4000-8000-000000000999' }, { amount: 55000 }, { currency: 'USD' }, { status: 'paid', amount_paid: 0 },
  { notes: { sigma_intent: intentId, sigma_offer: 'cluera_pack_3h_v2', sigma_environment: 'test' } },
])('rejects a wrong owned order policy before payment enumeration: %j', async change => {
  const request = fake({ order: { ...order(), ...change } }), report = await auditCutover(env(), request, options);
  expect(report.stopped).toBe('OWNED_ORDER_IDENTITY'); expect(report.requests).toBe(3);
});
it('reports an independently captured canonical full order without granting credits or claiming signer matching', async () => {
  const request = fake({ order: { ...order(), status: 'paid', amount_paid: 54900, amount_due: 0, attempts: 1 }, payments: [payment()] });
  const report = await auditCutover(env(), request, options); expect(report.financialState).toBe('CAPTURED'); expect(report.signerMatch).toBe('UNVERIFIED');
  expect(report.payments.statuses.CAPTURED).toBe(1); expect(report.mutations).toBe(0);
});
it('reports authorized/duplicate-capture inconsistencies as review, without creating/retrying payments', async () => {
  const authorized = fake({ order: { ...order(), status: 'attempted', attempts: 1 }, payments: [{ ...payment(), captured: false, status: 'authorized' }] });
  expect((await auditCutover(env(), authorized, options)).financialState).toBe('REVIEW');
  const duplicate = fake({ order: { ...order(), status: 'paid', amount_paid: 54900, amount_due: 0, attempts: 2 }, payments: [payment(), payment('pay_synthetic0002')] });
  expect((await auditCutover(env(), duplicate, options)).financialState).toBe('REVIEW');
});
it.each([
  { order_id: 'order_foreign0001' }, { invoice_id: 'inv_synthetic0001' }, { amount: 55000 },
  { captured: 'true' }, { amount_refunded: 100, refund_status: 'partial' },
])('keeps foreign/partial/unknown payment evidence review-only: %j', async change => {
  const request = fake({ payments: [{ ...payment(), ...change }] }); const report = await auditCutover(env(), request, options);
  expect(report.stopped).toBe('OWNED_PAYMENT_EVIDENCE'); expect(report.mutations).toBe(0);
});
it('separates reported FAILED from canonical evidence when an optional invoice field is absent, without inferring no charge', async () => {
  const record:any={...payment(),status:'failed',captured:false,error_code:'synthetic-private-error',error_description:'synthetic-private-description',email:'synthetic-private-customer'};
  delete record.invoice_id;
  const report=await auditCutover(env(),fake({order:{...order(),status:'attempted',attempts:1},payments:[record]}),options);
  expect(report.stopped).toBe('OWNED_PAYMENT_EVIDENCE'); expect(report.financialState).toBeUndefined();
  expect(report.payments).toMatchObject({count:1,canonicalEvidence:false,statuses:{FAILED:0},reportedStatuses:{FAILED:1,UNKNOWN:0},
    validation:{knownStatus:true,canonicalOrder:true,approvedAmount:true,invoiceNull:false,stateConsistent:true},
    validationFailures:{invoiceNull:1,approvedAmount:0},shape:{invoiceFieldPresent:false,internationalFieldPresent:true}});
  for(const privateValue of [record.id,record.order_id,record.email,record.error_code,record.error_description,accountId,intentId])expect(JSON.stringify(report)).not.toContain(privateValue);
});
it.each([
  {field:'international',check:'domesticFalse',present:'internationalFieldPresent'},
  {field:'captured',check:'capturedBoolean',present:'capturedFieldPresent'},
  {field:'amount_refunded',check:'refundAmountBounded',present:'amountRefundedFieldPresent'},
  {field:'refund_status',check:'refundStatusKnown',present:'refundStatusFieldPresent'},
])('emits only fixed field-presence and strict-policy reasons for omitted $field',async({field,check,present})=>{
  const record:any={...payment(),status:'failed',captured:false}; delete record[field];
  const report=await auditCutover(env(),fake({payments:[record]}),options);
  expect(report.stopped).toBe('OWNED_PAYMENT_EVIDENCE');expect(report.payments.reportedStatuses.FAILED).toBe(1);
  expect(report.payments.validation[check]).toBe(false);expect(report.payments.validationFailures[check]).toBe(1);expect(report.payments.shape[present]).toBe(false);
  expect(report.financialState).toBeUndefined();expect(report.requests).toBe(4);expect(report.mutations).toBe(0);
});
it('tallies every bounded reported state even after a bad first record, without accepting the collection as evidence',async()=>{
  const bad:any={...payment(),status:'failed',captured:false};delete bad.invoice_id;
  const report=await auditCutover(env(),fake({payments:[bad,payment('pay_synthetic0002'),{...payment('pay_synthetic0003'),status:'synthetic-private-status'}]}),options);
  expect(report.stopped).toBe('OWNED_PAYMENT_EVIDENCE');expect(report.payments.reportedStatuses).toEqual({CREATED:0,AUTHORIZED:0,CAPTURED:1,REFUNDED:0,FAILED:1,UNKNOWN:1});
  expect(report.payments.statuses).toEqual({CREATED:0,AUTHORIZED:0,CAPTURED:1,REFUNDED:0,FAILED:0});
  expect(report.payments.validationFailures.knownStatus).toBe(1);expect(report.payments.canonicalEvidence).toBe(false);
  expect(report.financialState).toBeUndefined();expect(JSON.stringify(report)).not.toContain('synthetic-private-status');
});
it('reports duplicate identifiers as a boolean/count only even when the first record already failed another policy',async()=>{
  const first:any={...payment(),international:null};const report=await auditCutover(env(),fake({payments:[first,payment()]}),options);
  expect(report.payments.validation.paymentIdUnique).toBe(false);expect(report.payments.validationFailures.paymentIdUnique).toBe(1);
  expect(report.payments.reportedStatuses.CAPTURED).toBe(2);expect(report.payments.statuses.CAPTURED).toBe(0);
  expect(report.stopped).toBe('OWNED_PAYMENT_EVIDENCE');expect(JSON.stringify(report)).not.toContain(first.id);
});
it('does not reveal raw provider authentication errors', async () => {
  const request = vi.fn(async () => Response.json({ error: 'synthetic-private-key-value' }, { status: 401 }));
  const report = await auditCutover(env(), request, options); expect(report.stopped).toBe('WEBHOOK_READ'); expect(report.requests).toBe(1);
  expect(JSON.stringify(report)).not.toContain('synthetic-private-key-value');
});
it('bounds oversized bodies before parsing private response fragments', async () => {
  const request = vi.fn(async () => new Response('x'.repeat(262145)));
  const report = await auditCutover(env(), request, options); expect(report.stopped).toBe('WEBHOOK_READ'); expect(report.requests).toBe(1);
});
it('enforces its 10-second deadline even if a synthetic fetch ignores AbortSignal', async () => {
  vi.useFakeTimers(); const request = vi.fn(() => new Promise<Response>(() => {}));
  const pending = auditCutover(env(), request, options); await vi.advanceTimersByTimeAsync(10001);
  const report = await pending; expect(report.stopped).toBe('WEBHOOK_READ'); expect(report.requests).toBe(1);
});
