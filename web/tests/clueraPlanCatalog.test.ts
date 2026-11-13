import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvedPurchaseCatalog, onSaleCatalog } from '../lib/payments/cluera/purchaseAvailability';
import { clueraBillingCatalog, createClueraCheckout } from '../lib/payments/cluera/checkout';
import { clueraPublicCatalog } from '../lib/payments/cluera/publicCatalog';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { merchantDigest } from '../lib/payments/cluera/config';
import { readClueraBillingPresentation } from '../lib/cluera/billingPresentation';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import type { Revision } from '../lib/payments/cluera/contracts';

const mocks = vi.hoisted(() => ({ clients: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));
const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true' } as NodeJS.ProcessEnv;
const id = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const pack = (n: number, amountPaise: number, hours: number, enabled = true, testPlanValidated = false): Revision => ({
  revisionId: id(n), offerCode: 'cluera_pack_3h_v2', name: `Pack ${n}`, amountPaise, currency: 'INR', allowanceSeconds: hours * 3600, kind: 'PACK',
  interval: null, razorpayPlanId: null, enabled, version: n, totalCount: null, testPlanValidated });
const monthly = (n: number, code: Revision['offerCode'], enabled = false): Revision => ({ ...pack(n, 549900, 40), offerCode: code, kind: 'RECURRING',
  interval: 'MONTH', razorpayPlanId: `plan_synthetic00${n}`, totalCount: 120, enabled });
const monthlies = [monthly(90, 'cluera_monthly_40h_v2'), monthly(91, 'cluera_monthly_100h_v2'), monthly(92, 'cluera_monthly_200h_v2')];
const rpcFor = (catalog: unknown) => vi.fn(async (name: string) => ({ error: null, data: name === 'cluera_billing_catalog' ? catalog : null }));
beforeEach(() => {
  for (const [key, value] of Object.entries({ ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_public_key_00000000000000000',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'), SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: Buffer.alloc(32, 4).toString('base64') }))
    vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('accepts any number of one-time packs sharing one offer code, but never a repeated revision or monthly offer', async () => {
  const many = [pack(1, 10000, 1), pack(2, 20000, 2), pack(3, 30000, 3), ...monthlies];
  expect((await clueraBillingCatalog(rpcFor(many))).map(row => row.revisionId)).toEqual(many.map(row => row.revisionId));
  await expect(clueraBillingCatalog(rpcFor([pack(1, 10000, 1), pack(1, 20000, 2)]))).rejects.toThrow();
  await expect(clueraBillingCatalog(rpcFor([monthly(90, 'cluera_monthly_40h_v2'), monthly(91, 'cluera_monthly_40h_v2')]))).rejects.toThrow();
  const publicRows = (await clueraBillingCatalog(rpcFor(many)));
  expect(clueraPublicCatalog.safeParse(publicRows).success).toBe(true);
  expect(JSON.stringify(publicRows)).not.toContain('razorpayPlanId');
});

it('treats a pack as validated even when the database reports false, and leaves monthly validation alone', () => {
  const rows = approvedPurchaseCatalog([pack(1, 10000, 1, true, false), { ...monthlies[0], enabled: true, testPlanValidated: false }] as never, env);
  expect(rows[0].testPlanValidated).toBe(true);
  expect(rows[1].testPlanValidated).toBe(false);
});

it('shows customers only plans that are On; Off plans and unapproved monthly plans never appear', () => {
  const rows = onSaleCatalog([pack(1, 10000, 1, true), pack(2, 20000, 2, false), ...monthlies.map(row => ({ ...row, enabled: true }))] as never, env);
  expect(rows.map(row => row.revisionId)).toEqual([id(1)]);
  expect(onSaleCatalog([pack(2, 20000, 2, false)] as never, env)).toEqual([]);
});

it('pricing presentation lists exactly the plans that are On, an empty list when none, and null only when unreadable', async () => {
  const run = async (catalog: unknown, failing = false) => {
    mocks.clients.mockReturnValue({ service: { rpc: failing ? vi.fn(async () => ({ data: null, error: { message: 'down' } })) : rpcFor(catalog) } });
    return readClueraBillingPresentation();
  };
  expect((await run([pack(1, 10000, 1), pack(2, 20000, 2, false), pack(3, 30000, 3), ...monthlies]))!.map(row => row.revisionId)).toEqual([id(1), id(3)]);
  expect(await run([pack(2, 20000, 2, false), ...monthlies])).toEqual([]);
  expect(await run([], true)).toBeNull();
  expect(JSON.stringify(await run([pack(1, 10000, 1)]))).not.toContain('razorpayPlanId');
});

it('sells a second plan at the SERVER catalog price and refuses an Off plan without any order or database write', async () => {
  const dear = pack(2, 249900, 20), off = pack(3, 99900, 5, false), accountDigest = merchantDigest(env);
  const user = { userId: env.SIGMAROUND_PAYMENT_TESTER_IDS!, sessionId: id(50) };
  const catalog = [pack(1, 54900, 3), dear, off];
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === 'cluera_billing_owner') return { error: null, data: args.p_account_digest === accountDigest ? { code: 'ACTIVE', owner: 'cluera', epoch: 1 } : { code: 'CONFLICT' } };
    if (name === 'cluera_billing_catalog') return { error: null, data: catalog };
    if (name === 'cluera_billing_prepare') return { error: null, data: { code: 'CLAIMED', intentId: id(60), attemptId: id(61), revision: dear } };
    if (name === 'cluera_billing_bind') return { error: null, data: args.p_resource ? 'BOUND' : 'UNCERTAIN' };
    if (name === 'cluera_billing_status') return { error: null, data: { userId: user.userId, code: 'PENDING', resolvedOrderIds: [], resolvedSubscriptionIds: [],
      pending: { legacy: false, intentId: id(60), state: 'BOUND', kind: 'PACK', revisionId: dear.revisionId, offerCode: dear.offerCode, orderId: 'order_synthetic0001', subscriptionId: null } } };
    return { error: null, data: null };
  });
  const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    return Response.json({ id: 'order_synthetic0001', entity: 'order', amount: sent.amount, currency: 'INR', status: 'created', amount_paid: 0, amount_due: sent.amount,
      attempts: 0, receipt: sent.receipt, notes: sent.notes, offer_id: null, partial_payment: false }, { headers: { 'content-type': 'application/json' } });
  });
  const bound = await createClueraCheckout(rpc, user, id(70), dear.revisionId, env, clueraRazorpayAdapter(env, provider as typeof fetch));
  expect(bound).toMatchObject({ code: 'BOUND', amountPaise: 249900, revisionId: dear.revisionId });
  expect(JSON.parse(String(provider.mock.calls[0][1]?.body))).toMatchObject({ amount: 249900, currency: 'INR', partial_payment: false });
  // The browser can only name a revision: an Off plan is refused before prepare, bind or any provider request.
  calls.length = 0; provider.mockClear();
  await expect(createClueraCheckout(rpc, user, id(71), off.revisionId, env, clueraRazorpayAdapter(env, provider as typeof fetch))).rejects.toThrow();
  await expect(createClueraCheckout(rpc, user, id(72), id(99), env, clueraRazorpayAdapter(env, provider as typeof fetch))).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();
  expect(calls.some(name => /prepare|bind/.test(name))).toBe(false);
});
