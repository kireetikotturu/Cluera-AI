import { z } from 'zod';
import { razorpayConfig } from '../../core/config';
import { PaymentError, type PaymentAdapter, type PaymentBinding, type PaymentEvidence } from '../../core/types';
import { razorpayTransport } from './transport';
import { verifyCheckoutSignature } from './signatures';

export const orderSchema = z.object({ id: z.string().regex(/^order_[A-Za-z0-9]{8,64}$/), entity: z.literal('order'),
  amount: z.literal(54900), currency: z.literal('INR'), receipt: z.uuid(), status: z.enum(['created', 'attempted', 'paid']),
  amount_paid: z.number().int().nonnegative(), amount_due: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(),
  notes: z.object({ sigma_intent: z.uuid(), sigma_offer: z.literal('pro_3_hours'), sigma_environment: z.literal('test') }),
  offer_id: z.null().optional(), partial_payment: z.literal(false).optional() });
const paymentSchema = z.object({ id: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/), entity: z.literal('payment'),
  order_id: z.string(), amount: z.literal(54900), currency: z.literal('INR'), status: z.enum(['created', 'authorized', 'captured', 'refunded', 'failed']),
  captured: z.boolean(), amount_refunded: z.number().int().min(0).max(54900), refund_status: z.enum(['partial', 'full']).nullable(),
  invoice_id: z.null(), international: z.literal(false) });

export function razorpayAdapter(env = process.env, request: typeof fetch = fetch): PaymentAdapter {
  const config = razorpayConfig(env), api = razorpayTransport(env, request);
  const verifyOrder = async (binding: PaymentBinding) => {
    const order = orderSchema.parse(await api(`/orders/${binding.orderId}`));
    if (order.id !== binding.orderId || order.receipt !== binding.intentId || order.notes.sigma_intent !== binding.intentId
      || binding.offerCode !== 'pro_3_hours') throw new PaymentError('INVALID');
    return order;
  };
  return { provider: 'razorpay',
    async createOrder(intentId) {
      z.uuid().parse(intentId);
      const order = orderSchema.parse(await api('/orders', { amount: 54900, currency: 'INR', receipt: intentId,
        partial_payment: false, notes: { sigma_intent: intentId, sigma_offer: 'pro_3_hours', sigma_environment: 'test' } }));
      if (order.status !== 'created' || order.amount_paid !== 0 || order.amount_due !== 54900 || order.attempts !== 0
        || order.receipt !== intentId || order.notes.sigma_intent !== intentId) throw new PaymentError('INVALID');
      return { orderId: order.id };
    },
    verifyCallback(binding, paymentId, signature) { verifyCheckoutSignature(binding.orderId, paymentId, signature, config.keySecret); },
    async inspect(binding, paymentId, refundId): Promise<PaymentEvidence> {
      try {
        if (!/^pay_[A-Za-z0-9]{8,64}$/.test(paymentId)) throw new PaymentError('INVALID');
        const order = await verifyOrder(binding), payment = paymentSchema.parse(await api(`/payments/${paymentId}`));
        if (payment.id !== paymentId || payment.order_id !== binding.orderId || !payment.captured
          || order.status !== 'paid' || order.amount_paid !== 54900 || order.amount_due !== 0) throw new PaymentError('PENDING');
        const base = { intentId: binding.intentId, orderId: binding.orderId, paymentId, amount: 54900 as const,
          currency: 'INR' as const, observedAt: new Date().toISOString() };
        if (refundId) {
          if (!/^rfnd_[A-Za-z0-9]{8,64}$/.test(refundId)) throw new PaymentError('INVALID');
          const refund = z.object({ id: z.string(), entity: z.literal('refund'), payment_id: z.string(), amount: z.literal(54900),
            currency: z.literal('INR'), status: z.literal('processed') }).parse(await api(`/refunds/${refundId}`));
          if (refund.id !== refundId || refund.payment_id !== paymentId || payment.status !== 'refunded'
            || payment.refund_status !== 'full' || payment.amount_refunded !== 54900) throw new PaymentError('PENDING');
          return { ...base, action: 'REFUND', refundId };
        }
        if (payment.status !== 'captured' || payment.amount_refunded !== 0 || payment.refund_status !== null) throw new PaymentError('PENDING');
        return { ...base, action: 'GRANT', refundId: null };
      } catch { throw new PaymentError('PENDING'); }
    },
  };
}
