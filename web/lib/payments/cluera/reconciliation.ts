import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { razorpayAdapter } from '../providers/razorpay/adapter';
import { razorpayTransport } from '../providers/razorpay/transport';
import { billingOwner, billingRpc, clueraIntakeEnabled } from './config';
import { bindingSchema, ClueraBillingError, eventSchema, orderId, paymentId } from './contracts';
import { clueraRazorpayAdapter } from './adapter';

/** One separately leased event. Shared SQL owner/epoch and immutable source IDs prevent double financial writers. */
export async function reconcileClueraPayment(rpc: PaymentRpc, env = process.env, request: typeof fetch = fetch) {
  if (!clueraIntakeEnabled(env)) throw new ClueraBillingError('CONFIGURATION');
  const { epoch, accountDigest } = await billingOwner(rpc, env);
  const data = await billingRpc(rpc,'cluera_billing_event_claim',{p_account_digest:accountDigest,p_epoch:epoch});
  if ((data as {code?:unknown})?.code === 'EMPTY') return 'EMPTY';
  const rawClaim = data as Record<string,unknown>;
  const lease = z.object({code:z.literal('CLAIMED'),claimId:z.uuid(),eventId:eventSchema.shape.eventId}).parse(data);
  try {
    const claimed = z.object({code:z.literal('CLAIMED'),claimId:z.uuid(),legacy:z.boolean(), ...eventSchema.shape}).strict()
      .parse({subscriptionId:null,invoiceId:null,...rawClaim});
    if (claimed.legacy) {
      if (!claimed.paymentId) throw new ClueraBillingError('PENDING');
      const canonicalOrder = claimed.orderId ?? z.object({id:z.literal(claimed.paymentId),order_id:orderId})
        .parse(await razorpayTransport(env,request)(`/payments/${claimed.paymentId}`)).order_id;
      const binding = z.object({code:z.enum(['BOUND','VERIFIED','REFUNDED']),intentId:z.uuid(),userId:z.uuid(),orderId:z.literal(canonicalOrder),offerCode:z.literal('pro_3_hours')})
        .parse(await billingRpc(rpc,'account_payment_binding',{p_order:canonicalOrder,p_account_digest:accountDigest}));
      const evidence = await razorpayAdapter(env,request).inspect(binding,claimed.paymentId,
        claimed.eventType === 'refund.processed' ? claimed.resourceId : undefined);
      const result = await billingRpc(rpc,'cluera_billing_legacy_apply',{p_event:claimed.eventId,p_claim:claimed.claimId,p_digest:claimed.digest,
        p_account_digest:accountDigest,p_epoch:epoch,p_evidence:evidence});
      const code = (result as {code?:unknown})?.code;
      if (code !== 'VERIFIED' && code !== 'REFUNDED') throw new ClueraBillingError('PENDING');
      return code;
    }
    const gateway = clueraRazorpayAdapter(env,request);
    // payment/order events do not necessarily carry a subscription. Resolve its invoice link
    // with a GET before selecting the canonical server-owned binding, then reverify all evidence.
    const resource = claimed.subscriptionId ?? (claimed.paymentId ? await gateway.resolvePaymentResource(paymentId.parse(claimed.paymentId)) : claimed.orderId);
    if (!resource) throw new ClueraBillingError('PENDING');
    const rawBinding = await billingRpc(rpc,'cluera_billing_binding',{p_resource:resource,p_account_digest:accountDigest});
    if ((rawBinding as {legacy?:unknown})?.legacy === true) {
      if (!claimed.paymentId) throw new ClueraBillingError('PENDING');
      const legacy = z.object({legacy:z.literal(true),code:z.enum(['BOUND','VERIFIED','REFUNDED']),intentId:z.uuid(),userId:z.uuid(),
        orderId:orderId,offerCode:z.literal('pro_3_hours')}).strict().parse(rawBinding);
      const evidence = await razorpayAdapter(env,request).inspect(legacy,claimed.paymentId,claimed.eventType === 'refund.processed' ? claimed.resourceId : undefined);
      const result = await billingRpc(rpc,'cluera_billing_legacy_apply',{p_event:claimed.eventId,p_claim:claimed.claimId,p_digest:claimed.digest,
        p_account_digest:accountDigest,p_epoch:epoch,p_evidence:evidence});
      const code = (result as {code?:unknown})?.code;
      if (code !== 'VERIFIED' && code !== 'REFUNDED') throw new ClueraBillingError('PENDING');
      return code;
    }
    // SQL may explicitly label the new binding as non-legacy; strip only that fixed discriminator.
    const projected = {...rawBinding as Record<string,unknown>};delete projected.legacy;
    const binding = bindingSchema.parse(projected);
    const evidence = await gateway.inspect(binding,eventSchema.parse(Object.fromEntries(Object.entries(claimed).filter(([key])=>!['code','claimId','legacy'].includes(key)))));
    const result = await billingRpc(rpc,'cluera_billing_apply',{p_event:claimed.eventId,p_claim:claimed.claimId,p_digest:claimed.digest,
      p_account_digest:accountDigest,p_epoch:epoch,p_evidence:evidence});
    const code = (result as {code?:unknown})?.code;
    if (!['VERIFIED','REFUNDED','STATUS','APPLIED','NO_GRANT','DUPLICATE'].includes(String(code))) throw new ClueraBillingError('PENDING');
    return String(code);
  } catch {
    await billingRpc(rpc,'cluera_billing_event_finish',{p_event:lease.eventId,p_claim:lease.claimId,p_epoch:epoch,p_retry:true});
    return 'PENDING';
  }
}
