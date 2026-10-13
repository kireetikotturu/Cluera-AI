import { razorpayConfig } from '../../core/config';
import { PaymentError } from '../../core/types';

/** Fixed API origin, reviewed resource paths, bounded reads, no redirects/retries. */
export function razorpayTransport(env = process.env, request: typeof fetch = fetch) {
  const { keyId, keySecret } = razorpayConfig(env);
  return async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (!/^\/(orders(?:\/order_[A-Za-z0-9]{8,64}(?:\/payments)?)?|payments\/pay_[A-Za-z0-9]{8,64}|refunds\/rfnd_[A-Za-z0-9]{8,64})$/.test(path))
      throw new PaymentError('INVALID');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await request(`https://api.razorpay.com/v1${path}`, { method: body ? 'POST' : 'GET',
        redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok || !response.body) throw new PaymentError('UNAVAILABLE', response.status);
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 256 * 1024) throw new PaymentError('UNAVAILABLE'); chunks.push(value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) { throw error instanceof PaymentError ? error : new PaymentError('UNAVAILABLE'); }
    finally { clearTimeout(timeout); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  };
}
