import { liveDispatchConfig, liveDispatchHeaders } from '../shared/liveBillingDispatch';

/** One bounded attempt per minute. A missing acknowledgement never triggers an
 * immediate retry; database leases and unique nonces own financial processing. */
export function createLiveBillingTransport(env: Record<string, string | undefined> = process.env, deps: {
  fetch?: typeof fetch; observe?: (event: 'accepted' | 'unavailable') => void;
} = {}) {
  const config = liveDispatchConfig(env);
  let interval: ReturnType<typeof setInterval> | undefined, active: AbortController | undefined;
  let stopped = false, pending: Promise<void> | undefined;
  const tick = () => {
    if (!config || stopped || pending) return;
    const controller = new AbortController(); active = controller;
    pending = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const unavailable = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(Error('UNAVAILABLE')); }, 15000);
        controller.signal.addEventListener('abort', () => reject(Error('STOPPED')), { once: true });
      });
      try {
        const response = await Promise.race([(deps.fetch ?? fetch)(config.origin + '/api/internal/billing/cluera/live/tick', {
          method: 'POST', headers: liveDispatchHeaders(config), body: '{}', redirect: 'error',
          cache: 'no-store', signal: controller.signal,
        }), unavailable]);
        if (response.status !== 200 || response.redirected
          || response.url && response.url !== config.origin + '/api/internal/billing/cluera/live/tick'
          || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !response.body)
          throw Error('UNAVAILABLE');
        reader = response.body.getReader();
        const parts: Uint8Array[] = []; let bytes = 0;
        for (;;) {
          const part = await Promise.race([reader.read(), unavailable]); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 128) throw Error('UNAVAILABLE'); parts.push(part.value);
        }
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
        if (JSON.stringify(result) !== '{"processed":true}') throw Error('UNAVAILABLE');
        if (!stopped) deps.observe?.('accepted');
      } catch { if (!stopped) deps.observe?.('unavailable'); }
      finally {
        clearTimeout(timeout); controller.abort(); void reader?.cancel().catch(() => {});
        try { reader?.releaseLock(); } catch { /* Never wait on uncooperative cleanup. */ }
        if (active === controller) active = undefined;
      }
    })().finally(() => { pending = undefined; });
  };
  return {
    start() { if (!config || stopped || interval) return; tick(); interval = setInterval(tick, 60000); interval.unref?.(); },
    async stop() { stopped = true; clearInterval(interval); active?.abort(); await pending; },
  };
}
