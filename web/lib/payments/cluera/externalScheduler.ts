import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { schedulerEnabled, schedulerSecret, verifySchedulerRequest } from '../../../../shared/billingDispatch';
import { json } from '../../http';
import type { PaymentRpc } from '../core/types';
import { billingOwner, clueraIntakeEnabled } from './config';
import { handleClueraBillingTick, CLUERA_WORKER_URL, workerProofMessage } from './scheduler';
import type { reconcileClueraPayment } from './reconciliation';

/** Independent transport opt-in; it never substitutes for existing financial gates. */
export function externalClueraSchedulerEnabled(env = process.env): boolean {
  return schedulerEnabled(env) && clueraIntakeEnabled(env)
    && env.SIGMAROUND_PAYMENT_PROVIDER === 'razorpay'
    && (!env.VERCEL_ENV || env.VERCEL_ENV === 'production')
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production')
    && (!env.VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID === 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B')
    && (!env.VERCEL_ORG_ID || env.VERCEL_ORG_ID === 'team_AksnPXhi2VBXI5UsY2xBIakc');
}

/** Fixed authenticated dispatch, no caller-selected merchant, event, amount or user. */
export async function handleClueraExternalDispatch(request: Request, env = process.env, deps: {
  rpc?: PaymentRpc; now?: () => number; reconcile?: typeof reconcileClueraPayment;
} = {}): Promise<Response> {
  if (!externalClueraSchedulerEnabled(env)) return json({ error: 'Not found.' }, 404);
  const secret = schedulerSecret(env);
  if (!secret || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Worker unavailable.' }, 503);
  const verified = await verifySchedulerRequest(request, 'DISPATCH', secret, deps.now?.() ?? Date.now());
  if (!verified) return json({ error: 'Unauthorized.' }, 401);
  try {
    // The outer proof is verified before constructing any privileged SDK client.
    const service = deps.rpc ? null : createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }) },
    });
    const rpc: PaymentRpc = deps.rpc ?? ((name, args) => service!.rpc(name, args));
    const owner = await billingOwner(rpc, env);
    const seconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const proof = createHmac('sha256', secret)
      .update(workerProofMessage(owner.epoch, seconds, verified.nonce, owner.accountDigest)).digest('hex');
    // In-process delegation only. The existing durable nonce/lease/idempotency
    // handler and authoritative payment verification remain unchanged.
    const inner = new Request(CLUERA_WORKER_URL, { method: 'POST', body: '{}', headers: {
      'content-type': 'application/json', 'x-cluera-billing-time': String(seconds),
      'x-cluera-billing-nonce': verified.nonce, 'x-cluera-billing-epoch': String(owner.epoch), 'x-cluera-billing-proof': proof,
    } });
    return await handleClueraBillingTick(inner, env, { rpc, now: deps.now, reconcile: deps.reconcile });
  } catch { return json({ error: 'Worker unavailable.' }, 503); }
}
