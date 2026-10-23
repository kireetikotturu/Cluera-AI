import { afterEach, expect, it, vi } from 'vitest';
import { auditRetainedTestOrder, RETAINED_TEST_ORDER } from '../lib/payments/cluera/retainedOrderAudit';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const hooks = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('../lib/payments/cluera/config', async original => ({
  ...await original<typeof import('../lib/payments/cluera/config')>(), billingOwner: hooks.owner,
}));
const pin = 'd426167dbe3272ee6f8e336d80512516b7dd6d3d96ce14c6fc634ca5d54698da';
const revisionId = 'c8674aed-4d01-4b34-9b3b-55937545ee7f', intentId = '00000000-0000-4000-8000-000000000007';
const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true' };
const binding = { legacy: false, code: 'BOUND', intentId, userId: env.SIGMAROUND_PAYMENT_TESTER_IDS,
  orderId: RETAINED_TEST_ORDER, subscriptionId: null, revision: { revisionId, offerCode: 'cluera_pack_3h_v2',
    name: '3 hours', amountPaise: 54900, currency: 'INR', allowanceSeconds: 10800, kind: 'PACK', interval: null,
    razorpayPlanId: null, totalCount: null, version: 1, testPlanValidated: false, enabled: true } };
const order = { id: RETAINED_TEST_ORDER, entity: 'order', amount: 54900, currency: 'INR', status: 'created',
  amount_paid: 0, amount_due: 54900, attempts: 0, receipt: intentId,
  notes: { cluera_intent: intentId, cluera_revision: revisionId, cluera_environment: 'test' } };
function setup(patch = {}, collection = { entity: 'collection', count: 0, items: [] as unknown[] }) {
  hooks.owner.mockResolvedValue({ epoch: 1, accountDigest: pin });
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: binding, error: null }));
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    return Response.json(String(url).endsWith('/payments') ? collection : { ...order, ...patch });
  });
  return { rpc, request };
}
afterEach(() => vi.clearAllMocks());
it.each([
  [{amount_paid:null},'INVALID_PROVIDER_FIELDS',['amount_paid']],
  [{attempts:1},'ORDER_ALREADY_ATTEMPTED',[]],
  [{amount_due:1},'ORDER_BALANCE_CHANGED',[]],
  [{receipt:'private-foreign-reference'},'ORDER_BINDING_MISMATCH',[]],
] as const)('reports bounded diagnostic categories without provider values: %j',async(patch,failureCode,invalidFields)=>{
  const {rpc,request}=setup(patch);
  const report=await auditRetainedTestOrder(rpc,env,request);
  expect(report).toMatchObject({failureCode,invalidFields,providerRequests:1,financialMutations:0,untouchedOrderVerified:false});
  expect(JSON.stringify(report)).not.toContain('private-foreign-reference');
});
it('distinguishes provider HTTP failure without logging its private response',async()=>{
  const {rpc}=setup();
  const request=vi.fn(async()=>Response.json({description:'private-merchant-data'},{status:429}));
  const report=await auditRetainedTestOrder(rpc,env,request);
  expect(report).toMatchObject({failureCode:'UNAVAILABLE',providerHttpStatus:429,invalidFields:[],providerRequests:1});
  expect(JSON.stringify(report)).not.toContain('private-merchant-data');
});
it('reads exactly the retained resource with the actual adapter and rechecks binding/owner without financial writes', async () => {
  const { rpc, request } = setup();
  const value = await auditRetainedTestOrder(rpc, env, request);
  expect(value).toMatchObject({ merchantPinned: true, bindingVerified: true, soleApprovedPurchaserOwnsRetainedOrder: true, untouchedOrderVerified: true,
    stopped: 'SAME_ORDER_ELIGIBLE_AT_OBSERVATION', financialMutations: 0, providerRequests: 2, acceptance: 'NOT_PERFORMED' });
  expect(rpc).toHaveBeenCalledTimes(2); expect(hooks.owner).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls.every(([name]) => name === 'cluera_billing_binding')).toBe(true);
  expect(JSON.stringify(value)).not.toMatch(/rzp_test|sb_secret|00000000|c8674aed|cluera_intent/);
});
it.each([{ amount_paid: null }, { amount_paid: '0' }, { attempts: 1 }, { amount_due: 0 }, { status: 'paid' },
  { receipt: 'foreign' }, { notes: { ...order.notes, cluera_environment: 'live' } }])('refuses unsafe canonical evidence %j', async patch => {
  const { rpc, request } = setup(patch);
  expect(await auditRetainedTestOrder(rpc, env, request)).toMatchObject({
    untouchedOrderVerified: false, stopped: 'PROVIDER_OR_BINDING_REVIEW_REQUIRED', financialMutations: 0 });
});
it('refuses an associated failed payment and a changed binding', async () => {
  const first = setup({}, { entity: 'collection', count: 1, items: [{ status: 'failed' }] });
  expect((await auditRetainedTestOrder(first.rpc, env, first.request)).untouchedOrderVerified).toBe(false);
  const second = setup();
  second.rpc.mockResolvedValueOnce({ data: binding, error: null }).mockResolvedValueOnce({
    data: { ...binding, intentId: '00000000-0000-4000-8000-000000000008' }, error: null,
  });
  expect((await auditRetainedTestOrder(second.rpc, env, second.request)).stopped).toBe('BINDING_CHANGED');
});
it('does not call the provider for a changed pin, disabled rollout or foreign purchaser', async () => {
  const { rpc, request } = setup();
  hooks.owner.mockResolvedValueOnce({ epoch: 1, accountDigest: 'f'.repeat(64) });
  expect((await auditRetainedTestOrder(rpc, env, request)).stopped).toBe('MERCHANT_PIN_CHANGED');
  await auditRetainedTestOrder(rpc, { ...env, CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false' }, request);
  await auditRetainedTestOrder(rpc, { ...env, SIGMAROUND_PAYMENT_TESTER_IDS: '00000000-0000-4000-8000-000000000009' }, request);
  expect(request).not.toHaveBeenCalled();
});
