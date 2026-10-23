import { z } from 'zod';
import { verifyRazorpayHmac } from '../providers/razorpay/signatures';
import { clueraBillingConfig } from './config';
import { ClueraBillingError, invoiceId, orderId, paymentId, planId, revisionSchema, subscriptionId,
  type Binding, type BillingEvent, type BillingEvidence, type Revision } from './contracts';
import { clueraRazorpayTransport } from './transport';
import { liveBillingProfile } from './modeProfile';

const timestamp = z.number().int().positive().max(8640000000000);
const subscriptionStates = z.enum(['created','authenticated','active','pending','halted','paused','cancelled','completed','expired']);
const noteSchema = z.object({ cluera_intent: z.uuid(), cluera_revision: z.uuid(), cluera_environment: z.enum(['test','live']) });
const orderSchema = z.object({ id: orderId, entity: z.literal('order'), amount: z.number().int().positive(), currency: z.literal('INR'),
  status: z.enum(['created','attempted','paid']), amount_paid: z.number().int().nonnegative(), amount_due: z.number().int().nonnegative(),
  receipt: z.string().nullable(), notes: z.unknown(), attempts: z.number().int().nonnegative(),
  offer_id: z.null().optional(), partial_payment: z.literal(false).optional() });
const paymentSchema = z.object({ id: paymentId, entity: z.literal('payment'), order_id: orderId, invoice_id: invoiceId.nullable(),
  amount: z.number().int().positive(), currency: z.literal('INR'), status: z.enum(['created','authorized','captured','refunded','failed']),
  captured: z.boolean(), amount_refunded: z.number().int().nonnegative(), refund_status: z.enum(['partial','full']).nullable(),
  international: z.literal(false), method: z.string().optional(), card: z.object({ network: z.string() }).nullable().optional() });
const subscriptionSchema = z.object({ id: subscriptionId, entity: z.literal('subscription'), plan_id: planId,
  status: subscriptionStates, quantity: z.literal(1), notes: noteSchema, paid_count: z.number().int().nonnegative(),
  total_count: z.number().int().positive(), customer_id: z.string().nullable(), has_scheduled_changes: z.literal(false),
  ended_at: timestamp.nullable().optional(),
  offer_id: z.null().optional(), addons: z.array(z.unknown()).length(0).optional() });
const invoiceSchema = z.object({ id: invoiceId, entity: z.literal('invoice'), subscription_id: subscriptionId,
  order_id: orderId, payment_id: paymentId, customer_id: z.string(), status: z.literal('paid'), currency: z.literal('INR'),
  amount: z.number().int().positive(), amount_paid: z.number().int().positive(), amount_due: z.literal(0),
  gross_amount: z.number().int().positive(), tax_amount: z.literal(0), partial_payment: z.literal(false),
  billing_start: timestamp, billing_end: timestamp, paid_at: timestamp,
  line_items: z.array(z.object({ type: z.literal('plan'), amount: z.number().int().positive(), unit_amount: z.number().int().positive(),
    gross_amount: z.number().int().positive(), net_amount: z.number().int().positive(), tax_amount: z.literal(0),
    currency: z.literal('INR'), quantity: z.literal(1), taxes: z.array(z.unknown()).length(0) })).length(1) });

/** Fixed operator diagnostics only; never includes provider payloads or identifiers. */
export class ClueraResumeError extends ClueraBillingError {
  constructor(readonly reason: 'ORDER_BINDING_MISMATCH' | 'ORDER_ALREADY_ATTEMPTED' | 'ORDER_BALANCE_CHANGED',
    readonly observation?: {state:'created'|'attempted'|'paid';attempts:number;paidPaise:number;duePaise:number}) {
    super('PENDING');
  }
}

export function recurringMethodAllowed(revision: Revision, method: string, network?: string) {
  if (revision.kind !== 'RECURRING') return true;
  if (!['card','upi','emandate'].includes(method)) return false;
  if (revision.amountPaise > 1500000 && method === 'card' && (!network || !['visa','mastercard','american express','amex'].includes(network.toLowerCase()))) return false;
  return !(revision.amountPaise > 1500000 && (method === 'upi' || (method === 'card' && network?.toLowerCase() === 'rupay')));
}
export function normalizeSubscriptionState(state: string): BillingEvidence['subscriptionState'] {
  return ({ active:'ACTIVE', pending:'PAST_DUE', halted:'PAST_DUE', paused:'PAUSED', cancelled:'CANCELED', completed:'CANCELED', expired:'CANCELED' } as const)[state] ?? null;
}
/** Plans are immutable at Razorpay; future Admin edits require a NEW revision and compatible plan. */
export function verifyClueraPlan(revision: Revision, raw: unknown) {
  revisionSchema.parse(revision);
  if (revision.kind !== 'RECURRING' || !revision.razorpayPlanId) throw new ClueraBillingError('UNSUPPORTED');
  const plan = z.object({ id: z.literal(revision.razorpayPlanId), entity: z.literal('plan'), period: z.literal('monthly'), interval: z.literal(1),
    item: z.object({ amount: z.literal(revision.amountPaise), currency: z.literal('INR'), active: z.literal(true).optional() }) }).parse(raw);
  return { planId: plan.id, period: 'monthly' as const, interval: 1 as const, amountPaise: revision.amountPaise,
    currency: 'INR' as const, observedAt: new Date().toISOString() };
}

export function clueraRazorpayAdapter(env = process.env, request: typeof fetch = fetch) {
  const api = clueraRazorpayTransport(env, request), config = clueraBillingConfig(env);
  const mode = liveBillingProfile(env) ? 'live' : 'test';
  const parseNotes = (raw: unknown) => {
    const notes = noteSchema.parse(raw);
    if (notes.cluera_environment !== mode) throw new ClueraBillingError('PENDING');
    return notes;
  };
  const parseSubscription = (binding: Binding, raw: unknown) => {
    const subscription = subscriptionSchema.parse(raw);
    parseNotes(subscription.notes);
    if (subscription.id !== binding.subscriptionId || subscription.plan_id !== binding.revision.razorpayPlanId
      || subscription.total_count !== binding.revision.totalCount || subscription.notes.cluera_intent !== binding.intentId
      || subscription.notes.cluera_revision !== binding.revision.revisionId) throw new ClueraBillingError('PENDING');
    return subscription;
  };
  const verifySubscription = async (binding: Binding) => {
    const subscription = parseSubscription(binding, await api(`/subscriptions/${binding.subscriptionId}`));
    await verifyPlan(binding.revision);
    return subscription;
  };
  const verifyPlan = async (revision: Revision) => verifyClueraPlan(revision, await api(`/plans/${revision.razorpayPlanId}`));
  const cancellationEvidence = (subscription: z.infer<typeof subscriptionSchema>) => {
    if (['cancelled','completed','expired'].includes(subscription.status)
      && (!subscription.ended_at || subscription.ended_at * 1000 > Date.now() + 5000)) throw new ClueraBillingError('PENDING');
    return { subscriptionId: subscription.id, providerState: subscription.status, observedAt: new Date().toISOString() };
  };
  return {
    verifyPlan,
    async resumeUntouchedPack(binding: Binding) {
      if (binding.revision.kind !== 'PACK' || binding.code !== 'BOUND' || !binding.orderId || binding.subscriptionId !== null)
        throw new ClueraBillingError('INVALID');
      const order = orderSchema.parse(await api(`/orders/${binding.orderId}`)), notes = noteSchema.parse(order.notes);
      if (order.id !== binding.orderId || order.receipt !== binding.intentId || order.amount !== binding.revision.amountPaise
        || notes.cluera_environment !== mode
        || notes.cluera_intent !== binding.intentId || notes.cluera_revision !== binding.revision.revisionId)
        throw new ClueraResumeError('ORDER_BINDING_MISMATCH');
      const observation={state:order.status,attempts:order.attempts,paidPaise:order.amount_paid,duePaise:order.amount_due};
      if (order.status !== 'created' || order.attempts !== 0) throw new ClueraResumeError('ORDER_ALREADY_ATTEMPTED',observation);
      if (order.amount_paid !== 0 || order.amount_due !== binding.revision.amountPaise) throw new ClueraResumeError('ORDER_BALANCE_CHANGED',observation);
      // Any associated payment, including authorized/failed/unknown, requires
      // reconciliation. Continuing an untouched order never means retrying one.
      z.object({ entity: z.literal('collection'), count: z.literal(0), items: z.array(z.unknown()).length(0) })
        .parse(await api(`/orders/${binding.orderId}/payments`));
      return { orderId: order.id, subscriptionId: null };
    },
    async cancellationStatus(binding: Binding) {
      if (binding.revision.kind !== 'RECURRING' || binding.code !== 'VERIFIED') throw new ClueraBillingError('INVALID');
      // A retired catalog/provider plan must not prevent ending its existing
      // subscription. The exact server-bound plan, notes and resource still match.
      return cancellationEvidence(parseSubscription(binding, await api(`/subscriptions/${binding.subscriptionId}`)));
    },
    async cancelFuture(binding: Binding) {
      if (binding.revision.kind !== 'RECURRING' || binding.code !== 'VERIFIED') throw new ClueraBillingError('INVALID');
      const current = parseSubscription(binding, await api(`/subscriptions/${binding.subscriptionId}`));
      if (['cancelled','completed','expired'].includes(current.status))
        return cancellationEvidence(current);
      if (!['active','pending','halted','paused'].includes(current.status)) throw new ClueraBillingError('PENDING');
      // Only a separately leased cancellation command may call this method.
      // End-of-cycle cancellation preserves already funded usage. The resource
      // may remain active until then; ACK is not a terminal lifecycle event.
      const result = parseSubscription(binding, await api(`/subscriptions/${binding.subscriptionId}/cancel`, { cancel_at_cycle_end: true }));
      if (!['active','pending','halted','paused','cancelled','completed','expired'].includes(result.status)) throw new ClueraBillingError('PENDING');
      return cancellationEvidence(result);
    },
    async create(intentId: string, revision: Revision) {
      z.uuid().parse(intentId); revisionSchema.parse(revision);
      const notes = { cluera_intent: intentId, cluera_revision: revision.revisionId, cluera_environment: mode };
      if (revision.kind === 'PACK') {
        const order = orderSchema.parse(await api('/orders', { amount: revision.amountPaise, currency: 'INR', receipt: intentId,
          partial_payment: false, notes }));
        const resultNotes = parseNotes(order.notes);
        if (order.status !== 'created' || order.receipt !== intentId || order.amount !== revision.amountPaise || order.amount_paid !== 0
          || order.amount_due !== revision.amountPaise || order.attempts !== 0 || resultNotes.cluera_intent !== intentId
          || resultNotes.cluera_revision !== revision.revisionId) throw new ClueraBillingError('PENDING');
        return { orderId: order.id, subscriptionId: null };
      }
      if (!revision.razorpayPlanId || !revision.testPlanValidated || !revision.totalCount) throw new ClueraBillingError('CONFIGURATION');
      await verifyPlan(revision);
      const subscription = subscriptionSchema.parse(await api('/subscriptions', { plan_id: revision.razorpayPlanId,
        quantity: 1, total_count: revision.totalCount, customer_notify: true, notes }));
      parseNotes(subscription.notes);
      if (subscription.status !== 'created' || subscription.paid_count !== 0 || subscription.customer_id !== null
        || subscription.plan_id !== revision.razorpayPlanId || subscription.total_count !== revision.totalCount
        || subscription.notes.cluera_intent !== intentId || subscription.notes.cluera_revision !== revision.revisionId)
        throw new ClueraBillingError('PENDING');
      return { orderId: null, subscriptionId: subscription.id };
    },
    verifyCallback(binding: Binding, receivedPaymentId: string, signature: string) {
      paymentId.parse(receivedPaymentId);
      // Order callbacks are order|payment; Subscriptions callbacks are payment|SERVER subscription.
      const bytes = binding.revision.kind === 'PACK' ? `${binding.orderId}|${receivedPaymentId}` : `${receivedPaymentId}|${binding.subscriptionId}`;
      verifyRazorpayHmac(bytes, signature, config.keySecret);
    },
    async resolvePayment(receivedPaymentId: string) { return paymentSchema.parse(await api(`/payments/${paymentId.parse(receivedPaymentId)}`)); },
    async resolvePaymentResource(receivedPaymentId: string) {
      const payment = paymentSchema.parse(await api(`/payments/${paymentId.parse(receivedPaymentId)}`));
      if (!payment.invoice_id) return payment.order_id;
      const invoice = z.object({id:z.literal(payment.invoice_id),entity:z.literal('invoice'),subscription_id:subscriptionId,
        order_id:z.literal(payment.order_id),payment_id:z.literal(payment.id)}).parse(await api(`/invoices/${payment.invoice_id}`));
      return invoice.subscription_id;
    },
    async inspect(binding: Binding, event: BillingEvent): Promise<BillingEvidence> {
      try {
        const revision = binding.revision;
        const base = { intentId: binding.intentId, amountPaise: revision.amountPaise, currency: 'INR' as const,
          observedAt: new Date().toISOString(), orderId: null, paymentId: null, invoiceId: null,
          subscriptionId: binding.subscriptionId, periodStart: null, periodEnd: null, paidAt:null, cancellationAt:null, subscriptionState: null, refundId: null };
        if (event.eventType.startsWith('subscription.') && event.eventType !== 'subscription.charged') {
          if (revision.kind !== 'RECURRING' || event.subscriptionId !== binding.subscriptionId) throw new ClueraBillingError('PENDING');
          const subscription = await verifySubscription(binding), state = normalizeSubscriptionState(subscription.status);
          // An ordinary authenticated receipt can arrive after later paid/lifecycle events.
          // Verify the canonical resource, but never reinterpret it as current paid state.
          if (event.eventType === 'subscription.authenticated') return {...base,action:'STATUS',subscriptionState:null};
          // Delivery ordering is not lifecycle authority. A late pending/paused/resumed
          // notification records the independently re-fetched CURRENT resource state.
          // Authenticated/setup notifications are audited NO_GRANT, never a paid entitlement.
          if (!state) throw new ClueraBillingError('PENDING');
          if (state === 'CANCELED' && (!subscription.ended_at || subscription.ended_at * 1000 > Date.now() + 5000)) throw new ClueraBillingError('PENDING');
          return { ...base, action: 'STATUS', subscriptionState: state,
            cancellationAt:state === 'CANCELED' ? new Date(subscription.ended_at! * 1000).toISOString() : null };
        }
        if (!event.paymentId) throw new ClueraBillingError('PENDING');
        const payment = paymentSchema.parse(await api(`/payments/${event.paymentId}`));
        if (payment.id !== event.paymentId || payment.amount !== revision.amountPaise || !payment.captured
          || (event.orderId && event.orderId !== payment.order_id) || (event.invoiceId && event.invoiceId !== payment.invoice_id))
          throw new ClueraBillingError('PENDING');
        const order = orderSchema.parse(await api(`/orders/${payment.order_id}`));
        if (order.id !== payment.order_id || order.amount !== revision.amountPaise || order.status !== 'paid'
          || order.amount_paid !== revision.amountPaise || order.amount_due !== 0) throw new ClueraBillingError('PENDING');
        let recurring: { periodStart: string; periodEnd: string; invoiceId: string; paidAt:string; cancellationAt:string|null; subscriptionState: BillingEvidence['subscriptionState'] } | undefined;
        if (revision.kind === 'PACK') {
          const notes = parseNotes(order.notes);
          if (binding.orderId !== order.id || order.receipt !== binding.intentId || notes.cluera_intent !== binding.intentId
            || notes.cluera_revision !== revision.revisionId || payment.invoice_id !== null || event.subscriptionId !== null)
            throw new ClueraBillingError('PENDING');
        } else {
          const subscription = await verifySubscription(binding);
          if (event.subscriptionId && event.subscriptionId !== binding.subscriptionId) throw new ClueraBillingError('PENDING');
          if (!payment.invoice_id || !subscription.customer_id || !recurringMethodAllowed(revision, payment.method ?? '', payment.card?.network))
            throw new ClueraBillingError('PENDING');
          const invoice = invoiceSchema.parse(await api(`/invoices/${payment.invoice_id}`));
          if (invoice.id !== payment.invoice_id || invoice.subscription_id !== binding.subscriptionId || invoice.payment_id !== payment.id
            || invoice.order_id !== order.id || invoice.customer_id !== subscription.customer_id || invoice.amount !== revision.amountPaise
            || invoice.amount_paid !== revision.amountPaise || invoice.gross_amount !== revision.amountPaise || invoice.billing_end <= invoice.billing_start
            || invoice.billing_end - invoice.billing_start < 27 * 86400 || invoice.billing_end - invoice.billing_start > 32 * 86400
            || invoice.paid_at * 1000 > Date.now() + 300000) throw new ClueraBillingError('PENDING');
          const line = invoice.line_items[0];
          if ([line.amount,line.unit_amount,line.gross_amount,line.net_amount].some(amount => amount !== revision.amountPaise)) throw new ClueraBillingError('PENDING');
          // Exact invoice membership in independently fetched subscription invoices; no moving current_* period inference.
          let matches = 0, complete = false;
          for (let page = 0; page < 10; page++) {
            const collection = z.object({ entity:z.literal('collection'), count:z.number().int().nonnegative(),
              items:z.array(z.object({ id:invoiceId, subscription_id:subscriptionId })).max(100) }).parse(
                await api(`/invoices?subscription_id=${binding.subscriptionId}&count=100&skip=${page * 100}`));
            if (collection.count !== collection.items.length || collection.items.some(item => item.subscription_id !== binding.subscriptionId)) throw new ClueraBillingError('PENDING');
            matches += collection.items.filter(item => item.id === invoice.id).length;
            if (collection.items.length < 100) { complete = true; break; }
          }
          if (!complete || matches !== 1) throw new ClueraBillingError('PENDING');
          const state = normalizeSubscriptionState(subscription.status);
          if (state === 'CANCELED' && (!subscription.ended_at || subscription.ended_at * 1000 > Date.now() + 5000
            || (event.eventType !== 'refund.processed' && invoice.paid_at > subscription.ended_at))) throw new ClueraBillingError('PENDING');
          recurring = { periodStart: new Date(invoice.billing_start * 1000).toISOString(), periodEnd: new Date(invoice.billing_end * 1000).toISOString(),
            invoiceId: invoice.id, paidAt:new Date(invoice.paid_at * 1000).toISOString(),
            cancellationAt:state === 'CANCELED' ? new Date(subscription.ended_at! * 1000).toISOString() : null, subscriptionState: state };
        }
        const financial = { ...base, orderId: order.id, paymentId: payment.id, ...(recurring ?? {}) };
        if (event.eventType === 'refund.processed') {
          const refund = z.object({ id:z.string().regex(/^rfnd_[A-Za-z0-9]{8,64}$/), entity:z.literal('refund'), payment_id:z.literal(payment.id),
            amount:z.literal(revision.amountPaise), currency:z.literal('INR'), status:z.literal('processed') }).parse(await api(`/refunds/${event.resourceId}`));
          if (refund.id !== event.resourceId || payment.status !== 'refunded' || payment.amount_refunded !== revision.amountPaise || payment.refund_status !== 'full')
            throw new ClueraBillingError('PENDING');
          return { ...financial, action:'REFUND', refundId:refund.id };
        }
        if (payment.status !== 'captured' || payment.amount_refunded !== 0 || payment.refund_status !== null
          || (revision.kind === 'RECURRING' && !['ACTIVE','CANCELED'].includes(recurring?.subscriptionState ?? '')))
          throw new ClueraBillingError('PENDING');
        return { ...financial, action:'GRANT' };
      } catch { throw new ClueraBillingError('PENDING'); }
    },
  };
}
