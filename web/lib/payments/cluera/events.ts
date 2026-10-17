import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { json } from '../../http';
import { verifyRazorpayHmac } from '../providers/razorpay/signatures';
import type { PaymentRpc } from '../core/types';
import { billingRpc, clueraBillingConfig, clueraIntakeEnabled, merchantDigest } from './config';
import { ClueraBillingError, eventSchema, eventTypes, invoiceId, orderId, paymentId, subscriptionId, type BillingEvent } from './contracts';

/** Safe projection only; raw-byte HMAC and exact merchant are mandatory before durable acceptance. */
export function parseClueraRazorpayEvent(raw: Uint8Array, eventId: string, expectedAccount: string): BillingEvent | null {
  const value = z.object({ entity:z.literal('event'), account_id:z.literal(expectedAccount), event:z.string(),
    created_at:z.number().int().positive().max(8640000000000), payload:z.record(z.string(),z.unknown()) })
    .parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
  if (value.created_at * 1000 > Date.now() + 300000) throw new ClueraBillingError('INVALID');
  if (!eventTypes.includes(value.event as typeof eventTypes[number])) return null;
  const item = (key:string) => z.object({ entity:z.object({ id:z.string(), payment_id:z.string().optional(),
    order_id:z.string().nullable().optional(), invoice_id:z.string().nullable().optional() }) }).parse(value.payload[key]).entity;
  const isSubscription = value.event.startsWith('subscription.');
  const refund = value.event === 'refund.processed' ? item('refund') : null;
  const subscription = isSubscription ? item('subscription') : null;
  const payment = value.payload.payment ? item('payment') : null;
  const receivedPayment = refund?.payment_id ?? payment?.id ?? null;
  if ((!isSubscription || value.event === 'subscription.charged') && !receivedPayment) throw new ClueraBillingError('INVALID');
  const receivedOrder = payment?.order_id ?? refund?.order_id ?? null;
  if (value.event === 'order.paid') {
    const order = item('order'); if (order.id !== receivedOrder) throw new ClueraBillingError('INVALID');
  }
  if (refund && !/^rfnd_[A-Za-z0-9]{8,64}$/.test(refund.id)) throw new ClueraBillingError('INVALID');
  return eventSchema.parse({ eventId, eventType:value.event,
    resourceId:subscription?.id ?? refund?.id ?? (value.event === 'order.paid' ? receivedOrder : receivedPayment),
    paymentId:receivedPayment === null ? null : paymentId.parse(receivedPayment),
    orderId:receivedOrder === null ? null : orderId.parse(receivedOrder), subscriptionId:subscription === null ? null : subscriptionId.parse(subscription.id),
    invoiceId:payment?.invoice_id ? invoiceId.parse(payment.invoice_id) : null,
    digest:createHash('sha256').update(raw).digest('hex'), occurredAt:new Date(value.created_at * 1000).toISOString() });
}
export async function readClueraRawBody(request: Request, maximumBytes = 256 * 1024): Promise<Uint8Array> {
  if (!request.body || Number(request.headers.get('content-length')) > maximumBytes) throw new ClueraBillingError('INVALID');
  const reader = request.body.getReader(), parts:Uint8Array[] = []; let size = 0;
  let timer:ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_,reject) => { timer = setTimeout(() => { reject(new ClueraBillingError('INVALID')); void reader.cancel().catch(() => undefined); },2000); });
  try {
    for (;;) { const chunk = await Promise.race([reader.read(), expired]); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maximumBytes) throw new ClueraBillingError('INVALID'); parts.push(chunk.value); }
    return Buffer.concat(parts);
  } finally { clearTimeout(timer!); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function handleClueraWebhook(request: Request, env = process.env, rpc?: PaymentRpc, onStored?: () => void) {
  if (!clueraIntakeEnabled(env)) return json({error:'Not found.'},404);
  let event:BillingEvent|null;
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ClueraBillingError('INVALID');
    const raw = await readClueraRawBody(request), config = clueraBillingConfig(env);
    verifyRazorpayHmac(raw,request.headers.get('x-razorpay-signature') ?? '',config.webhookSecret);
    event = parseClueraRazorpayEvent(raw,request.headers.get('x-razorpay-event-id') ?? '',config.accountId);
  } catch { return json({error:'Webhook could not be verified.'},400); }
  if (!event) return json({received:true});
  try {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new ClueraBillingError('CONFIGURATION');
    const service = rpc ? undefined : createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
      global:{fetch:(input,init) => fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)})}});
    const state = await billingRpc(rpc ?? ((name,args) => service!.rpc(name,args)), 'cluera_billing_event_accept', {p_event:event,p_account_digest:merchantDigest(env)});
    if (state === 'CONFLICT') return json({error:'Webhook requires review.'},409);
    if (state !== 'STORED' && state !== 'DUPLICATE') throw new ClueraBillingError('UNAVAILABLE');
    // Scheduling belongs to the platform route, not this reusable verifier.
    // Failure to register a hint cannot undo an already durable receipt.
    if (state === 'STORED' && onStored) { try { onStored(); } catch { /* Periodic catch-up remains responsible. */ } }
    return json({received:true});
  } catch { return json({error:'Webhook intake is unavailable.'},503); }
}
