import { z } from 'zod';

/** Sessions run from the website on a phone. The website saves them; the Windows app only reads and shows them. */
const text = (limit: number) => z.string().max(limit);
export const phoneSessionSummary = z.object({
  id: z.string().uuid(), kind: z.enum(['interview', 'assignment']), title: text(200), role: text(200), company: text(200), model: text(120),
  startedAt: text(64), endedAt: text(64).nullable(), updatedAt: text(64), questionCount: z.number().int().nonnegative().max(1000),
}).strict();
export const phoneTurn = z.object({
  id: text(64), question: text(6000), answer: text(24000), at: text(64), model: text(120).optional(), source: z.enum(['voice', 'typed', 'photo']).optional(),
}).strict();
export const phoneSessionDetail = phoneSessionSummary.omit({ questionCount: true }).extend({
  setup: z.record(z.string(), z.unknown()), turns: z.array(phoneTurn).max(300),
}).strict();
export const phoneSessionList = z.object({ code: z.literal('ACTIVE'), sessions: z.array(phoneSessionSummary).max(60) }).strict();
export const phoneSessionRead = z.object({ code: z.literal('ACTIVE'), session: phoneSessionDetail }).strict();
export type PhoneSessionSummary = z.infer<typeof phoneSessionSummary>;
export type PhoneSessionDetail = z.infer<typeof phoneSessionDetail>;
