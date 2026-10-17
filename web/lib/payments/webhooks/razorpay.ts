import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { json } from '../../http';
import { razorpayConfig } from '../core/config';
import { gatewayAccountDigest, paymentRpc } from '../core/rpc';
import { PaymentError, type PaymentEvent, type PaymentRpc } from '../core/types';
import { verifyRazorpayHmac } from '../providers/razorpay/signatures';

export function parseRazorpayEvent(raw: Uint8Array, eventId: string, expectedAccount: string): PaymentEvent | null {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(eventId)) throw new PaymentError('INVALID');
  const value = z.object({ entity: z.literal('event'), account_id: z.string(), event: z.string(),
    created_at: z.number().int().positive().max(8640000000000), payload: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  if (value.account_id !== expectedAccount || value.created_at * 1000 > Date.now() + 300000) throw new PaymentError('INVALID');
  if (!['payment.captured','order.paid','refund.processed'].includes(value.event)) return null;
  const item = z.object({ entity: z.object({ id: z.string(), payment_id: z.string().optional(), order_id: z.string().nullable().optional() }) });
  const resource = item.parse(value.payload[value.event === 'refund.processed' ? 'refund' : 'payment']).entity;
  const paymentId = value.event === 'refund.processed' ? resource.payment_id : resource.id;
  if (!paymentId || !/^pay_[A-Za-z0-9]{8,64}$/.test(paymentId) || (value.event === 'refund.processed' && !/^rfnd_[A-Za-z0-9]{8,64}$/.test(resource.id))) throw new PaymentError('INVALID');
  let orderId = resource.order_id ?? null;
  if (value.event === 'order.paid') {
    const order = item.parse(value.payload.order).entity;
    if (order.id !== orderId) throw new PaymentError('INVALID');
  }
  if (orderId !== null && !/^order_[A-Za-z0-9]{8,64}$/.test(orderId)) throw new PaymentError('INVALID');
  return { eventId, eventType: value.event as PaymentEvent['eventType'], resourceId: value.event === 'order.paid' ? orderId! : resource.id,
    paymentId, orderId, digest: createHash('sha256').update(raw).digest('hex'), occurredAt: new Date(value.created_at * 1000).toISOString() };
}
async function rawBody(request: Request): Promise<Uint8Array> {
  if (!request.body || Number(request.headers.get('content-length')) > 256 * 1024) throw new PaymentError('INVALID');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new PaymentError('INVALID')); void reader.cancel().catch(() => undefined); }, 2000); });
  try {
    while (true) { const { done, value } = await Promise.race([reader.read(), timeout]); if (done) break;
      size += value.length; if (size > 256 * 1024) throw new PaymentError('INVALID'); chunks.push(value); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer!); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function handleRazorpayWebhook(request: Request, env = process.env, rpc?: PaymentRpc): Promise<Response> {
  // V2 has one canonical inbox; shared intake flags must not admit both.
  if (env.CLUERA_BILLING_V2_ENABLED === 'true') return json({ error: 'Not found.' }, 404);
  if (env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED !== 'true' || env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED !== 'true') return json({ error: 'Not found.' }, 404);
  let event: PaymentEvent | null;
  try {
    const config = razorpayConfig(env);
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new PaymentError('INVALID');
    const raw = await rawBody(request);
    verifyRazorpayHmac(raw, request.headers.get('x-razorpay-signature') ?? '', config.webhookSecret);
    event = parseRazorpayEvent(raw, request.headers.get('x-razorpay-event-id') ?? '', config.accountId);
  } catch { return json({ error: 'Webhook could not be verified.' }, 400); }
  if (!event) return json({ received: true });
  try {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new PaymentError('CONFIGURATION');
    const service = rpc ? undefined : createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) =>
        fetch(input, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(2500) }) } });
    const state = await paymentRpc(rpc ?? ((name, args) => service!.rpc(name, args)), 'account_payment_receive',
      { p_event: event, p_account_digest: gatewayAccountDigest(env) });
    if (state === 'CONFLICT') return json({ error: 'Webhook requires review.' }, 409);
    if (!['STORED','DUPLICATE'].includes(state as string)) throw new PaymentError('UNAVAILABLE');
    return json({ received: true }); // Durable inbox acknowledgement, never paid/credited.
  } catch { return json({ error: 'Webhook intake is unavailable.' }, 503); }
}
