import { createHash } from 'node:crypto';
import { razorpayConfig, razorpayCheckoutAllowed, razorpayCheckoutEnabled } from '../core/config';
import { ClueraBillingError } from './contracts';
import type { PaymentRpc } from '../core/types';

/** Exact isolated Cluera target. No Live, provider fallback, alternate DB or duplicate switch. */
export function clueraBillingConfig(env = process.env) { return razorpayConfig(env); }
export const clueraBillingV2Enabled = (env = process.env) => env.CLUERA_BILLING_V2_ENABLED === 'true';
export const clueraCheckoutEnabled = (env = process.env) => clueraBillingV2Enabled(env) && razorpayCheckoutEnabled(env);
export const clueraCheckoutAllowed = (userId: string, env = process.env) => clueraBillingV2Enabled(env) && razorpayCheckoutAllowed(userId, env);
export function clueraIntakeEnabled(env = process.env) {
  try { clueraBillingConfig(env); } catch { return false; }
  return clueraBillingV2Enabled(env) && env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED === 'true' && env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED === 'true';
}
export function merchantDigest(env = process.env) {
  const { keyId, accountId } = clueraBillingConfig(env);
  return createHash('sha256').update(`razorpay:test:${accountId}:${keyId}`).digest('hex');
}
export async function billingRpc(rpc: PaymentRpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  const value = await rpc(name, args);
  if (value.error) throw new ClueraBillingError('UNAVAILABLE');
  return value.data;
}
export async function billingOwner(rpc: PaymentRpc, env = process.env) {
  if (!clueraBillingV2Enabled(env)) throw new ClueraBillingError('CONFIGURATION');
  const result = await billingRpc(rpc, 'cluera_billing_owner', { p_account_digest: merchantDigest(env) });
  const value = result as { owner?: unknown; epoch?: unknown };
  if (value?.owner !== 'cluera' || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1)
    throw new ClueraBillingError('CONFIGURATION');
  return { epoch: Number(value.epoch), accountDigest: merchantDigest(env) };
}
