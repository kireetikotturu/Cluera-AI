import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CLUERA_SUPABASE_PROJECT, CLUERA_SUPABASE_URL } from '../../supabase/target';
import { razorpayConfig, ACCOUNT_PAYMENT_ORIGIN } from '../core/config';
import { ClueraBillingError } from './contracts';
import type { PaymentRpc } from '../core/types';

export type BillingMode = 'test' | 'live';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const secret = z.string().min(32).max(256).refine(value => value.trim() === value && !/[\r\n\0]/.test(value));
const razorpayKeySecret = z.string().min(16).max(256).refine(value => value.trim() === value && !/[\r\n\0]/.test(value));
const accountId = z.string().regex(/^acc_[A-Za-z0-9]{8,64}$/);
const originSchema = z.string().max(253).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && !url.port && !url.hostname.endsWith('.') && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname)
      && !/(^|\.)(localhost|local|invalid|internal|test)$/.test(url.hostname);
  } catch { return false; }
});
export const billingProfileProofSchema = z.object({
  mode: z.enum(['test', 'live']), merchantDigest: digest, origin: originSchema,
  ledgerNamespace: z.enum(['cluera_billing_private', 'cluera_live_billing_private']),
  grantPrefix: z.enum(['razorpay-test:', 'razorpay-live:']),
  workerAudience: z.enum(['cluera-billing-test-v1', 'cluera-billing-live-v1']),
  checkoutEnabled: z.boolean(), intakeEnabled: z.boolean(), epoch: z.number().int().positive().safe(),
}).strict();
export type BillingProfileProof = z.infer<typeof billingProfileProofSchema>;
const liveScopes = new WeakMap<NodeJS.ProcessEnv, ReturnType<typeof billingModeProfile>>();
export const liveBillingProfile = (env: NodeJS.ProcessEnv) => liveScopes.get(env);

/** Explicit server-created scope. Setting an environment variable or request
 * field cannot redirect an existing Test endpoint into Live. */
export function createLiveBillingScope(input = process.env): NodeJS.ProcessEnv {
  const profile = billingModeProfile('live', input);
  const worker = secret.parse(input.CLUERA_LIVE_WORKER_SECRET);
  if ([input.SIGMAROUND_BILLING_WORKER_SECRET, input.RAZORPAY_TEST_KEY_SECRET, input.RAZORPAY_TEST_WEBHOOK_SECRET,
    input.SUPABASE_SERVICE_ROLE_KEY, profile.keySecret, profile.webhookSecret,
    input.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64, input.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64].includes(worker))
    throw new ClueraBillingError('CONFIGURATION');
  const env: NodeJS.ProcessEnv = Object.freeze({ ...input,
    SIGMAROUND_BILLING_WORKER_SECRET: worker,
    CLUERA_RECURRING_SCHEDULE_ENABLED: input.CLUERA_LIVE_RECURRING_ENABLED === 'true' ? 'true' : 'false',
    CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED: input.CLUERA_LIVE_CANCELLATION_ENABLED === 'true' ? 'true' : 'false',
    CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED: input.CLUERA_LIVE_SCHEDULER_ENABLED === 'true' ? 'true' : 'false',
    CLUERA_ENTERPRISE_CHECKOUT_APPROVED: input.CLUERA_LIVE_ENTERPRISE_APPROVED === 'true' ? 'true' : 'false',
    CLUERA_NATIVE_RECURRING_HISTORY_ENABLED: input.CLUERA_LIVE_NATIVE_HISTORY_READ_ENABLED === 'true' ? 'true' : 'false',
  });
  liveScopes.set(env, profile);
  return env;
}
export function liveRuntimeApproved(env: NodeJS.ProcessEnv, capability: 'checkout' | 'intake') {
  return Boolean(liveBillingProfile(env)) && env.CLUERA_LIVE_OWNER_APPROVED === 'true'
    && env.CLUERA_LIVE_SECURITY_ACCEPTED === 'true' && env.CLUERA_LIVE_TEST_ACCEPTED === 'true'
    && env.CLUERA_LIVE_RUNTIME_ACCEPTED === 'true'
    && env[capability === 'checkout' ? 'CLUERA_LIVE_CHECKOUT_ENABLED' : 'CLUERA_LIVE_INTAKE_ENABLED'] === 'true';
}
export function livePurchaserAllowed(userId: string, env: NodeJS.ProcessEnv) {
  if (!z.uuid().safeParse(userId).success || !liveRuntimeApproved(env, 'checkout')) return false;
  if (env.CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED === 'true') return true;
  const ids = (env.CLUERA_LIVE_PURCHASER_IDS ?? '').split(',').map(value => value.trim());
  return ids.length <= 50 && ids.every(value => z.uuid().safeParse(value).success) && ids.includes(userId);
}
export function liveBillingRpc(rpc: PaymentRpc): PaymentRpc {
  return (name, args) => {
    if (!/^cluera_billing_[a-z_]+$/.test(name) || name.includes('legacy') || name.includes('_pre_'))
      throw new ClueraBillingError('CONFIGURATION');
    return rpc(name.replace(/^cluera_billing_/, 'cluera_live_billing_'), args);
  };
}

/** A profile is configuration, not financial activation. Test remains unchanged.
 * Live has distinct names, keys, receipt destination, signer audience and ledger.
 * Only an exact independently read database proof can authorize a capability. */
export function billingModeProfile(mode: BillingMode, env = process.env) {
  if (mode !== 'test' && mode !== 'live') throw new ClueraBillingError('CONFIGURATION');
  const live = mode === 'live';
  if (env.SIGMAROUND_ACCOUNTS_ENABLED !== 'true' || env.NEXT_PUBLIC_SUPABASE_URL !== CLUERA_SUPABASE_URL)
    throw new ClueraBillingError('CONFIGURATION');
  if (live && (env.VERCEL_ENV && env.VERCEL_ENV !== 'production'
    || env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== 'production'
    || env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID !== 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B'
    || env.VERCEL_ORG_ID && env.VERCEL_ORG_ID !== 'team_AksnPXhi2VBXI5UsY2xBIakc'))
    throw new ClueraBillingError('CONFIGURATION');
  const credentials = live ? {
    keyId: z.string().regex(/^rzp_live_[A-Za-z0-9]{8,64}$/).parse(env.RAZORPAY_LIVE_KEY_ID),
    keySecret: razorpayKeySecret.parse(env.RAZORPAY_LIVE_KEY_SECRET),
    webhookSecret: secret.parse(env.RAZORPAY_LIVE_WEBHOOK_SECRET),
    accountId: accountId.parse(env.RAZORPAY_LIVE_ACCOUNT_ID),
  } : razorpayConfig(env);
  const origin = live ? originSchema.parse(env.CLUERA_LIVE_ACCOUNT_ORIGIN) : ACCOUNT_PAYMENT_ORIGIN;
  if (live && (env.CLUERA_LIVE_PROJECT_REF !== CLUERA_SUPABASE_PROJECT
    || env.CLUERA_LIVE_APPROVED_ORIGIN !== origin
    || credentials.keyId === env.RAZORPAY_TEST_KEY_ID
    || credentials.keySecret === env.RAZORPAY_TEST_KEY_SECRET
    || credentials.webhookSecret === env.RAZORPAY_TEST_WEBHOOK_SECRET
    || credentials.keySecret === credentials.webhookSecret)) throw new ClueraBillingError('CONFIGURATION');
  if (live && [env.RAZORPAY_TEST_KEY_SECRET, env.RAZORPAY_TEST_WEBHOOK_SECRET, env.SIGMAROUND_BILLING_WORKER_SECRET,
    env.SUPABASE_SERVICE_ROLE_KEY, env.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64, env.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64]
    .some(value => value !== undefined && [credentials.keySecret, credentials.webhookSecret].includes(value)))
    throw new ClueraBillingError('CONFIGURATION');
  const merchantDigest = createHash('sha256').update(`razorpay:${mode}:${credentials.accountId}:${credentials.keyId}`).digest('hex');
  if (live && digest.parse(env.CLUERA_LIVE_MERCHANT_DIGEST) !== merchantDigest)
    throw new ClueraBillingError('CONFIGURATION');
  return Object.freeze({
    mode, ...credentials, origin, merchantDigest,
    ledgerNamespace: live ? 'cluera_live_billing_private' as const : 'cluera_billing_private' as const,
    grantPrefix: live ? 'razorpay-live:' as const : 'razorpay-test:' as const,
    workerAudience: live ? 'cluera-billing-live-v1' as const : 'cluera-billing-test-v1' as const,
    webhookUrl: origin + (live ? '/api/account/payments/cluera/live/webhook' : '/api/account/payments/cluera/webhook'),
    rpcPrefix: live ? 'cluera_live_billing_' : 'cluera_billing_',
  });
}

export function assertBillingProfileProof(
  profile: ReturnType<typeof billingModeProfile>, raw: unknown, capability: 'checkout' | 'intake', env = process.env,
) {
  const proof = billingProfileProofSchema.parse(raw);
  for (const key of ['mode', 'merchantDigest', 'origin', 'ledgerNamespace', 'grantPrefix', 'workerAudience'] as const) {
    if (proof[key] !== profile[key]) throw new ClueraBillingError('CONFIGURATION');
  }
  if (profile.mode === 'live' && (env.CLUERA_LIVE_OWNER_APPROVED !== 'true'
    || env.CLUERA_LIVE_SECURITY_ACCEPTED !== 'true'
    || env.CLUERA_LIVE_TEST_ACCEPTED !== 'true'
    || env.CLUERA_LIVE_RUNTIME_ACCEPTED !== 'true'
    || env[capability === 'checkout' ? 'CLUERA_LIVE_CHECKOUT_ENABLED' : 'CLUERA_LIVE_INTAKE_ENABLED'] !== 'true'))
    throw new ClueraBillingError('CONFIGURATION');
  if (!proof[capability === 'checkout' ? 'checkoutEnabled' : 'intakeEnabled'])
    throw new ClueraBillingError('CONFIGURATION');
  return proof;
}
