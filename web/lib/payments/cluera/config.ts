import { createHash } from 'node:crypto';
import { z } from 'zod';
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
  const accountDigest = merchantDigest(env);
  const result = await billingRpc(rpc, 'cluera_billing_owner', { p_account_digest: accountDigest });
  const value = z.object({ code: z.literal('ACTIVE'), owner: z.literal('cluera'),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().safeParse(result);
  if (!value.success)
    throw new ClueraBillingError('CONFIGURATION');
  // Clean SQL reports ACTIVE while account_digest is NULL. Prove that the
  // configured merchant is actually pinned: a distinct valid digest must conflict.
  // These reads cannot pin/change ownership or invoke a financial writer.
  const foreignDigest = `${(Number.parseInt(accountDigest[0], 16) ^ 1).toString(16)}${accountDigest.slice(1)}`;
  const foreign = await billingRpc(rpc, 'cluera_billing_owner', { p_account_digest: foreignDigest });
  if (!z.object({ code: z.literal('CONFLICT') }).strict().safeParse(foreign).success)
    throw new ClueraBillingError('CONFIGURATION');
  return { epoch: value.data.epoch, accountDigest };
}
