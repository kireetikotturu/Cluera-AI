import { z } from 'zod';

export const offerCode = z.enum(['cluera_pack_3h_v2', 'cluera_monthly_40h_v2', 'cluera_monthly_100h_v2', 'cluera_monthly_200h_v2']);
export const orderId = z.string().regex(/^order_[A-Za-z0-9]{8,64}$/);
export const paymentId = z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/);
export const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/);
export const invoiceId = z.string().regex(/^inv_[A-Za-z0-9]{8,64}$/);
export const planId = z.string().regex(/^plan_[A-Za-z0-9]{8,64}$/);
export const revisionSchema = z.object({ revisionId: z.uuid(), offerCode, name: z.string().trim().min(2).max(80),
  amountPaise: z.number().int().min(100).max(10000000), currency: z.literal('INR'),
  allowanceSeconds: z.number().int().min(60).max(3600000), kind: z.enum(['PACK', 'RECURRING']),
  interval: z.literal('MONTH').nullable(), razorpayPlanId: planId.nullable(), enabled: z.boolean(), version: z.number().int().positive(),
  totalCount: z.number().int().min(1).max(120).nullable(), testPlanValidated: z.boolean() })
  .strict().superRefine((value, context) => {
    if ((value.kind === 'PACK') !== (value.offerCode === 'cluera_pack_3h_v2')
      || (value.kind === 'PACK' ? value.interval !== null || value.razorpayPlanId !== null || value.totalCount !== null : value.interval !== 'MONTH' || value.totalCount === null))
      context.addIssue({ code: 'custom', message: 'Invalid catalog policy.' });
  });
export type Revision = z.infer<typeof revisionSchema>;
export const bindingSchema = z.object({ code: z.enum(['BOUND', 'VERIFIED', 'REFUNDED']), intentId: z.uuid(), userId: z.uuid(),
  orderId: orderId.nullable(), subscriptionId: subscriptionId.nullable(), revision: revisionSchema }).strict()
  .superRefine((value, context) => {
    if (value.revision.kind === 'PACK' ? !value.orderId || value.subscriptionId !== null : !value.subscriptionId || value.orderId !== null)
      context.addIssue({ code: 'custom', message: 'Invalid binding.' });
  });
export type Binding = z.infer<typeof bindingSchema>;
export const eventTypes = ['payment.captured', 'order.paid', 'refund.processed', 'subscription.charged', 'subscription.authenticated',
  'subscription.activated', 'subscription.pending', 'subscription.halted', 'subscription.cancelled', 'subscription.paused',
  'subscription.resumed', 'subscription.completed', 'subscription.updated'] as const;
export const eventSchema = z.object({ eventId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), eventType: z.enum(eventTypes),
  resourceId: z.string().min(8).max(100), paymentId: paymentId.nullable(), orderId: orderId.nullable(),
  subscriptionId: subscriptionId.nullable(), invoiceId: invoiceId.nullable(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: z.iso.datetime({ offset: true }) }).strict();
export type BillingEvent = z.infer<typeof eventSchema>;
export type BillingEvidence = { action: 'GRANT' | 'REFUND' | 'STATUS'; intentId: string; orderId: string | null;
  paymentId: string | null; invoiceId: string | null; subscriptionId: string | null; amountPaise: number; currency: 'INR';
  observedAt: string; periodStart: string | null; periodEnd: string | null;
  paidAt: string | null; cancellationAt: string | null;
  subscriptionState: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'PAUSED' | null; refundId: string | null };
const newPending = z.object({ intentId: z.uuid(), state: z.enum(['CREATING', 'BOUND', 'UNCERTAIN']), kind: z.enum(['PACK', 'RECURRING']),
  revisionId: z.uuid(), offerCode, orderId: orderId.nullable(), subscriptionId: subscriptionId.nullable(),legacy:z.literal(false) }).strict();
const oldPending = z.object({ intentId:z.uuid(),state:z.enum(['CREATING','BOUND','UNCERTAIN']),kind:z.literal('PACK'),revisionId:z.null(),
  offerCode:z.literal('pro_3_hours'),orderId:orderId.nullable(),subscriptionId:z.null(),legacy:z.literal(true) }).strict();
export const statusSchema = z.object({ userId: z.uuid(), code: z.enum(['AVAILABLE', 'PENDING', 'DISABLED']),
  pending: z.discriminatedUnion('legacy',[newPending,oldPending]).nullable(),
  resolvedOrderIds: z.array(orderId).max(50), resolvedSubscriptionIds: z.array(subscriptionId).max(50) }).strict();
export class ClueraBillingError extends Error {
  constructor(readonly code: 'CONFIGURATION' | 'INVALID' | 'PENDING' | 'UNAVAILABLE' | 'UNSUPPORTED', readonly httpStatus?: number) {
    super('Billing verification is unavailable.');
  }
}
