import { z } from 'zod';
import { ACCOUNT_DISTRIBUTION } from '../../shared/accountDistribution';
import type {AccountCredits} from '../../shared/accountCredits';
import type {AccountAuthOptions} from '../../shared/accounts';
export const ACCOUNT_ORIGIN = ACCOUNT_DISTRIBUTION.apiOrigin;
export class AccountApiError extends Error {
  constructor(readonly status: number) { super(status === 401 ? 'Sign in with a verified email to continue.'
    : status === 403 ? 'Account access is suspended or unavailable.'
    : status === 429 ? 'Too many attempts. Try again later.' : 'Account service is unavailable.'); }
}
// Refresh tokens are opaque Auth credentials, not JWTs. Supabase currently
// issues 12-character values; their format/length is not a client contract.
export const accountRefreshToken = z.string().min(1).max(12000);
export const accountTokens = z.object({ accessToken: z.string().min(16).max(12000), refreshToken: accountRefreshToken,
  userId: z.string().uuid(), validForMilliseconds: z.number().int().positive().max(3600000) }).strict();
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const accountSnapshot = z.object({ account: z.object({ userId: z.string().uuid(), email: z.string().email().max(254) }).strict(),
  usage: z.object({ code: z.literal('ACTIVE'), availableMilliseconds: millis, reservedMilliseconds: millis, spentMilliseconds: millis }).strict() }).strict();
export type AccountTokens = z.infer<typeof accountTokens>;
type AccountAction = 'login'|'refresh'|'session'|'logout'|'oauth-exchange'|'credits'|'auth-options';
const authOptionsSchema: z.ZodType<AccountAuthOptions> = z.object({ google: z.enum(['enabled','disabled','unavailable']) }).strict();
const creditsSchema:z.ZodType<AccountCredits>=z.object({userId:z.string().uuid(),serverTime:z.string().datetime({offset:true}),displayName:z.string().max(80),
 availableMilliseconds:millis,reservedMilliseconds:millis,spentMilliseconds:millis,checkoutAvailable:z.boolean(),
 buckets:z.array(z.object({kind:z.enum(['TRIAL','RECURRING','PACK','TEST','MANUAL']),grantedMilliseconds:millis,spentMilliseconds:millis,
  reservedMilliseconds:millis,availableMilliseconds:millis}).strict()).max(5),
 plans:z.array(z.object({tier:z.enum(['PRO','ENTERPRISE']),state:z.enum(['ACTIVE','QUEUED','PAUSED','ENDED','REFUNDED']),
  paymentState:z.enum(['ACTIVE','PAST_DUE','CANCELED','PAUSED']),endsAt:z.string().datetime({offset:true}).nullable(),cancelFuture:z.boolean()}).strict()).max(30),
 payments:z.array(z.object({offerCode:z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly',
  'cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2']),
  state:z.enum(['CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED']),createdAt:z.string().datetime({offset:true})}).strict()).max(10),
}).strict();
type AccountDiagnostic = { operation: AccountAction; cause: 'request_or_response_failed'|'response_schema_invalid'; status: 503 };
export class AccountApi {
  constructor(private readonly request: typeof fetch = fetch,
    private readonly diagnostic: (event: AccountDiagnostic) => void = event => console.warn('[account-api]', event)) {}
  private report(operation: AccountAction, cause: AccountDiagnostic['cause']): void {
    // Fixed fields only. Never log bodies, tokens, identity, URLs or exceptions.
    try { this.diagnostic({ operation, cause, status: 503 }); } catch { /* logging cannot change auth */ }
  }
  private async call(action: AccountAction, input?: object, access?: string, signal?:AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectInterrupted!: (reason: AccountApiError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    void interrupted.catch(() => undefined);
    const interrupt = () => { controller.abort(); rejectInterrupted(new AccountApiError(503)); };
    const timer = setTimeout(interrupt, 15000); timer.unref?.();
    signal?.addEventListener('abort', interrupt, { once: true });
    // Cleanup is best effort: an unresponsive transport must not keep the UI busy.
    const discard = (body: ReadableStream<Uint8Array> | null) => {
      try { void body?.cancel().catch(() => undefined); } catch { /* already locked/closed */ }
    };
    try {
      if (signal?.aborted) throw new AccountApiError(503);
      const pending = this.request(`${ACCOUNT_ORIGIN}/api/account/${action === 'auth-options' ? action : `native/${action}`}`, {
        method: action === 'session' || action === 'credits' || action === 'auth-options' ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      void pending.then(response => { if (controller.signal.aborted) discard(response.body); }, () => undefined);
      const response = await Promise.race([pending, interrupted]);
      if (!response.ok) { discard(response.body); throw new AccountApiError([401,403,429].includes(response.status) ? response.status : 503); }
      reader = response.body?.getReader(); if (!reader) throw new AccountApiError(503);
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const result = await Promise.race([reader.read(), interrupted]); if (result.done) break;
        size += result.value.length; if (size > 40000) throw new AccountApiError(503); chunks.push(result.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (!(error instanceof AccountApiError) || error.status === 503) this.report(action, 'request_or_response_failed');
      throw error instanceof AccountApiError ? error : new AccountApiError(503);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', interrupt); controller.abort();
      try { void reader?.cancel().catch(() => undefined); } catch { /* cleanup cannot block auth */ }
    }
  }
  private parse<T>(operation: AccountAction, schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) { this.report(operation, 'response_schema_invalid'); throw new AccountApiError(503); }
    return result.data;
  }
  async login(input: { email: string; password: string }) { return this.parse('login', accountTokens, await this.call('login', input)); }
  async refresh(refreshToken: string) { return this.parse('refresh', accountTokens, await this.call('refresh', { refreshToken })); }
  async oauthExchange(code:string,verifier:string,signal?:AbortSignal) { return this.parse('oauth-exchange',accountTokens,await this.call('oauth-exchange',{code,verifier},undefined,signal)); }
  async snapshot(access: string) { return this.parse('session', accountSnapshot, await this.call('session', undefined, access)); }
  async credits(access:string,signal:AbortSignal) { return this.parse('credits',creditsSchema,await this.call('credits',undefined,access,signal)); }
  async authOptions(signal?:AbortSignal) { return this.parse('auth-options',authOptionsSchema,await this.call('auth-options',undefined,undefined,signal)); }
  async logout(access: string, allDevices: boolean) { await this.call('logout', { allDevices }, access); }
}
