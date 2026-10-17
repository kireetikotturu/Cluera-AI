import { ClueraBillingError } from './contracts';
import { clueraBillingConfig } from './config';

/** Reviewed resource paths only, bounded body/deadline, no redirects or automatic retries. */
export function clueraRazorpayTransport(env = process.env, request: typeof fetch = fetch, monotonicNow: () => number = () => performance.now()) {
  const { keyId, keySecret } = clueraBillingConfig(env);
  // One verification chain must finish within its SQL lease, even with paginated invoice reads.
  const chainDeadline = monotonicNow() + 65000;
  return async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    const resource = /^\/(orders(?:\/order_[A-Za-z0-9]{8,64})?|subscriptions(?:\/sub_[A-Za-z0-9]{8,64})?|plans\/plan_[A-Za-z0-9]{8,64}|payments\/pay_[A-Za-z0-9]{8,64}|invoices\/inv_[A-Za-z0-9]{8,64}|refunds\/rfnd_[A-Za-z0-9]{8,64})$/;
    const invoiceList = /^\/invoices\?subscription_id=sub_[A-Za-z0-9]{8,64}&count=100&skip=\d{1,3}$/;
    if ((!resource.test(path) && !invoiceList.test(path)) || (body && !['/orders', '/subscriptions'].includes(path)))
      throw new ClueraBillingError('INVALID');
    const remaining = Math.min(10000,chainDeadline-monotonicNow());
    if (remaining <= 0) throw new ClueraBillingError('UNAVAILABLE');
    const controller = new AbortController(); let timer:ReturnType<typeof setTimeout>;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const expired = new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort();reject(new ClueraBillingError('UNAVAILABLE'));void reader?.cancel().catch(()=>undefined); },remaining); });
    try {
      const response = await Promise.race([request(`https://api.razorpay.com/v1${path}`, { method: body ? 'POST' : 'GET',
        redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) }),expired]);
      if (!response.ok || !response.body) throw new ClueraBillingError('UNAVAILABLE', response.status);
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) { const { done, value } = await Promise.race([reader.read(),expired]); if (done) break;
        bytes += value.byteLength; if (bytes > 256 * 1024) throw new ClueraBillingError('UNAVAILABLE'); chunks.push(value); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) { throw error instanceof ClueraBillingError ? error : new ClueraBillingError('UNAVAILABLE'); }
    finally {
      clearTimeout(timer!); controller.abort();
      // An upstream stream may never settle cancellation. Preserve the fixed
      // request/lease bounds without waiting for cancellation or leaking it.
      void reader?.cancel().catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* A pending read must not mask the fixed result. */ }
    }
  };
}
