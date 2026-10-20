import { PaymentError } from './types';
import {CLUERA_SUPABASE_PROJECT,CLUERA_SUPABASE_URL} from '../../supabase/target';

export const ACCOUNT_PAYMENT_ORIGIN = 'https://cluera-ai-staging.vercel.app';
export function assertPaymentStaging(env = process.env): void {
  if (env.SIGMAROUND_ACCOUNTS_ENABLED !== 'true' || env.SIGMAROUND_ACCOUNT_ORIGIN !== ACCOUNT_PAYMENT_ORIGIN
    || env.NEXT_PUBLIC_SUPABASE_URL !== CLUERA_SUPABASE_URL
    || env.SIGMAROUND_RAZORPAY_TEST_PROJECT_REF !== CLUERA_SUPABASE_PROJECT
    || env.RAZORPAY_ENVIRONMENT !== 'test') throw new PaymentError('CONFIGURATION');
}
export function razorpayConfig(env = process.env) {
  assertPaymentStaging(env);
  const keyId = env.RAZORPAY_TEST_KEY_ID ?? '', keySecret = env.RAZORPAY_TEST_KEY_SECRET ?? '';
  const webhookSecret = env.RAZORPAY_TEST_WEBHOOK_SECRET ?? '', accountId = env.RAZORPAY_TEST_ACCOUNT_ID ?? '';
  if (!/^rzp_test_[A-Za-z0-9]{8,64}$/.test(keyId) || keySecret.length < 16 || keySecret.length > 256
    || webhookSecret.length < 32 || webhookSecret.length > 256 || !/^acc_[A-Za-z0-9]{8,64}$/.test(accountId)) throw new PaymentError('CONFIGURATION');
  return { keyId, keySecret, webhookSecret, accountId };
}
export function razorpayCheckoutEnabled(env = process.env): boolean {
  if (env.CLUERA_BILLING_UI_MODE === 'live') return false;
  try { razorpayConfig(env); } catch { return false; }
  return env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED === 'true' && env.SIGMAROUND_PAYMENT_PROVIDER === 'razorpay' && env.SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED === 'true'
    && env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED === 'false';
}
/** No customer-entered UUID or Admin approval. Temporary Test Mode operator gate. */
export function razorpayCheckoutAllowed(userId: string, env = process.env): boolean {
  const ids = (env.SIGMAROUND_PAYMENT_TESTER_IDS ?? '').split(',').map(value => value.trim());
  return razorpayCheckoutEnabled(env) && ids.length <= 50 && ids.every(value =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) && ids.includes(userId);
}
