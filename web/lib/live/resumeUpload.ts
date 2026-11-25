/** Saves the résumé used in a new phone session to the account (see the Privacy policy). It runs in the background:
 * a slow or failed save never affects the session. The original PDF or Word file is sent when one was uploaded,
 * otherwise the résumé text. */
export interface ResumeUse { text: string; name: string; file: File | null; sessionRef: string }

const UPLOAD_PREFIX = 'https://yhnqlfcgrmckhyjdxegg.supabase.co/storage/v1/object/upload/sign/customer-resumes/pending/';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MIME = { PDF: 'application/pdf', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as const;
type Kind = 'PDF' | 'DOCX' | 'TEXT' | 'MARKDOWN';
export const RESUME_RETRY_MS = [3_000, 20_000] as const;

export function resumeFileKind(name: string): Kind | null {
  const extension = name.toLowerCase().split('.').pop();
  return extension === 'pdf' ? 'PDF' : extension === 'docx' ? 'DOCX' : extension === 'txt' ? 'TEXT' : extension === 'md' || extension === 'markdown' ? 'MARKDOWN' : null;
}

interface Dependencies { request: typeof fetch; digest(data: BufferSource): Promise<ArrayBuffer>; wait(milliseconds: number): Promise<void> }
const browser = (): Dependencies => ({
  request: (input, init) => fetch(input, init), digest: data => crypto.subtle.digest('SHA-256', data),
  wait: milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); }),
});
const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** The account refused the request: trying again would not help. */
class Refused extends Error {}

export async function sendResume(use: ResumeUse, deps: Dependencies = browser()): Promise<'saved' | 'skipped' | 'failed'> {
  try {
    const text = use.text.trim().slice(0, 100_000);
    if (!text) return 'skipped';
    const kind = use.file ? resumeFileKind(use.file.name) : null;
    const file = use.file && kind && use.file.size > 0 && use.file.size <= MAX_FILE_BYTES ? use.file : null;
    const encoded = new TextEncoder().encode(text);
    const bytes = file ? await file.arrayBuffer() : null;
    const begin = {
      step: 'BEGIN' as const, kind: file ? kind as Kind : 'TYPED' as const,
      hash: hex(await deps.digest(bytes ?? encoded)), bytes: file ? file.size : encoded.length,
      name: ((file ? file.name : use.name).trim() || 'Résumé').slice(0, 200), sessionRef: use.sessionRef, text,
    };
    const call = async (body: object, timeoutMs: number): Promise<{ id?: string; upload?: { url?: string } | null }> => {
      const response = await deps.request('/api/account/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) });
      if ([400, 401, 403, 404].includes(response.status)) throw new Refused();
      if (!response.ok) throw new Error('unavailable');
      return response.json() as Promise<{ id?: string; upload?: { url?: string } | null }>;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await call(begin, 20_000);
        const url = reply.upload?.url;
        if (!url) return 'saved';
        if (!url.startsWith(UPLOAD_PREFIX) || !file || (begin.kind !== 'PDF' && begin.kind !== 'DOCX')) throw new Refused();
        const uploaded = await deps.request(url, { method: 'PUT', headers: { 'content-type': MIME[begin.kind], 'x-upsert': 'true' }, body: file,
          redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(180_000) });
        if (!uploaded.ok) throw new Error('upload');
        await call({ step: 'COMPLETE', id: reply.id }, 90_000);
        return 'saved';
      } catch (error) {
        if (error instanceof Refused || attempt >= RESUME_RETRY_MS.length) return 'failed';
        await deps.wait(RESUME_RETRY_MS[attempt]);
      }
    }
  } catch { return 'failed'; }
}
