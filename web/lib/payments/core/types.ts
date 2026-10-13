export type PaymentProvider = 'razorpay' | 'stripe' | 'paddle';
export type PaymentBinding = { intentId: string; userId: string; orderId: string; offerCode: 'pro_3_hours' };
export type PaymentEvent = { eventId: string; eventType: 'payment.captured' | 'order.paid' | 'refund.processed';
  resourceId: string; paymentId: string; orderId: string | null; digest: string; occurredAt: string };
export type PaymentEvidence = { action: 'GRANT' | 'REFUND'; intentId: string; orderId: string; paymentId: string;
  amount: 54900; currency: 'INR'; observedAt: string; refundId: string | null };
export type PaymentAdapter = { provider: PaymentProvider; createOrder(intentId: string): Promise<{ orderId: string }>;
  verifyCallback(binding: PaymentBinding, paymentId: string, signature: string): void;
  inspect(binding: PaymentBinding, paymentId: string, refundId?: string): Promise<PaymentEvidence> };
export type PaymentRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;
/** Fixed categories only. Never expose raw gateway errors or payloads. */
export class PaymentError extends Error {
  constructor(readonly code: 'CONFIGURATION' | 'UNAVAILABLE' | 'INVALID' | 'PENDING' | 'UNSUPPORTED', readonly httpStatus?: number) {
    super('Payment could not be verified.');
  }
}
