import { z } from 'zod';

/** Browser-safe contract for one owner-managed one-time pack. Prices are paise and time is seconds on the wire;
 * the Admin screen shows rupees and hours. No provider identifiers or secrets are ever part of it. */
export const adminPlanSchema = z.object({
  planId: z.uuid(), revisionId: z.uuid(), offerCode: z.literal('cluera_pack_3h_v2'),
  name: z.string().min(2).max(80), amountPaise: z.number().int().min(100).max(10_000_000), currency: z.literal('INR'),
  allowanceSeconds: z.number().int().min(60).max(3_600_000), kind: z.literal('PACK'), version: z.number().int().positive(),
  enabled: z.boolean(), archived: z.boolean(), createdAt: z.string().max(40), openCheckouts: z.number().int().nonnegative(),
}).strict().refine(plan => !(plan.archived && plan.enabled));
export type AdminPlan = z.infer<typeof adminPlanSchema>;

/** One line of "who changed what and when", from the immutable audit table. */
const snapshot = z.object({ name: z.string().optional(), amountPaise: z.number().optional(), allowanceSeconds: z.number().optional(),
  enabled: z.boolean().optional(), archived: z.boolean().optional() }).passthrough();
export const adminPlanHistorySchema = z.object({ at: z.string().max(40), by: z.string().max(254), action: z.string().max(40), reason: z.string().max(500),
  before: snapshot, after: snapshot }).strict();
export type AdminPlanHistory = z.infer<typeof adminPlanHistorySchema>;
