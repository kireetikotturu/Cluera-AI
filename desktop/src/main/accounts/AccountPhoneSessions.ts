import { z } from 'zod';
import { phoneSessionList, phoneSessionRead, type PhoneSessionDetail, type PhoneSessionSummary } from '../../shared/phoneSessions';
import type { AccountSessionManager } from './AccountSessionManager';
import { ACCOUNT_ORIGIN } from './AccountApi';

const unavailable = (): Error => new Error('Phone sessions are unavailable. Check your internet connection and try again.');
const MAX_BYTES = 1_500_000;

/**
 * Read-only view of the sessions the customer ran on their phone. Main owns the sign-in; the page never sees a token.
 * Nothing here starts a provider, reserves time or writes anything.
 */
export class AccountPhoneSessions {
  constructor(private readonly account: Pick<AccountSessionManager, 'status' | 'reportingCapability'>, private readonly owner: string,
    private readonly request: typeof fetch = fetch) {}

  private async call(input: { action: 'LIST' } | { action: 'READ'; id: string }): Promise<unknown> {
    const state = this.account.status();
    if (state.state !== 'active' || state.userId !== this.owner) throw unavailable();
    let auth: { accessToken: string; signal: AbortSignal };
    try { auth = await this.account.reportingCapability(); } catch { throw unavailable(); }
    try {
      const response = await this.request(`${ACCOUNT_ORIGIN}/api/account/native/phone-sessions`, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([auth.signal, AbortSignal.timeout(15_000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` }, body: JSON.stringify(input),
      });
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_BYTES) throw unavailable();
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { throw error instanceof Error && error.message === unavailable().message ? error : unavailable(); }
  }

  async list(): Promise<PhoneSessionSummary[]> {
    return phoneSessionList.parse(await this.call({ action: 'LIST' })).sessions;
  }

  async read(id: unknown): Promise<PhoneSessionDetail> {
    const session = phoneSessionRead.parse(await this.call({ action: 'READ', id: z.string().uuid().parse(id) })).session;
    if (session.id !== id) throw unavailable();
    return session;
  }
}
