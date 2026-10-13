import { PaymentError, type PaymentRpc } from './types';
import { createHash } from 'node:crypto';
import { razorpayConfig } from './config';
export function gatewayAccountDigest(env = process.env): string {
  const { keyId, accountId } = razorpayConfig(env);
  return createHash('sha256').update(`razorpay:test:${accountId}:${keyId}`).digest('hex');
}
export async function paymentRpc(rpc: PaymentRpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await rpc(name, args);
  if (result.error) throw new PaymentError('UNAVAILABLE');
  return result.data;
}
