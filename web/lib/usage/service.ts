import { z } from 'zod';
import { AccountError } from '../accounts/config';
import { SupabaseOperationError } from '../supabase/diagnostics';
import {CLUERA_SUPABASE_URL} from '../supabase/target';

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown; status?: number }>;
const identity = z.object({ userId: z.uuid(), sessionId: z.uuid() });
const command = z.object({ runId: z.uuid(), sequence: z.number().int().min(0).max(1000000000),
  action: z.enum(['START','CHECKPOINT','STOP']) }).strict();
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const balance = z.object({ code: z.literal('ACTIVE'), availableMilliseconds: milliseconds,
  reservedMilliseconds: milliseconds, spentMilliseconds: milliseconds });
const active = z.object({ code: z.literal('ACTIVE'), runId: z.uuid(), sequence: z.number().int().nonnegative(),
  serverTime: z.iso.datetime({offset:true}), expiresAt: z.iso.datetime({offset:true}),
  reservedMilliseconds: z.number().int().min(1).max(30000), allocation: z.enum(['TRIAL','RECURRING','PACK']) });
const denied = z.object({ code: z.enum(['INVALID','UNAUTHENTICATED','SUSPENDED','FORBIDDEN','EXPIRED','DENIED',
  'STALE','TOO_EARLY','NOT_FOUND','CAPACITY','CLOSED','EXHAUSTED']) });

function assertStaging(env: NodeJS.ProcessEnv) {
  if (env.SIGMAROUND_ACCOUNTS_ENABLED !== 'true'
    || env.SIGMAROUND_ACCOUNT_ORIGIN !== 'https://cluera-ai-staging.vercel.app'
    || env.NEXT_PUBLIC_SUPABASE_URL !== CLUERA_SUPABASE_URL) {
    throw new AccountError('UNAVAILABLE',503);
  }
}
function unwrap(data: unknown) {
  const result=denied.safeParse(data);
  if (result.success && result.data.code==='UNAUTHENTICATED') throw new AccountError('UNAUTHENTICATED',401);
  if (result.success && ['SUSPENDED','FORBIDDEN'].includes(result.data.code)) throw new AccountError('FORBIDDEN',403);
  return result;
}

/** Server-only adapter. Identity must come from authorizeCustomer, never body/query fields.
 * No public spending route: only the trusted active provider/session coordinator may
 * start/checkpoint/stop, enforce the monotonic deadline, and stop work before expiry.
 */
export function usageService(rpc: Rpc, env=process.env, monotonic=()=>performance.now()) {
  assertStaging(env);
  return {
    async balance(verifiedIdentity: z.infer<typeof identity>) {
      const who=identity.parse(verifiedIdentity);
      const {data,error,status}=await rpc('customer_usage_balance',{p_user_id:who.userId,p_session_id:who.sessionId});
      if(error) throw new SupabaseOperationError('account.usage',error,status);
      unwrap(data);
      const parsed=balance.safeParse(data);
      if(!parsed.success) throw new AccountError('UNAVAILABLE',503);
      return parsed.data; // Drop all non-contract fields, not arbitrary database JSON.
    },
    async command(verifiedIdentity: z.infer<typeof identity>, input: z.infer<typeof command>) {
      const who=identity.parse(verifiedIdentity), value=command.parse(input), started=monotonic();
      const {data,error,status}=await rpc('customer_usage_command',{p_user_id:who.userId,p_session_id:who.sessionId,
        p_run_id:value.runId,p_sequence:value.sequence,p_action:value.action});
      if(error) throw new SupabaseOperationError('account.usage',error,status);
      const failure=unwrap(data);
      if(failure.success) return failure.data;
      const parsed=active.safeParse(data);
      if(!parsed.success || parsed.data.runId!==value.runId || parsed.data.sequence!==value.sequence) {
        throw new AccountError('UNAVAILABLE',503);
      }
      const remaining=Date.parse(parsed.data.expiresAt)-Date.parse(parsed.data.serverTime);
      const elapsed=monotonic()-started;
      if(!Number.isFinite(elapsed) || elapsed<0 || remaining>parsed.data.reservedMilliseconds) throw new AccountError('UNAVAILABLE',503);
      // Full request elapsed is subtracted conservatively. Local wall-clock changes
      // cannot extend the server authorization; cached replies are never renewed.
      const validForMilliseconds=Math.floor(remaining-elapsed);
      if(validForMilliseconds<=0) return {code:'EXPIRED' as const};
      return {...parsed.data,validForMilliseconds};
    },
  };
}
