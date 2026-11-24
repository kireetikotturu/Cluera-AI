import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { json } from '../../http';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc, clueraIntakeEnabled, merchantDigest } from './config';
import { readClueraRawBody } from './events';
import { reconcileClueraPayment } from './reconciliation';
import { beginClueraReconciliationObservation } from './reconciliationObservation';
import { schedulerEnabled } from '../../../../shared/billingDispatch';
import { dispatchClueraNativeRecurringCommand, observeClueraNativeRecurringCommand } from './nativeRecurringOutbox';
import { liveBillingProfile, liveBillingRpc } from './modeProfile';
import { liveWorkerMessage } from '../../../../shared/liveBillingDispatch';

export const CLUERA_WORKER_URL = 'https://www.clueraai.in/api/internal/billing/cluera/tick';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bodyDigest = createHash('sha256').update('{}').digest('hex');

/** pg_net receives only this short-lived proof, NEVER the long-lived worker key. */
export function workerProofMessage(epoch: number, seconds: number, nonce: string, accountDigest: string, liveOrigin?: string): string {
  if (liveOrigin) return liveWorkerMessage(liveOrigin, epoch, seconds, nonce, accountDigest);
  return ['CLUERA-BILLING-TICK', 'POST', CLUERA_WORKER_URL,
    epoch, seconds, nonce, accountDigest, bodyDigest].join('\n');
}

/** One nonce, one durable lease; no caller-selected user, event, amount or action. */
export async function handleClueraBillingTick(request: Request, env = process.env, deps: {
  rpc?: PaymentRpc; reconcile?: typeof reconcileClueraPayment; now?: () => number;
} = {}): Promise<Response> {
  // Receiver-only activation must not admit even a correctly signed worker.
  if (!clueraIntakeEnabled(env) || !schedulerEnabled(env)) return rejectTick(env, 'DISABLED', 404, 'Not found.');
  const secret = env.SIGMAROUND_BILLING_WORKER_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256 || !env.SUPABASE_SERVICE_ROLE_KEY)
    return rejectTick(env, 'SECRET_MISSING', 503, 'Worker unavailable.');
  try {
    const live = liveBillingProfile(env);
    const workerUrl = live ? `${live.origin}/api/internal/billing/cluera/live/tick` : CLUERA_WORKER_URL;
    if (request.method !== 'POST' || request.url !== workerUrl || request.headers.has('origin')
      || request.headers.has('cookie') || request.headers.has('authorization')
      || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      return rejectTick(env, 'BAD_REQUEST_SHAPE', 400, 'Invalid request.');
    const time = request.headers.get('x-cluera-billing-time') ?? '';
    const nonce = request.headers.get('x-cluera-billing-nonce') ?? '';
    const epochValue = request.headers.get('x-cluera-billing-epoch') ?? '';
    const proof = request.headers.get('x-cluera-billing-proof') ?? '';
    const seconds = Number(time), epoch = Number(epochValue), now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    if (!/^[1-9][0-9]{0,12}$/.test(time) || !Number.isSafeInteger(seconds)
      || seconds < now - 60 || seconds > now + 5 || !uuid.test(nonce)
      || !/^[1-9][0-9]{0,15}$/.test(epochValue) || !Number.isSafeInteger(epoch)
      || !/^[a-f0-9]{64}$/.test(proof)) return rejectTick(env, seconds < now - 60 || seconds > now + 5 ? 'CLOCK_SKEW' : 'BAD_HEADERS', 401, 'Unauthorized.');
    const accountDigest = merchantDigest(env);
    const expected = createHmac('sha256', secret).update(workerProofMessage(epoch, seconds, nonce, accountDigest, live?.origin)).digest();
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) return rejectTick(env, 'PROOF_MISMATCH', 401, 'Unauthorized.');
    const raw = await readClueraRawBody(request, 128).catch(() => null);
    if (!raw || raw.length !== 2 || raw[0] !== 123 || raw[1] !== 125) return rejectTick(env, 'BAD_BODY', 400, 'Invalid request.');
    const service = deps.rpc ? null : createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }) },
    });
    const rawRpc: PaymentRpc = deps.rpc ?? ((name, args) => service!.rpc(name, args));
    const rpc = live ? liveBillingRpc(rawRpc) : rawRpc;
    if (live && (await billingOwner(rpc, env)).epoch !== epoch) return rejectTick(env, 'EPOCH_MISMATCH', 401, 'Unauthorized.');
    const state = await billingRpc(rpc, 'cluera_billing_worker_nonce', {
      p_nonce: nonce, p_issued_at: new Date(seconds * 1000).toISOString(), p_epoch: epoch, p_account_digest: accountDigest,
    });
    if (state === 'REPLAY' || state === 'INVALID') return rejectTick(env, `NONCE_${state}`, 401, 'Unauthorized.');
    if (state !== 'CLAIMED') return rejectTick(env, 'NONCE_UNAVAILABLE', 503, 'Worker unavailable.');
    // Observe only a durably admitted reconciliation; never infer granted time
    // from the HTTP acknowledgement or an idempotent VERIFIED result.
    const observe = beginClueraReconciliationObservation();
    try { observe(await (deps.reconcile ?? reconcileClueraPayment)(rpc, env)); }
    catch { observe('UNAVAILABLE'); throw new Error('Worker unavailable.'); }
    if(env.CLUERA_RECURRING_SCHEDULE_ENABLED==='true') {
      if(await observeClueraNativeRecurringCommand(rpc,env)==='EMPTY')await dispatchClueraNativeRecurringCommand(rpc,env);
    }
    return json({ processed: true });
  } catch { return rejectTick(env, 'EXCEPTION', 503, 'Worker unavailable.'); }
}
/** Fixed, secret-free reason code so operators can see why a signed worker tick
 * was refused. Never logs headers, nonces, proofs, digests, identities or values. */
function rejectTick(env: NodeJS.ProcessEnv, reason: string, status: number, error: string) {
  try { console.warn('[cluera-billing] tick-rejected', { component: 'cluera-billing-tick',
    mode: liveModeName(env), reason, httpStatus: status }); } catch { /* Logging never changes the response. */ }
  return json({ error }, status);
}
function liveModeName(env: NodeJS.ProcessEnv) { try { return liveBillingProfile(env) ? 'live' : 'test'; } catch { return 'unknown'; } }
