import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentError } from '../../core/types';

export function verifyRazorpayHmac(bytes: Uint8Array | string, signature: string, secret: string): void {
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new PaymentError('INVALID');
  const expected = createHmac('sha256', secret).update(bytes).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new PaymentError('INVALID');
}
/** Use the SERVER's bound order, never a browser-supplied order as authority. */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret: string): void {
  if (!/^order_[A-Za-z0-9]{8,64}$/.test(orderId) || !/^pay_[A-Za-z0-9]{8,64}$/.test(paymentId)) throw new PaymentError('INVALID');
  verifyRazorpayHmac(`${orderId}|${paymentId}`, signature, secret);
}
