import { razorpayAdapter } from './razorpay/adapter';
import { PaymentError, type PaymentAdapter, type PaymentProvider } from '../core/types';

/** Capability registry: no fallback to another gateway after uncertain writes. */
export function paymentAdapter(provider: PaymentProvider, env = process.env, request: typeof fetch = fetch): PaymentAdapter {
  if (provider === 'razorpay') return razorpayAdapter(env, request);
  // Stripe is an extension slot, not an operational integration. Paddle's
  // historical adapter remains in lib/billing; new checkout is disabled.
  throw new PaymentError('UNSUPPORTED');
}
export const gatewayCapabilities = Object.freeze([
  { provider: 'razorpay', label: 'Razorpay Test Mode', oneTime: true, recurring: false },
  { provider: 'stripe', label: 'Stripe — not available', oneTime: false, recurring: false },
  { provider: 'paddle', label: 'Paddle — historical records only', oneTime: false, recurring: false },
] as const);
