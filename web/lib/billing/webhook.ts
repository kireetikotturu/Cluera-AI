import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { json, apiError } from '../http';
import { SupabaseOperationError } from '../supabase/diagnostics';
import { PaddleBoundaryError, verifyPaddleSignature } from './paddle';

const maximumBytes = 256 * 1024;
const envelope = z.object({
  event_id: z.string().regex(/^(evt|ntfsimevt)_[a-z0-9]{26}$/),
  event_type: z.string().regex(/^[a-z_]{1,40}\.[a-z_]{1,48}$/),
  occurred_at: z.iso.datetime({ offset: true }),
  notification_id: z.string().regex(/^(ntf|ntfsimntf)_[a-z0-9]{26}$/),
  data: z.object({ id: z.string().regex(/^[a-z]{3}_[a-z0-9]{26}$/) }).passthrough(),
});
export type SandboxEvent = {
  eventId: string; eventType: string; occurredAt: string; resourceId: string; eventDigest: string;
  simulation?: true;
};

// A stable event fingerprint excludes notification_id (different destinations
// receive different notification IDs for the SAME event). Raw bytes, not this
// serialization, are verified by HMAC first. Never retain or log the payload.
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new PaddleBoundaryError();
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function parseSandboxEvent(raw: Uint8Array): SandboxEvent | null {
  const parsed = envelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  // Paddle's simulator uses distinct IDs; never normalize them into billing IDs.
  const simulation = parsed.event_id.startsWith('ntfsimevt_');
  if (simulation !== parsed.notification_id.startsWith('ntfsimntf_')) throw new PaddleBoundaryError();
  const family = parsed.event_type.split('.')[0];
  const prefix = { transaction: 'txn_', subscription: 'sub_', adjustment: 'adj_' }[family];
  if (!prefix) return null; // Correctly signed unrelated catalog/customer events grant nothing.
  if (!parsed.data.id.startsWith(prefix)) throw new PaddleBoundaryError();
  return { eventId: parsed.event_id, eventType: parsed.event_type, occurredAt: parsed.occurred_at,
    ...(simulation ? { simulation: true as const } : {}),
    resourceId: parsed.data.id,
    eventDigest: createHash('sha256').update(canonical({ event_id: parsed.event_id,
      event_type: parsed.event_type, occurred_at: parsed.occurred_at, data: parsed.data })).digest('hex') };
}

async function readRaw(request: Request): Promise<Uint8Array> {
  if (!request.body || Number(request.headers.get('content-length')) > maximumBytes) throw new PaddleBoundaryError();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One bounded request deadline, not a background poll. Clear it on every exit.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new PaddleBoundaryError()); void reader.cancel().catch(() => undefined); }, 2000);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength; if (total > maximumBytes) throw new PaddleBoundaryError(); chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function persist(event: SandboxEvent, url: string, serviceKey: string): Promise<string> {
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init,
    redirect: 'error', signal: AbortSignal.timeout(2500), cache: 'no-store' });
  const service = createClient(url, serviceKey, { global: { fetch: boundedFetch }, auth: {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
  } });
  const { data, error, status } = await service.rpc(event.simulation
    ? 'paddle_sandbox_receive_simulation' : 'paddle_sandbox_receive', {
    p_event_id: event.eventId, p_event_type: event.eventType, p_occurred_at: event.occurredAt,
    p_resource_id: event.resourceId, p_event_digest: event.eventDigest,
  });
  if (error) throw new SupabaseOperationError('billing.sandbox.receive', error, status);
  if (!['STORED', 'DUPLICATE', 'CONFLICT'].includes(data)) throw new Error('Invalid billing intake result.');
  return data;
}

/** Sandbox intake only: never a checkout success callback or entitlement grant. */
export async function handleSandboxWebhook(request: Request, env = process.env,
  receive: typeof persist = persist): Promise<Response> {
  // Additional explicit project binding prevents accidentally using this
  // staging receiver with a Supabase URL copied from another environment.
  const ref = env.SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED !== 'true' || env.SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED !== 'true' || env.PADDLE_ENVIRONMENT !== 'sandbox') {
    return json({ error: 'Not found.' }, 404);
  }
  if (ref !== 'yhnqlfcgrmckhyjdxegg' || url !== 'https://yhnqlfcgrmckhyjdxegg.supabase.co'
    || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PADDLE_WEBHOOK_SECRET || env.PADDLE_WEBHOOK_SECRET.length < 20) {
    return json({ error: 'Billing sandbox is unavailable.' }, 503);
  }
  let event: SandboxEvent | null;
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      throw new PaddleBoundaryError();
    }
    const signature = request.headers.get('paddle-signature');
    if (!signature || signature.length > 1024) throw new PaddleBoundaryError();
    const raw = await readRaw(request);
    verifyPaddleSignature(raw, signature, env.PADDLE_WEBHOOK_SECRET);
    event = parseSandboxEvent(raw);
  } catch { return json({ error: 'Webhook could not be verified.' }, 400); }
  if (!event) return json({ received: true });
  try {
    const state = await receive(event, url, env.SUPABASE_SERVICE_ROLE_KEY);
    if (state === 'CONFLICT') {
      // Fixed category only; no event IDs, payloads, headers, secrets or PII.
      console.error('[billing-sandbox] event quarantined: conflicting duplicate');
      return json({ error: 'Webhook could not be accepted.' }, 409);
    }
    if (state !== 'STORED' && state !== 'DUPLICATE') throw new Error('Invalid billing intake result.');
    return json({ received: true }); // 200 only after durable storage, never "paid".
  } catch (error) {
    apiError(error); // Existing bounded diagnostic logger, no raw exception.
    return json({ error: 'Billing sandbox is unavailable.' }, 503); // Ask Paddle to retry.
  }
}
