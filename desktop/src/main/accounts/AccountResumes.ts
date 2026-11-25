import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../../shared/types';
import type { FileLibraryService } from '../app/FileLibraryService';
import type { AccountSessionManager } from './AccountSessionManager';
import { ACCOUNT_ORIGIN } from './AccountApi';

/** Where the one-time upload address must point: Cluera's own private résumé storage. */
const UPLOAD_PREFIX = 'https://yhnqlfcgrmckhyjdxegg.supabase.co/storage/v1/object/upload/sign/customer-resumes/pending/';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MIME = { PDF: 'application/pdf', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as const;
const KINDS: Record<string, 'PDF' | 'DOCX' | 'TEXT' | 'MARKDOWN'> = { '.pdf': 'PDF', '.docx': 'DOCX', '.txt': 'TEXT', '.md': 'MARKDOWN', '.markdown': 'MARKDOWN' };
const SESSION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Waits before trying again when the network or the service is briefly unavailable. */
export const RESUME_RETRY_MS = [30_000, 120_000, 600_000] as const;
/** The account refused the request: trying again would not help. */
class Refused extends Error {}

/**
 * Saves the résumé of a saved interview session to the customer's account (see the Privacy policy). It runs in the
 * background: saving a session never waits for it and never fails because of it. The original PDF or Word file is
 * sent when it is still in Files, otherwise the résumé text.
 */
export class AccountResumes {
  private readonly sent = new Set<string>();
  constructor(private readonly account: Pick<AccountSessionManager, 'status' | 'reportingCapability'>, private readonly owner: string,
    private readonly library: Pick<FileLibraryService, 'resumeSource'>, private readonly request: typeof fetch = fetch,
    private readonly retries: readonly number[] = RESUME_RETRY_MS) {}

  collect(session: Session): void { void this.save(session).catch(() => undefined); }

  async save(session: Session): Promise<'saved' | 'skipped' | 'failed'> {
    const text = session.kind === 'assignment' ? '' : session.resumeText.trim().slice(0, 100_000);
    if (!text) return 'skipped';
    const source = await this.library.resumeSource(session.resumeText, session.resumeFileName ?? '').catch(() => null);
    const kind = source ? KINDS[source.extension] : undefined;
    const file = source && kind && source.bytes.length <= MAX_FILE_BYTES ? { ...source, kind } : null;
    const typedName = session.resumeFileName && session.resumeFileName !== 'Resume on file' ? session.resumeFileName : 'Typed résumé';
    const begin = {
      step: 'BEGIN' as const, kind: file ? file.kind : 'TYPED' as const,
      hash: file ? file.hash : createHash('sha256').update(text).digest('hex'),
      name: (file ? file.name : typedName).trim().slice(0, 200) || 'Résumé',
      bytes: file ? file.bytes.length : Math.max(1, Buffer.byteLength(text, 'utf8')),
      sessionRef: SESSION_REF.test(session.id) ? session.id.toLowerCase() : null, text,
    };
    // Saving the same session again with the same résumé needs nothing new.
    const key = `${session.id}:${begin.hash}`;
    if (this.sent.has(key)) return 'skipped';
    this.sent.add(key);
    for (let attempt = 0; ; attempt++) {
      try { await this.send(begin, file?.bytes ?? null); return 'saved'; }
      catch (error) {
        if (error instanceof Refused) return 'failed';
        if (attempt >= this.retries.length) { this.sent.delete(key); return 'failed'; }
        await delay(this.retries[attempt], undefined, { ref: false });
      }
    }
  }

  private async send(begin: { kind: string } & Record<string, unknown>, bytes: Buffer | null): Promise<void> {
    const reply = await this.call(begin) as { id?: string; upload?: { url?: string } | null };
    const url = reply.upload?.url;
    if (!url) return;
    if (!bytes || !url.startsWith(UPLOAD_PREFIX) || (begin.kind !== 'PDF' && begin.kind !== 'DOCX')) throw new Refused();
    const uploaded = await this.request(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': MIME[begin.kind], 'x-upsert': 'true' }, body: new Uint8Array(bytes) });
    await uploaded.body?.cancel();
    if (!uploaded.ok) throw new Error('Upload unavailable.');
    await this.call({ step: 'COMPLETE', id: reply.id }, 90_000);
  }

  private async call(body: object, timeoutMs = 20_000): Promise<unknown> {
    const state = this.account.status();
    if (state.state !== 'active' || state.userId !== this.owner) throw new Refused();
    const auth = await this.account.reportingCapability();
    const response = await this.request(`${ACCOUNT_ORIGIN}/api/account/resume`, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([auth.signal, AbortSignal.timeout(timeoutMs)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404].includes(response.status)) throw new Refused();
      throw new Error('Résumé service unavailable.');
    }
    return response.json();
  }
}
