import { z } from 'zod';
import { razorpayCheckoutAllowed, razorpayConfig } from '../core/config';
import { gatewayAccountDigest, paymentRpc } from '../core/rpc';
import { PaymentError, type PaymentAdapter, type PaymentBinding, type PaymentRpc } from '../core/types';
import { paymentAdapter } from '../providers/registry';

export const paymentStatusSchema = z.object({ code: z.enum(['AVAILABLE', 'PENDING']), userId: z.uuid(),
  pending: z.object({ id: z.uuid(), state: z.enum(['CREATING', 'BOUND', 'UNCERTAIN']), offerCode: z.literal('pro_3_hours'),
    orderId: z.string().regex(/^order_[A-Za-z0-9]{8,64}$/).nullable() }).strict().nullable(),
  resolvedOrderIds: z.array(z.string().regex(/^order_[A-Za-z0-9]{8,64}$/)).max(50),
  history: z.array(z.object({ offerCode: z.literal('pro_3_hours'), state: z.enum(['CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED']),
    createdAt: z.iso.datetime({ offset: true }) }).strict()).max(10) }).strict();
export async function paymentStatus(rpc: PaymentRpc, account: { userId: string; sessionId: string }) {
  const data = await paymentRpc(rpc, 'account_payment_status', { p_user: account.userId, p_session: account.sessionId });
  const parsed = paymentStatusSchema.safeParse(data);
  if (!parsed.success || parsed.data.userId !== account.userId || (parsed.data.code === 'AVAILABLE') !== (parsed.data.pending === null))
    throw new PaymentError('UNAVAILABLE');
  return parsed.data;
}
export async function createPaymentOrder(rpc: PaymentRpc, account: { userId: string; sessionId: string }, requestId: string,
  env = process.env, adapter?: PaymentAdapter) {
  if (!razorpayCheckoutAllowed(account.userId, env)) throw new PaymentError('CONFIGURATION');
  z.uuid().parse(requestId); const digest = gatewayAccountDigest(env), gateway = adapter ?? paymentAdapter('razorpay', env);
  const result = z.object({ code: z.string(), intentId: z.uuid().optional(), attemptId: z.uuid().optional(), orderId: z.string().nullable().optional() })
    .parse(await paymentRpc(rpc, 'account_payment_prepare', { p_user: account.userId, p_session: account.sessionId,
      p_request: requestId, p_account_digest: digest }));
  // Replayed request does not open an old order or repeat an unknown provider POST.
  if (result.code !== 'CLAIMED') return { code: 'PENDING' as const };
  if (!result.intentId || !result.attemptId) throw new PaymentError('UNAVAILABLE');
  let stage: 'provider_request' | 'binding' | 'identity' = 'provider_request';
  try {
    const order = await gateway.createOrder(result.intentId);
    stage = 'binding';
    const completed = await paymentRpc(rpc, 'account_payment_bind', { p_intent: result.intentId, p_attempt: result.attemptId,
      p_account_digest: digest, p_order: order.orderId });
    if (completed !== 'BOUND') throw new PaymentError('PENDING');
    // Fence sign-out/switch/suspension after the network request. Preserve BOUND
    // even when this final read fails; never create a replacement or unlock it.
    stage = 'identity';
    const status = await paymentStatus(rpc, account);
    if (status.pending?.id !== result.intentId || status.pending.orderId !== order.orderId) throw new PaymentError('PENDING');
    return { code: 'BOUND' as const, orderId: order.orderId, keyId: razorpayConfig(env).keyId,
      amount: 54900 as const, currency: 'INR' as const, offerCode: 'pro_3_hours' as const };
  } catch (error) {
    await paymentRpc(rpc, 'account_payment_bind', { p_intent: result.intentId, p_attempt: result.attemptId,
      p_account_digest: digest, p_order: null, p_diagnostic: { stage,
        ...(error instanceof PaymentError && Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599
          ? { httpStatus: error.httpStatus } : {}) } }).catch(() => undefined);
    return { code: 'PENDING' as const };
  }
}
export async function verifyPaymentCallback(rpc: PaymentRpc, account: { userId: string; sessionId: string },
  input: { orderId: string; paymentId: string; signature: string }, env = process.env, adapter?: PaymentAdapter) {
  if (!razorpayCheckoutAllowed(account.userId, env)) throw new PaymentError('CONFIGURATION');
  const status = await paymentStatus(rpc, account);
  let binding: PaymentBinding;
  if (status.pending?.state === 'BOUND' && status.pending.orderId === input.orderId) {
    binding = { intentId: status.pending.id, userId: account.userId, orderId: status.pending.orderId, offerCode: 'pro_3_hours' };
  } else {
    // Ordinary webhook delivery can beat the browser callback. Read its already
    // bound owned row rather than falsely treating that race as payment failure.
    const value = z.object({ code: z.enum(['VERIFIED','REFUNDED']), intentId: z.uuid(), userId: z.literal(account.userId),
      orderId: z.literal(input.orderId), offerCode: z.literal('pro_3_hours') }).parse(await paymentRpc(rpc,'account_payment_binding',
        { p_order: input.orderId, p_account_digest: gatewayAccountDigest(env) }));
    binding = value;
  }
  (adapter ?? paymentAdapter('razorpay', env)).verifyCallback(binding, input.paymentId, input.signature);
  // HMAC establishes callback authenticity, NOT capture, signed webhook or credit authority.
  // No receipt, grant, reconciliation or intent write occurs on this browser route.
  return { code: 'AWAITING_WEBHOOK' as const };
}
