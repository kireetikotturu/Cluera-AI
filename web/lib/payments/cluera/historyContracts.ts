import { z } from 'zod';
import { clueraOfferCode } from './publicCatalog';

// Customer-safe immutable policy snapshot. No merchant, payer, provider plan,
// credential, invoice URL, raw receipt or privileged audit evidence is returned.
const revision = z.object({
  revisionId: z.uuid(), offerCode: clueraOfferCode, version: z.number().int().positive(),
  name: z.string().trim().min(2).max(80), kind: z.enum(['PACK', 'RECURRING']),
  amountPaise: z.number().int().min(100).max(10_000_000), currency: z.literal('INR'),
  allowanceSeconds: z.number().int().min(60).max(3_600_000),
}).strict().refine(row => (row.kind === 'PACK') === (row.offerCode === 'cluera_pack_3h_v2'));
const timestamp = z.iso.datetime({ offset: true });
const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/);
const payment = z.object({
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/),
  invoiceId: z.string().regex(/^inv_[A-Za-z0-9]{8,64}$/).nullable(),
  subscriptionId: subscriptionId.nullable(), state: z.enum(['VERIFIED', 'REFUNDED']),
  revision, intentCreatedAt: timestamp, paidAt: timestamp.nullable(),
  periodStart: timestamp.nullable(), periodEnd: timestamp.nullable(),
}).strict().superRefine((row, context) => {
  const pack = row.revision.kind === 'PACK';
  if (pack ? row.invoiceId !== null || row.subscriptionId !== null || row.paidAt !== null
      || row.periodStart !== null || row.periodEnd !== null
    : row.invoiceId === null || row.subscriptionId === null || row.paidAt === null
      || row.periodStart === null || row.periodEnd === null || Date.parse(row.periodEnd) <= Date.parse(row.periodStart))
    context.addIssue({ code: 'custom', message: 'Invalid payment history.' });
});
const subscription = z.object({
  subscriptionId, state: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED']),
  revision: revision.refine(row => row.kind === 'RECURRING'), observedAt: timestamp,
  paidThrough: timestamp.nullable(), graceUntil: timestamp.nullable(),
  cancelFuture: z.boolean(), cancellationAt: timestamp.nullable(),
}).strict();
export const clueraBillingHistorySchema = z.object({
  code: z.literal('ACTIVE'), userId: z.uuid(),
  payments: z.array(payment).max(50), subscriptions: z.array(subscription).max(50),
  hasMorePayments: z.boolean(), hasMoreSubscriptions: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.payments.map(row => row.paymentId)).size !== value.payments.length
    || new Set(value.payments.flatMap(row => row.invoiceId ? [row.invoiceId] : [])).size
      !== value.payments.filter(row => row.invoiceId !== null).length
    || new Set(value.subscriptions.map(row => row.subscriptionId)).size !== value.subscriptions.length)
    context.addIssue({ code: 'custom', message: 'Duplicate history entry.' });
  if ((value.hasMorePayments && value.payments.length !== 50)
    || (value.hasMoreSubscriptions && value.subscriptions.length !== 50))
    context.addIssue({ code: 'custom', message: 'Invalid history boundary.' });
});
export type ClueraBillingHistory = z.infer<typeof clueraBillingHistorySchema>;
