/** Bounded browser reads, including a stalled body or a transport ignoring abort.
 * No retry: a timed-out write may already have reached the provider. */
export async function checkoutRequest(url: string, init: RequestInit) {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort = () => {};
  let failedStatus: number | undefined;
  const expired = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Billing request unavailable.'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(), 15_000);
    if (signal.aborted) abort();
  });
  try {
    const response = await Promise.race([fetch(url, { ...init, signal }), expired]);
    if (!response.ok) failedStatus = response.status;
    if (response.redirected || response.url && response.url !== new URL(url, location.origin).href
      || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
      || !response.body) throw new Error('Billing request unavailable.');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 131072)) throw new Error('Billing request unavailable.');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), expired]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 131072) throw new Error('Billing request unavailable.');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (signal.aborted) throw new Error('Billing request unavailable.');
    return { ok: response.ok, status: response.status, json: async () => value };
  } catch (error) {
    // Preserve HTTP denial even when its bounded body is empty, malformed or
    // stalled. Callers only interpret allowlisted reason codes, never raw text.
    if (failedStatus !== undefined) return { ok: false, status: failedStatus, json: async (): Promise<unknown> => null };
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    void reader?.cancel().catch(() => {});
    try { reader?.releaseLock(); } catch { /* Cleanup must not delay the UI. */ }
  }
}
