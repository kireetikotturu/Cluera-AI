import { createHash } from 'node:crypto';
import { paymentTestEnvironment } from './paymentTestMode';
/** Synthetic credentials only. Never used against a provider or hosted DB. */
export const paymentLiveEnvironment = {
  ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true',
  RAZORPAY_LIVE_KEY_ID: 'rzp_live_syntheticmode123456',
  RAZORPAY_LIVE_KEY_SECRET: 'synthetic-live-api-private-material-000000',
  RAZORPAY_LIVE_WEBHOOK_SECRET: 'synthetic-live-webhook-private-material-000000',
  RAZORPAY_LIVE_ACCOUNT_ID: 'acc_syntheticlivemode123456',
  CLUERA_LIVE_WORKER_SECRET: 'synthetic-live-worker-private-material-000000',
  CLUERA_LIVE_PROJECT_REF: 'yhnqlfcgrmckhyjdxegg',
  CLUERA_LIVE_ACCOUNT_ORIGIN: 'https://cluera-ai-staging.vercel.app',
  CLUERA_LIVE_APPROVED_ORIGIN: 'https://cluera-ai-staging.vercel.app',
  CLUERA_LIVE_MERCHANT_DIGEST: createHash('sha256').update('razorpay:live:acc_syntheticlivemode123456:rzp_live_syntheticmode123456').digest('hex'),
  CLUERA_LIVE_OWNER_APPROVED: 'true', CLUERA_LIVE_SECURITY_ACCEPTED: 'true', CLUERA_LIVE_TEST_ACCEPTED: 'true',
  CLUERA_LIVE_RUNTIME_ACCEPTED: 'true', CLUERA_LIVE_CHECKOUT_ENABLED: 'true', CLUERA_LIVE_INTAKE_ENABLED: 'true',
  CLUERA_LIVE_PURCHASER_IDS: paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS,
  CLUERA_LIVE_SCHEDULER_ENABLED: 'true', CLUERA_LIVE_CANCELLATION_ENABLED: 'true',
};
