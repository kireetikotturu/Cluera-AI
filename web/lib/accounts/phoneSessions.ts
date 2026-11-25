import { z } from 'zod';
import { AccountError } from './config';
import { SupabaseOperationError } from '../supabase/diagnostics';

// History of live sessions run from the website on a phone. The Windows app reads the same rows, so this wire
// contract is shared by the browser BFF and the native API. Everything is bounded; the database repeats the limits.
const id = z.uuid();
const turn = z.object({
  id: z.string().min(1).max(64),
  question: z.string().max(6000),
  answer: z.string().max(24000),
  at: z.string().max(40),
  model: z.string().max(100).optional(),
  source: z.enum(['voice', 'typed', 'photo']).optional(),
}).strict();
export type PhoneTurn = z.infer<typeof turn>;
const text = (limit: number) => z.string().trim().max(limit);

export const phoneSessionCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('LIST') }).strict(),
  z.object({ action: z.literal('READ'), id }).strict(),
  z.object({ action: z.literal('DELETE'), id }).strict(),
  z.object({
    action: z.literal('SAVE'), id,
    kind: z.enum(['interview', 'assignment']),
    title: text(160).min(1), role: text(160), company: text(160), model: z.string().max(100),
    setup: z.record(z.string().max(60), z.unknown()).refine(value => JSON.stringify(value).length <= 18000),
    turns: z.array(turn).max(300).refine(value => JSON.stringify(value).length <= 470000),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
]);
export type PhoneSessionCommand = z.infer<typeof phoneSessionCommand>;

export const phoneSessionSummary = z.object({
  id, kind: z.enum(['interview', 'assignment']), title: z.string(), role: z.string(), company: z.string(), model: z.string(),
  startedAt: z.string(), endedAt: z.string().nullable(), updatedAt: z.string(), questionCount: z.number().int().nonnegative(),
});
export type PhoneSessionSummary = z.infer<typeof phoneSessionSummary>;

export async function phoneSessionAction(
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown; status?: number }>,
  account: { userId: string; sessionId: string }, input: unknown,
) {
  const parsed = phoneSessionCommand.safeParse(input);
  if (!parsed.success) throw new AccountError('INVALID_INPUT', 400);
  const { data, error, status } = await rpc('customer_phone_session_command', {
    p_user: account.userId, p_session: account.sessionId, p_input: parsed.data,
  });
  if (error) throw new SupabaseOperationError('account.workspace', error, status);
  const result = data as { code?: string };
  if (['INVALID', 'FORBIDDEN', 'NOT_FOUND'].includes(result?.code ?? '')) throw new AccountError('INVALID_INPUT', 400);
  if (result?.code !== 'ACTIVE') throw new AccountError(result?.code === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'FORBIDDEN', result?.code === 'UNAUTHENTICATED' ? 401 : 403);
  return data as { code: 'ACTIVE'; sessions?: unknown[]; session?: unknown };
}
