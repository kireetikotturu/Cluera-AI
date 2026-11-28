import { z } from 'zod';
import type { UnlimitedAccess } from '../../../desktop/src/shared/accountCredits';

const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const status = z.object({ endsAt: z.iso.datetime({ offset: true }).nullable(), startedAt: z.iso.datetime({ offset: true }),
  compatibleMilliseconds: milliseconds }).strict().nullable();
type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/**
 * Admin-given unlimited access, for the website and the Windows app that asks for it. Replies to older apps stay as they
 * were: their time left already includes the unlimited time. `savedMilliseconds` is the other time kept for afterwards.
 * Undefined when it cannot be read, so the page simply shows the time left.
 */
export async function unlimitedAccess(rpc: Rpc, userId: string, availableMilliseconds: number): Promise<UnlimitedAccess | undefined> {
  try {
    const { data, error } = await rpc('cluera_unlimited_status', { p_user: userId });
    if (error) return undefined;
    const parsed = status.safeParse(data);
    if (!parsed.success) return undefined;
    return parsed.data && { endsAt: parsed.data.endsAt, savedMilliseconds: Math.max(0, availableMilliseconds - parsed.data.compatibleMilliseconds) };
  } catch { return undefined; }
}
