import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { json } from '../../http';
import { razorpayConfig } from '../core/config';
import { gatewayAccountDigest, paymentRpc } from '../core/rpc';
import { PaymentError, type PaymentRpc } from '../core/types';
import { paymentAdapter } from '../providers/registry';
import { razorpayTransport } from '../providers/razorpay/transport';

export async function reconcilePayment(rpc: PaymentRpc, env = process.env, request: typeof fetch = fetch) {
  const accountDigest = gatewayAccountDigest(env);
  const data = await paymentRpc(rpc, 'account_payment_claim', { p_account_digest: accountDigest });
  if ((data as { code?: string })?.code === 'EMPTY') return 'EMPTY';
  const event = z.object({ code: z.literal('CLAIMED'), eventId: z.string().min(8).max(128), claimId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
    eventType: z.enum(['payment.captured','order.paid','refund.processed']), resourceId: z.string(),
    paymentId: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/), orderId: z.string().nullable() }).parse(data);
  try {
    // Refund payloads may omit order_id. Fetch its exact payment to resolve the
    // canonical order, then independently re-fetch/verify all resources below.
    const orderId = event.orderId ?? z.object({ id: z.literal(event.paymentId), order_id: z.string().regex(/^order_[A-Za-z0-9]{8,64}$/) })
      .parse(await razorpayTransport(env, request)(`/payments/${event.paymentId}`)).order_id;
    const binding = z.object({ code: z.enum(['BOUND','VERIFIED','REFUNDED']), intentId: z.uuid(), userId: z.uuid(),
      orderId: z.literal(orderId), offerCode: z.literal('pro_3_hours') }).parse(await paymentRpc(rpc, 'account_payment_binding',
        { p_order: orderId, p_account_digest: accountDigest }));
    const evidence = await paymentAdapter('razorpay', env, request).inspect(binding, event.paymentId,
      event.eventType === 'refund.processed' ? event.resourceId : undefined);
    const applied = await paymentRpc(rpc, 'account_payment_apply', { p_event: event.eventId, p_claim: event.claimId,
      p_digest: event.digest, p_account_digest: accountDigest, p_evidence: evidence });
    const code = (applied as { code?: string })?.code;
    if (code !== 'VERIFIED' && code !== 'REFUNDED') throw new PaymentError('PENDING');
    return code;
  } catch {
    await paymentRpc(rpc, 'account_payment_retry', { p_event: event.eventId, p_claim: event.claimId });
    return 'PENDING';
  }
}
export async function handlePaymentTick(request: Request, env = process.env, rpc?: PaymentRpc): Promise<Response> {
  if (env.CLUERA_BILLING_V2_ENABLED === 'true') return json({ error: 'Not found.' }, 404);
  if (env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED !== 'true' || env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED !== 'true') return json({ error: 'Not found.' }, 404);
  try {
    razorpayConfig(env);
    const token = env.SIGMAROUND_BILLING_WORKER_SECRET ?? '', expected = `Bearer ${token}`, received = request.headers.get('authorization') ?? '';
    if (request.method !== 'POST' || token.length < 32 || token.length > 256 || received.length !== expected.length
      || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return json({ error: 'Not authorized.' }, 401);
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new PaymentError('CONFIGURATION');
    const service = rpc ? undefined : createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) =>
        fetch(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) }) } });
    return json({ result: await reconcilePayment(rpc ?? ((name, args) => service!.rpc(name, args)), env) });
  } catch { return json({ error: 'Payment reconciliation is unavailable.' }, 503); }
}
