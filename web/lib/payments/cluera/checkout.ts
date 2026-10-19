import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc, clueraBillingConfig, clueraCheckoutAllowed, merchantDigest } from './config';
import { bindingSchema, ClueraBillingError, orderId, paymentId, revisionSchema, statusSchema, subscriptionId } from './contracts';
import { clueraRazorpayAdapter } from './adapter';
import { clueraNativeRecurringEnabled } from './nativeRecurring';

type Account = { userId: string; sessionId: string };
type Adapter = ReturnType<typeof clueraRazorpayAdapter>;
export async function clueraBillingCatalog(rpc: PaymentRpc) {
  const catalog = z.array(revisionSchema).max(4).parse(await billingRpc(rpc, 'cluera_billing_catalog', {}));
  if (new Set(catalog.map(item => item.offerCode)).size !== catalog.length) throw new ClueraBillingError('UNAVAILABLE');
  return catalog.map(({ razorpayPlanId: _plan, ...value }) => value);
}
export async function clueraBillingStatus(rpc: PaymentRpc, account: Account) {
  const status = statusSchema.parse(await billingRpc(rpc, 'cluera_billing_status', { p_user: account.userId, p_session: account.sessionId }));
  if (status.userId !== account.userId || (status.code === 'AVAILABLE' && status.pending !== null)
    || (status.code === 'PENDING' && status.pending === null)) throw new ClueraBillingError('UNAVAILABLE');
  return status;
}
export async function createClueraCheckout(rpc: PaymentRpc, account: Account, requestId: string, revisionId: string,
  env = process.env, adapter: Adapter = clueraRazorpayAdapter(env)) {
  if (!clueraCheckoutAllowed(account.userId, env)) throw new ClueraBillingError('CONFIGURATION');
  z.uuid().parse(requestId); z.uuid().parse(revisionId);
  const { epoch, accountDigest } = await billingOwner(rpc, env);
  if(env.CLUERA_RECURRING_SCHEDULE_ENABLED==='true') {
    if(!clueraNativeRecurringEnabled(env)||await billingRpc(rpc,'cluera_billing_native_purchase_policy',{
      p_user:account.userId,p_session:account.sessionId,p_revision:revisionId,p_account_digest:accountDigest,p_epoch:epoch,
    })!=='ALLOWED')throw new ClueraBillingError('PENDING');
  }
  const data = await billingRpc(rpc, 'cluera_billing_prepare', { p_user:account.userId, p_session:account.sessionId,
    p_request:requestId, p_revision:revisionId, p_account_digest:accountDigest, p_epoch:epoch });
  // No retry/open on replay or unknown outcomes. Only this fresh leased CLAIMED attempt may POST once.
  if (z.object({code:z.string()}).parse(data).code !== 'CLAIMED') return { code:'PENDING' as const };
  const claimed = z.object({ code:z.literal('CLAIMED'),intentId:z.uuid(),attemptId:z.uuid(),revision:revisionSchema }).strict().parse(data);
  if (!claimed.intentId || !claimed.attemptId || !claimed.revision || claimed.revision.revisionId !== revisionId || !claimed.revision.enabled)
    throw new ClueraBillingError('UNAVAILABLE');
  const args = { p_intent:claimed.intentId, p_attempt:claimed.attemptId, p_account_digest:accountDigest, p_epoch:epoch };
  try {
    const resource = await adapter.create(claimed.intentId, claimed.revision);
    if (await billingRpc(rpc, 'cluera_billing_bind', { ...args, p_resource:resource }) !== 'BOUND') throw new ClueraBillingError('PENDING');
    // Same server account/session must still own the exact binding after provider response.
    const status = await clueraBillingStatus(rpc, account);
    if (status.pending?.intentId !== claimed.intentId || status.pending.orderId !== resource.orderId
      || status.pending.subscriptionId !== resource.subscriptionId) throw new ClueraBillingError('PENDING');
    return { code:'BOUND' as const, kind:claimed.revision.kind, ...resource, keyId:clueraBillingConfig(env).keyId,
      amountPaise:claimed.revision.amountPaise, currency:'INR' as const, revisionId, offerCode:claimed.revision.offerCode };
  } catch {
    // SQL never overwrites a known BOUND row with this unknown marker. No replacement provider request.
    await billingRpc(rpc, 'cluera_billing_bind', { ...args, p_resource:null }).catch(() => undefined);
    return { code:'PENDING' as const };
  }
}
export const callbackSchema = z.object({ expectedAccountId:z.uuid(), orderId:orderId.nullable(), subscriptionId:subscriptionId.nullable(),
  paymentId, signature:z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(value => (value.orderId !== null) !== (value.subscriptionId !== null));
export async function verifyClueraCallback(rpc: PaymentRpc, account: Account, input: z.infer<typeof callbackSchema>,
  env = process.env, adapter: Adapter = clueraRazorpayAdapter(env)) {
  callbackSchema.parse(input);
  if (!clueraCheckoutAllowed(account.userId, env) || input.expectedAccountId !== account.userId) throw new ClueraBillingError('CONFIGURATION');
  await billingOwner(rpc, env);
  const resource = input.orderId ?? input.subscriptionId!;
  const raw = await billingRpc(rpc, 'cluera_billing_binding', { p_resource:resource, p_account_digest:merchantDigest(env) });
  if ((raw as {legacy?:unknown})?.legacy === true) throw new ClueraBillingError('INVALID');
  const projected = {...raw as Record<string,unknown>};delete projected.legacy;
  const binding = bindingSchema.parse(projected);
  if (binding.userId !== account.userId || binding.orderId !== input.orderId || binding.subscriptionId !== input.subscriptionId) throw new ClueraBillingError('INVALID');
  adapter.verifyCallback(binding, input.paymentId, input.signature);
  // Browser callback creates no receipt, grant, intent update or worker wake.
  return { code:'AWAITING_WEBHOOK' as const };
}
