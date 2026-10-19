import { CLUERA_SUPABASE_URL } from '../supabase/target';
import { isPublishableKey } from '../supabase/publicKey';

export type AuthOptions = { google: 'enabled' | 'disabled' | 'unavailable' };
const unavailable: AuthOptions = { google: 'unavailable' };

/** Public capability metadata only. Never infer provider availability from an OAuth URL. */
export async function readAuthOptions(
  config: { url: string; anonKey: string }, request: typeof fetch = fetch,
): Promise<AuthOptions> {
  if (config.url !== CLUERA_SUPABASE_URL || !isPublishableKey(config.anonKey)) return unavailable;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_,reject) => { timer=setTimeout(() => { controller.abort();reject(new Error('Unavailable')); },5_000); });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const endpoint = `${config.url}/auth/v1/settings`;
    const response = await Promise.race([request(endpoint, {
      method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { apikey: config.anonKey, Accept: 'application/json' }, signal: controller.signal,
    }),deadline]);
    if (response.status !== 200 || response.redirected || response.url && response.url !== endpoint || !response.body
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return unavailable;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32_768)) return unavailable;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(),deadline]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32_768) return unavailable;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || !('external' in value)
      || !value.external || typeof value.external !== 'object' || !('google' in value.external)) return unavailable;
    return value.external.google === true ? { google: 'enabled' }
      : value.external.google === false ? { google: 'disabled' } : unavailable;
  } catch { return unavailable; }
  finally {
    clearTimeout(timer);controller.abort();
    void reader?.cancel().catch(() => undefined);
    try { reader?.releaseLock(); } catch { /* Pending read is already deadline-fenced. */ }
  }
}
