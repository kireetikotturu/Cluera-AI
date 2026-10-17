import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { json } from '../../http';
import type { PaymentRpc } from '../core/types';
import { billingRpc, clueraIntakeEnabled, merchantDigest } from './config';
import { readClueraRawBody } from './events';
import { reconcileClueraPayment } from './reconciliation';
import { beginClueraReconciliationObservation } from './reconciliationObservation';
import { schedulerEnabled } from '../../../../shared/billingDispatch';

export const CLUERA_WORKER_URL = 'https://cluera-ai-staging.vercel.app/api/internal/billing/cluera/tick';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bodyDigest = createHash('sha256').update('{}').digest('hex');

/** pg_net receives only this short-lived proof, NEVER the long-lived worker key. */
export function workerProofMessage(epoch: number, seconds: number, nonce: string, accountDigest: string): string {
  return ['CLUERA-BILLING-TICK', 'POST', CLUERA_WORKER_URL, epoch, seconds, nonce, accountDigest, bodyDigest].join('\n');
}

/** One nonce, one durable lease; no caller-selected user, event, amount or action. */
export async function handleClueraBillingTick(request: Request, env = process.env, deps: {
  rpc?: PaymentRpc; reconcile?: typeof reconcileClueraPayment; now?: () => number;
} = {}): Promise<Response> {
  // Receiver-only activation must not admit even a correctly signed worker.
  if (!clueraIntakeEnabled(env) || !schedulerEnabled(env)) return json({ error: 'Not found.' }, 404);
  const secret = env.SIGMAROUND_BILLING_WORKER_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256 || !env.SUPABASE_SERVICE_ROLE_KEY)
    return json({ error: 'Worker unavailable.' }, 503);
  try {
    if (request.method !== 'POST' || request.url !== CLUERA_WORKER_URL || request.headers.has('origin')
      || request.headers.has('cookie') || request.headers.has('authorization')
      || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      return json({ error: 'Invalid request.' }, 400);
    const time = request.headers.get('x-cluera-billing-time') ?? '';
    const nonce = request.headers.get('x-cluera-billing-nonce') ?? '';
    const epochValue = request.headers.get('x-cluera-billing-epoch') ?? '';
    const proof = request.headers.get('x-cluera-billing-proof') ?? '';
    const seconds = Number(time), epoch = Number(epochValue), now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    if (!/^[1-9][0-9]{0,12}$/.test(time) || !Number.isSafeInteger(seconds)
      || seconds < now - 60 || seconds > now + 5 || !uuid.test(nonce)
      || !/^[1-9][0-9]{0,15}$/.test(epochValue) || !Number.isSafeInteger(epoch)
      || !/^[a-f0-9]{64}$/.test(proof)) return json({ error: 'Unauthorized.' }, 401);
    const accountDigest = merchantDigest(env);
    const expected = createHmac('sha256', secret).update(workerProofMessage(epoch, seconds, nonce, accountDigest)).digest();
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) return json({ error: 'Unauthorized.' }, 401);
    const raw = await readClueraRawBody(request, 128).catch(() => null);
    if (!raw || raw.length !== 2 || raw[0] !== 123 || raw[1] !== 125) return json({ error: 'Invalid request.' }, 400);
    const service = deps.rpc ? null : createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }) },
    });
    const rpc: PaymentRpc = deps.rpc ?? ((name, args) => service!.rpc(name, args));
    const state = await billingRpc(rpc, 'cluera_billing_worker_nonce', {
      p_nonce: nonce, p_issued_at: new Date(seconds * 1000).toISOString(), p_epoch: epoch, p_account_digest: accountDigest,
    });
    if (state === 'REPLAY' || state === 'INVALID') return json({ error: 'Unauthorized.' }, 401);
    if (state !== 'CLAIMED') return json({ error: 'Worker unavailable.' }, 503);
    // Observe only a durably admitted reconciliation; never infer granted time
    // from the HTTP acknowledgement or an idempotent VERIFIED result.
    const observe = beginClueraReconciliationObservation();
    try { observe(await (deps.reconcile ?? reconcileClueraPayment)(rpc, env)); }
    catch { observe('UNAVAILABLE'); throw new Error('Worker unavailable.'); }
    return json({ processed: true });
  } catch { return json({ error: 'Worker unavailable.' }, 503); }
}
