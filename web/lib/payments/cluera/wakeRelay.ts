import { RELAY_WAKE_URL, schedulerHeaders, schedulerSecret } from '../../../../shared/billingDispatch';
import { externalClueraSchedulerEnabled } from './externalScheduler';

/** Best-effort hint after durable signed receipt only; the relay owns catch-up.
 * No receipt/customer/provider identifiers or long-lived credential in the body.
 * A failed wake never retries a payment or changes durable receipt acceptance. */
export async function wakeClueraBillingRelay(env = process.env, request: typeof fetch = fetch,
  now = Date.now()): Promise<'DISABLED' | 'ACCEPTED' | 'UNAVAILABLE'> {
  if (!externalClueraSchedulerEnabled(env)) return 'DISABLED';
  const secret = schedulerSecret(env); if (!secret) return 'UNAVAILABLE';
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(Error('WAKE_UNAVAILABLE')); void reader?.cancel().catch(() => undefined);
  }, 2500); });
  try {
    const response = await Promise.race([request(RELAY_WAKE_URL, { method: 'POST', headers: schedulerHeaders('WAKE', secret, now),
      body: '{}', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal }), expired]);
    if (![200, 202].includes(response.status) || response.redirected || response.url && response.url !== RELAY_WAKE_URL
      || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !response.body) return 'UNAVAILABLE';
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 256)) return 'UNAVAILABLE';
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await Promise.race([reader.read(), expired]); if (part.done) break;
      size += part.value.byteLength; if (size > 256) return 'UNAVAILABLE'; chunks.push(part.value); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && value.accepted === true ? 'ACCEPTED' : 'UNAVAILABLE';
  } catch { return 'UNAVAILABLE'; }
  finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => undefined);
    try { reader?.releaseLock(); } catch { /* Do not await an uncooperative transport. */ } }
}
