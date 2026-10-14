import { z } from 'zod';

/** Browser-safe contracts. Merchant identifiers, provider plan IDs and secrets stay server-side. */
export const clueraOfferCode = z.enum([
  'cluera_pack_3h_v2', 'cluera_monthly_40h_v2',
  'cluera_monthly_100h_v2', 'cluera_monthly_200h_v2',
]);
export const clueraPublicRevision = z.object({
  revisionId: z.uuid(), offerCode: clueraOfferCode,
  name: z.string().trim().min(2).max(80), version: z.number().int().positive(),
  amountPaise: z.number().int().min(100).max(10_000_000), currency: z.literal('INR'),
  allowanceSeconds: z.number().int().min(60).max(3_600_000),
  kind: z.enum(['PACK', 'RECURRING']), interval: z.literal('MONTH').nullable(),
  totalCount: z.number().int().min(1).max(120).nullable(), testPlanValidated: z.boolean(), enabled: z.boolean(),
}).strict().refine(row => (row.kind === 'PACK') === (row.interval === null)
  && (row.kind === 'PACK') === (row.totalCount === null)
  && (row.offerCode === 'cluera_pack_3h_v2') === (row.kind === 'PACK'));
export const clueraPublicCatalog = z.array(clueraPublicRevision).max(4)
  .refine(rows => new Set(rows.map(row => row.offerCode)).size === rows.length);
export const clueraCatalogResponse = z.object({ catalog: clueraPublicCatalog }).strict();
export type ClueraPublicRevision = z.infer<typeof clueraPublicRevision>;
export type ClueraOfferCode = z.infer<typeof clueraOfferCode>;

const orderId = z.string().regex(/^order_[A-Za-z0-9]{8,64}$/);
const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/);
const pendingState = z.enum(['CREATING', 'BOUND', 'UNCERTAIN']);
const pending = z.discriminatedUnion('legacy', [
  z.object({ legacy: z.literal(false), intentId: z.uuid(), state: pendingState,
    kind: z.enum(['PACK', 'RECURRING']), revisionId: z.uuid(), offerCode: clueraOfferCode,
    orderId: orderId.nullable(), subscriptionId: subscriptionId.nullable(),
  }).strict(),
  z.object({ legacy: z.literal(true), intentId: z.uuid(), state: pendingState,
    kind: z.literal('PACK'), revisionId: z.null(), offerCode: z.literal('pro_3_hours'),
    orderId: orderId.nullable(), subscriptionId: z.null(),
  }).strict(),
]);
export const clueraCheckoutStatus = z.object({ payment: z.object({
  userId: z.uuid(), code: z.enum(['AVAILABLE', 'PENDING', 'DISABLED']),
  pending: pending.nullable(),
  resolvedOrderIds: z.array(orderId).max(50), resolvedSubscriptionIds: z.array(subscriptionId).max(50),
}).strict().refine(row => row.code !== 'AVAILABLE' || row.pending === null) }).strict();
export const clueraBoundCheckout = z.object({ payment: z.object({
  code: z.literal('BOUND'), kind: z.enum(['PACK', 'RECURRING']),
  orderId: orderId.nullable(), subscriptionId: subscriptionId.nullable(),
  keyId: z.string().regex(/^rzp_test_[A-Za-z0-9]{8,64}$/),
  amountPaise: z.number().int().min(100).max(10_000_000), currency: z.literal('INR'),
  revisionId: z.uuid(), offerCode: clueraOfferCode,
}).strict().refine(row => row.kind === 'PACK'
  ? row.orderId !== null && row.subscriptionId === null
  : row.subscriptionId !== null && row.orderId === null) }).strict();
export type ClueraBoundCheckout = z.infer<typeof clueraBoundCheckout>['payment'];

export function clueraPrice(amountPaise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR',
    maximumFractionDigits: amountPaise % 100 ? 2 : 0 }).format(amountPaise / 100);
}
export function clueraAllowance(allowanceSeconds: number): string {
  const hours = allowanceSeconds / 3600;
  return Number.isInteger(hours) ? `${hours} hours` : `${allowanceSeconds / 60} minutes`;
}
