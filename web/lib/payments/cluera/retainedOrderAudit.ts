import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc, clueraBillingConfig, clueraCheckoutAllowed } from './config';
import { bindingSchema, ClueraBillingError } from './contracts';
import { clueraRazorpayAdapter, ClueraResumeError } from './adapter';

export const RETAINED_TEST_ORDER = 'order_TpRplT79SeFnTp';
const PIN = 'd426167dbe3272ee6f8e336d80512516b7dd6d3d96ce14c6fc634ca5d54698da';
const REVISION = 'c8674aed-4d01-4b34-9b3b-55937545ee7f';

/** Operator-only read of one previously bound resource using the application's
 * actual credentials and validators. Never creates/resumes Checkout, writes a
 * receipt, changes a binding or declares payment acceptance. No customer data
 * or upstream response is returned to the diagnostic log. */
export async function auditRetainedTestOrder(rpc: PaymentRpc, env = process.env, request: typeof fetch = fetch) {
  let providerRequests = 0;
  const report = { component: 'cluera-retained-test-order', financialMutations: 0,
    merchantPinned: false, bindingVerified: false, soleApprovedPurchaserOwnsRetainedOrder: false, untouchedOrderVerified: false,
    acceptance: 'NOT_PERFORMED', stopped: 'CONFIGURATION', providerRequests: 0,
    failureCode: null as string | null, providerHttpStatus: null as number | null, invalidFields: [] as string[] };
  const finish = (stopped: string) => ({ ...report, stopped, providerRequests, observedAt: new Date().toISOString() });
  try {
    clueraBillingConfig(env);
    const owner = await billingOwner(rpc, env);
    if (owner.accountDigest !== PIN || owner.epoch !== 1) return finish('MERCHANT_PIN_CHANGED');
    report.merchantPinned = true;
    const read = async () => {
      const raw = z.object({ legacy: z.literal(false) }).passthrough().parse(
        await billingRpc(rpc, 'cluera_billing_binding', { p_resource: RETAINED_TEST_ORDER, p_account_digest: PIN }));
      const { legacy: _legacy, ...value } = raw;
      const binding = bindingSchema.parse(value);
      if (binding.code !== 'BOUND' || binding.orderId !== RETAINED_TEST_ORDER || binding.subscriptionId !== null
        || binding.revision.revisionId !== REVISION || binding.revision.kind !== 'PACK'
        || binding.revision.amountPaise !== 54900 || binding.revision.allowanceSeconds !== 10800
        || binding.revision.offerCode !== 'cluera_pack_3h_v2' || !binding.revision.enabled
        || !clueraCheckoutAllowed(binding.userId, env)) throw Error('BINDING');
      return binding;
    };
    const binding = await read();
    report.bindingVerified = true;
    const purchasers = (env.SIGMAROUND_PAYMENT_TESTER_IDS ?? '').split(',').map(value => value.trim());
    report.soleApprovedPurchaserOwnsRetainedOrder = purchasers.length === 1 && purchasers[0] === binding.userId;
    const boundedRead: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method !== 'GET' || ![
        `https://api.razorpay.com/v1/orders/${RETAINED_TEST_ORDER}`,
        `https://api.razorpay.com/v1/orders/${RETAINED_TEST_ORDER}/payments`,
      ].includes(url) || ++providerRequests > 2) throw Error('READ_ONLY_BOUNDARY');
      return request(input, init);
    };
    await clueraRazorpayAdapter(env, boundedRead).resumeUntouchedPack(binding);
    const after = await read(), ownerAfter = await billingOwner(rpc, env);
    if (JSON.stringify(after) !== JSON.stringify(binding) || ownerAfter.accountDigest !== owner.accountDigest
      || ownerAfter.epoch !== owner.epoch) return finish('BINDING_CHANGED');
    report.untouchedOrderVerified = true;
    return finish('SAME_ORDER_ELIGIBLE_AT_OBSERVATION');
  } catch (error) {
    if (report.bindingVerified) {
      report.failureCode = error instanceof ClueraResumeError ? error.reason
        : error instanceof ClueraBillingError ? error.code : error instanceof z.ZodError ? 'INVALID_PROVIDER_FIELDS' : 'VERIFICATION_FAILED';
      if (error instanceof ClueraBillingError && error.httpStatus && error.httpStatus >= 100 && error.httpStatus <= 599)
        report.providerHttpStatus = error.httpStatus;
      // Log only reviewed field names, never issue messages, values, notes or IDs.
      if (error instanceof z.ZodError) report.invalidFields = [...new Set(error.issues.map(issue => String(issue.path[0]))
        .filter(field => ['amount','amount_paid','amount_due','attempts','status','currency','receipt','notes','id','entity','offer_id','partial_payment','count','items'].includes(field)))].slice(0,16);
    }
    return finish(report.bindingVerified ? 'PROVIDER_OR_BINDING_REVIEW_REQUIRED'
      : report.merchantPinned ? 'BINDING_REVIEW_REQUIRED' : 'CONFIGURATION');
  }
}
