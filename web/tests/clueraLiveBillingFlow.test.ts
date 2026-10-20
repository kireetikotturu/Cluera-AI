import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { paymentLiveEnvironment as input } from './helpers/paymentLiveMode';
import { createLiveBillingScope, liveBillingRpc } from '../lib/payments/cluera/modeProfile';
import { createClueraCheckout, verifyClueraCallback } from '../lib/payments/cluera/checkout';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { handleLiveWebhook, handleLiveTick } from '../lib/payments/cluera/liveWorker';
import { reconcileClueraPayment } from '../lib/payments/cluera/reconciliation';
import { readClueraBillingHistory } from '../lib/payments/cluera/history';
import { workerProofMessage } from '../lib/payments/cluera/scheduler';
import type { PaymentRpc } from '../lib/payments/core/types';
import type { Revision } from '../lib/payments/cluera/contracts';
import { cancelClueraSubscription } from '../lib/payments/cluera/cancellation';
const { prepare } = createRequire(import.meta.url)('../../scripts/prepare-cluera-live-schema.cjs');
const account = { userId: input.CLUERA_LIVE_PURCHASER_IDS, sessionId: randomUUID() };
const digest = input.CLUERA_LIVE_MERCHANT_DIGEST, orderId = 'order_isolatedlive0001', paymentId = 'pay_isolatedlive0001';
let db: PGlite;
const rawRpc: PaymentRpc = async (name, args) => {
  if (!/^cluera_live_billing_[a-z_]+$/.test(name)) throw Error('Cross-mode RPC rejected by fixture');
  const entries = Object.entries(args);
  return { data: (await db.query<{ v: unknown }>(`select public.${name}(${entries.map(([key], i) => key + '=>$' + (i + 1)).join(',')})v`,
    entries.map(([, value]) => value))).rows[0].v, error: null };
};
const rpc = liveBillingRpc(rawRpc);
const scope = () => createLiveBillingScope(input);
async function catalog(): Promise<Revision[]> { return (await db.query<{ v: Revision[] }>('select public.cluera_live_billing_catalog()v')).rows[0].v; }
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
    create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
    create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
  for (const name of ['20261016014532_cluera_clean_foundation', '20261019085323_cluera_customer_billing_history',
    '20261020080539_cluera_recurring_dependencies_disabled'])
    await db.exec(readFileSync('../supabase/migrations/' + name + '.sql', 'utf8'));
  await db.exec(prepare());
}, 60000);
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Real network forbidden'); }));
  await db.exec('begin');
  await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())', [account.userId, 'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [account.sessionId, account.userId]);
  await db.query('select public.customer_authorize($1,$2)', [account.userId, account.sessionId]);
  await db.query("update cluera_live_billing_private.processing_owner set owner='cluera',account_digest=$1", [digest]);
  await db.query(`update cluera_billing_runtime_private.live_profile set account_digest=$1,origin=$2,
    acceptance_digest=$3,checkout_enabled=true,intake_enabled=true`, [digest, input.CLUERA_LIVE_ACCOUNT_ORIGIN, 'd'.repeat(64)]);
  await db.exec("update cluera_billing_runtime_private.active_bank set mode='live';update cluera_live_billing_private.catalog_heads set enabled=true where offer_code='cluera_pack_3h_v2'");
});
afterEach(async () => { await db.exec('rollback'); vi.unstubAllGlobals(); });
afterAll(async () => db?.close());

function gateway() {
  let notes: Record<string, unknown> = {}, receipt = '', paid = false, refunded = false;
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    expect(target.origin).toBe('https://api.razorpay.com');
    expect(init?.headers).toMatchObject({ Authorization: 'Basic ' + Buffer.from(input.RAZORPAY_LIVE_KEY_ID + ':' + input.RAZORPAY_LIVE_KEY_SECRET).toString('base64') });
    if (target.pathname === '/v1/orders') {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ amount: 54900, currency: 'INR', partial_payment: false });
      expect(body.notes.cluera_environment).toBe('live'); notes = body.notes; receipt = body.receipt;
    } else expect(init?.method).toBe('GET');
    if (target.pathname.startsWith('/v1/orders')) return Response.json({ id: orderId, entity: 'order', amount: 54900,
      currency: 'INR', status: paid ? 'paid' : 'created', amount_paid: paid ? 54900 : 0, amount_due: paid ? 0 : 54900,
      attempts: paid ? 1 : 0, receipt, notes, offer_id: null, partial_payment: false });
    if (target.pathname === '/v1/payments/' + paymentId) return Response.json({
      id: paymentId, entity: 'payment', order_id: orderId, invoice_id: null, amount: 54900, currency: 'INR',
      status: refunded ? 'refunded' : 'captured', captured: true, amount_refunded: refunded ? 54900 : 0,
      refund_status: refunded ? 'full' : null, international: false,
    });
    if (target.pathname === '/v1/refunds/rfnd_isolatedlive0001') return Response.json({
      id: 'rfnd_isolatedlive0001', entity: 'refund', payment_id: paymentId, amount: 54900, currency: 'INR', status: 'processed',
    });
    throw Error('Unreviewed synthetic provider path');
  });
  return { request, pay: () => { paid = true; }, refund: () => { paid = true; refunded = true; },
    wrongMode: () => { notes.cluera_environment = 'test'; } };
}
function webhook(eventId: string, refund = false, signer = input.RAZORPAY_LIVE_WEBHOOK_SECRET) {
  const raw = JSON.stringify({ entity: 'event', account_id: input.RAZORPAY_LIVE_ACCOUNT_ID,
    event: refund ? 'refund.processed' : 'payment.captured', created_at: Math.floor(Date.now() / 1000),
    payload: refund ? { refund: { entity: { id: 'rfnd_isolatedlive0001', payment_id: paymentId } } }
      : { payment: { entity: { id: paymentId, order_id: orderId, invoice_id: null } } } });
  return new Request(input.CLUERA_LIVE_ACCOUNT_ORIGIN + '/api/account/payments/cluera/live/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': eventId,
      'x-razorpay-signature': createHmac('sha256', signer).update(raw).digest('hex') }, body: raw,
  });
}
async function buy(g: ReturnType<typeof gateway>) {
  const revision = (await catalog()).find(r => r.kind === 'PACK')!;
  const env = scope();
  const result = await createClueraCheckout(rpc, account, randomUUID(), revision.revisionId, env, clueraRazorpayAdapter(env, g.request));
  expect(result).toMatchObject({ code: 'BOUND', orderId, keyId: input.RAZORPAY_LIVE_KEY_ID });
  return env;
}
it('runs explicit Live checkout → callback without grant → signed receipt → exactly one isolated grant and history', async () => {
  const g = gateway(), env = await buy(g);
  expect(await verifyClueraCallback(rpc, account, { expectedAccountId: account.userId, orderId, subscriptionId: null,
    paymentId, signature: createHmac('sha256', input.RAZORPAY_LIVE_KEY_SECRET).update(orderId + '|' + paymentId).digest('hex') },
    env, clueraRazorpayAdapter(env, g.request))).toMatchObject({ code: 'AWAITING_WEBHOOK' });
  expect((await db.query('select count(*)::int n from public.customer_usage_grants')).rows[0].n).toBe(0);
  g.pay(); expect((await handleLiveWebhook(webhook('evt_isolatedlive0001'), input, rawRpc)).status).toBe(200);
  expect(await reconcileClueraPayment(rpc, env, g.request)).toBe('VERIFIED');
  expect((await handleLiveWebhook(webhook('evt_isolatedlive0002'), input, rawRpc)).status).toBe(200);
  expect(await reconcileClueraPayment(rpc, env, g.request)).toBe('VERIFIED');
  expect((await db.query("select billing_mode,granted_ms::text from public.customer_usage_grants where kind='PACK'")).rows).toEqual([
    { billing_mode: 'live', granted_ms: '10800000' },
  ]);
  expect((await readClueraBillingHistory(rpc, account, env)).payments).toHaveLength(1);
  expect((await db.query('select count(*)::int n from cluera_billing_private.payments')).rows[0].n).toBe(0);
  expect((await db.query('select count(*)::int n from cluera_billing_private.events')).rows[0].n).toBe(0);
  expect(g.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('full refund revokes only its Live grant, preserves the Test bank and never retries a provider write', async () => {
  const g = gateway(), env = await buy(g); g.pay();
  await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms)values($1,'razorpay-test:order_isolatedlive0001','PACK',10800000)", [account.userId]);
  await handleLiveWebhook(webhook('evt_isolatedlive0001'), input, rawRpc);
  expect(await reconcileClueraPayment(rpc, env, g.request)).toBe('VERIFIED');
  g.refund(); await handleLiveWebhook(webhook('evt_isolatedrefund0001', true), input, rawRpc);
  expect(await reconcileClueraPayment(rpc, env, g.request)).toBe('REFUNDED');
  expect((await db.query("select billing_mode,state from public.customer_usage_grants where kind='PACK'order by billing_mode")).rows).toEqual([
    { billing_mode: 'live', state: 'REVOKED' }, { billing_mode: 'test', state: 'ACTIVE' },
  ]);
  expect(g.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('rejects Test webhook signatures, Test notes and a Test worker proof at the Live boundary', async () => {
  const g = gateway(), env = await buy(g); g.pay(); g.wrongMode();
  expect((await handleLiveWebhook(webhook('evt_crossmode0001', false, input.RAZORPAY_TEST_WEBHOOK_SECRET), input, rawRpc)).status).toBe(400);
  await handleLiveWebhook(webhook('evt_crossmode0002'), input, rawRpc);
  expect(await reconcileClueraPayment(rpc, env, g.request)).toBe('PENDING');
  expect((await db.query('select count(*)::int n from cluera_live_billing_private.payments')).rows[0].n).toBe(0);
  const seconds = Math.floor(Date.now() / 1000), nonce = randomUUID();
  const request = new Request(input.CLUERA_LIVE_ACCOUNT_ORIGIN + '/api/internal/billing/cluera/live/tick', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'x-cluera-billing-time': String(seconds),
      'x-cluera-billing-nonce': nonce, 'x-cluera-billing-epoch': '1',
      'x-cluera-billing-proof': createHmac('sha256', input.CLUERA_LIVE_WORKER_SECRET).update(workerProofMessage(1, seconds, nonce, digest)).digest('hex') },
  });
  const spy = vi.fn(rawRpc);
  expect((await handleLiveTick(request, input, { rpc: spy })).status).toBe(401); expect(spy).not.toHaveBeenCalled();
});

it.each([
  ['cluera_monthly_40h_v2', 549900, 144000000],
  ['cluera_monthly_100h_v2', 959900, 360000000],
  ['cluera_monthly_200h_v2', 1954900, 720000000],
] as const)('isolates %s creation, paid invoices, renewal, cancellation and refund without competing mandates', async (offer, amount, allowance) => {
  const nativeInput = { ...input, CLUERA_LIVE_RECURRING_ENABLED: 'true', CLUERA_LIVE_ENTERPRISE_APPROVED: 'true',
    CLUERA_LIVE_NATIVE_HISTORY_READ_ENABLED: 'true' };
  const env = createLiveBillingScope(nativeInput), revisionId = randomUUID(), planId = 'plan_livemonthly0001', sub = 'sub_livemonthly0001';
  await db.query(`insert into cluera_live_billing_private.catalog_revisions
    (id,offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,razorpay_plan_id,total_count)
    select $1,offer_code,2,name,amount_paise,allowance_seconds,kind,interval_name,$2,total_count
    from cluera_live_billing_private.catalog_revisions where offer_code=$3`, [revisionId, planId, offer]);
  await db.query('update cluera_live_billing_private.catalog_heads set revision_id=$1,enabled=true where offer_code=$2', [revisionId, offer]);
  await db.exec('update cluera_live_billing_private.native_config set enabled=true');
  let notes: Record<string, unknown> = {}, cycle = 1, state = 'created', refunded = false;
  const now = Math.floor(Date.now() / 1000), month = 30 * 86400;
  const ids = () => ({ payment: `pay_livemonthly000${cycle}`, order: `order_livemonthly000${cycle}`, invoice: `inv_livemonthly000${cycle}` });
  const provider = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url)), path = target.pathname;
    expect(target.origin).toBe('https://api.razorpay.com');
    expect(init?.headers).toMatchObject({ Authorization: 'Basic ' + Buffer.from(input.RAZORPAY_LIVE_KEY_ID + ':' + input.RAZORPAY_LIVE_KEY_SECRET).toString('base64') });
    if (path === '/v1/plans/' + planId) return Response.json({ id: planId, entity: 'plan', period: 'monthly', interval: 1,
      item: { amount, currency: 'INR', active: true } });
    if (path === '/v1/subscriptions') {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ plan_id: planId, quantity: 1, total_count: 120 });
      notes = body.notes; expect(notes.cluera_environment).toBe('live');
    } else if (path.endsWith('/cancel')) {
      expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({ cancel_at_cycle_end: true });
    } else expect(init?.method).toBe('GET');
    if (path.startsWith('/v1/subscriptions')) return Response.json({ id: sub, entity: 'subscription', plan_id: planId, quantity: 1,
      status: state, notes, paid_count: state === 'created' ? 0 : cycle, total_count: 120,
      customer_id: state === 'created' ? null : 'cust_livemonthly01', has_scheduled_changes: false });
    const current = ids();
    if (path === '/v1/payments/' + current.payment) return Response.json({ id: current.payment, entity: 'payment',
      order_id: current.order, invoice_id: current.invoice, amount, currency: 'INR', status: refunded ? 'refunded' : 'captured',
      captured: true, amount_refunded: refunded ? amount : 0, refund_status: refunded ? 'full' : null, international: false,
      method: 'card', card: { network: 'Visa' } });
    if (path === '/v1/orders/' + current.order) return Response.json({ id: current.order, entity: 'order', amount,
      currency: 'INR', status: 'paid', amount_paid: amount, amount_due: 0, attempts: 1, receipt: null, notes: {} });
    if (path === '/v1/invoices/' + current.invoice) return Response.json({ id: current.invoice, entity: 'invoice',
      subscription_id: sub, order_id: current.order, payment_id: current.payment, customer_id: 'cust_livemonthly01', status: 'paid',
      currency: 'INR', amount, amount_paid: amount, amount_due: 0, gross_amount: amount, tax_amount: 0, partial_payment: false,
      billing_start: now + (cycle - 1) * month, billing_end: now + cycle * month, paid_at: now,
      line_items: [{ type: 'plan', amount, unit_amount: amount, gross_amount: amount, net_amount: amount,
        tax_amount: 0, currency: 'INR', quantity: 1, taxes: [] }] });
    if (path === '/v1/invoices') return Response.json({ entity: 'collection', count: cycle,
      items: Array.from({ length: cycle }, (_, i) => ({ id: `inv_livemonthly000${i + 1}`, subscription_id: sub })) });
    if (path === '/v1/refunds/rfnd_livemonthly0001') return Response.json({ id: 'rfnd_livemonthly0001', entity: 'refund',
      payment_id: current.payment, amount, currency: 'INR', status: 'processed' });
    throw Error('Unexpected provider request: ' + path);
  });
  const gateway = clueraRazorpayAdapter(env, provider), revision = (await catalog()).find(r => r.revisionId === revisionId)!;
  const evidence = await gateway.verifyPlan(revision);
  expect((await rpc('cluera_billing_plan_verify', { p_revision: revisionId, p_account_digest: digest, p_evidence: evidence })).data).toBe('VERIFIED');
  expect(await createClueraCheckout(rpc, account, randomUUID(), revisionId, env, gateway)).toMatchObject({ code: 'BOUND', subscriptionId: sub });
  state = 'active';
  const event = async (eventId: string, type = 'subscription.charged') => {
    const current = ids(), payload = type === 'refund.processed' ? { refund: { entity: { id: 'rfnd_livemonthly0001', payment_id: current.payment } } }
      : { subscription: { entity: { id: sub } }, payment: { entity: { id: current.payment, order_id: current.order, invoice_id: current.invoice } } };
    const raw = JSON.stringify({ entity: 'event', account_id: input.RAZORPAY_LIVE_ACCOUNT_ID, event: type, created_at: now, payload });
    expect((await handleLiveWebhook(new Request(input.CLUERA_LIVE_ACCOUNT_ORIGIN + '/api/account/payments/cluera/live/webhook', {
      method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': eventId,
        'x-razorpay-signature': createHmac('sha256', input.RAZORPAY_LIVE_WEBHOOK_SECRET).update(raw).digest('hex') },
    }), nativeInput, rawRpc)).status).toBe(200);
    return reconcileClueraPayment(rpc, env, provider);
  };
  expect(await event('evt_livemonthly0001')).toBe('VERIFIED');
  expect(await event('evt_livemonthlydup1')).toBe('VERIFIED');
  expect((await db.query('select billing_mode,granted_ms::text from public.customer_usage_grants')).rows)
    .toEqual([{ billing_mode: 'live', granted_ms: String(allowance) }]);
  // A second subscription or upgrade must stop before provider CREATE.
  await expect(createClueraCheckout(rpc, account, randomUUID(), revisionId, env, gateway)).rejects.toThrow();
  cycle = 2; expect(await event('evt_livemonthly0002')).toBe('VERIFIED');
  expect((await db.query("select state from public.customer_usage_grants order by state")).rows).toEqual([{ state: 'ACTIVE' }, { state: 'PAUSED' }]);
  const cancel = { expectedAccountId: account.userId, operationId: randomUUID(), subscriptionId: sub };
  expect(await cancelClueraSubscription(rpc, account, cancel, env, gateway)).toMatchObject({ code: 'RECORDED', command: { state: 'ACCEPTED' } });
  await cancelClueraSubscription(rpc, account, cancel, env, gateway);
  expect(provider.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  refunded = true; expect(await event('evt_livemonthlyrefund1', 'refund.processed')).toBe('REFUNDED');
  expect((await db.query("select state from public.customer_usage_grants order by state")).rows).toEqual([{ state: 'ACTIVE' }, { state: 'REVOKED' }]);
  expect((await db.query('select count(*)::int n from cluera_billing_private.payments')).rows[0].n).toBe(0);
  expect((await readClueraBillingHistory(rpc, account, env)).payments).toHaveLength(2);
});
