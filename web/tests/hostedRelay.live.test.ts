import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';

// Explicit opt-in: no credentials, provider requests, billing, or usage writes.
// Fixed dedicated staging destination; never accept a caller-supplied URL.
const enabled = process.env.SIGMAROUND_RUN_PUBLIC_RELAY_ACCEPTANCE === 'true';
const origin = 'https://cluera-ai-relay-staging.onrender.com';
const endpoint = 'wss://cluera-ai-relay-staging.onrender.com/v1/session';
function probe(options: { suffix?: string; headers?: Record<string, string>; frame?: object; idle?: boolean; terminal?: boolean } = {}) {
  return new Promise<{ upgraded: boolean; status: number; code: number; safeReason: boolean; messages: number }>((resolve, reject) => {
    let upgraded = false, messages = 0, done = false;
    const peer = new WebSocket(endpoint + (options.suffix ?? ''), {
      headers: options.headers, handshakeTimeout: 15000, followRedirects: false,
      perMessageDeflate: false, maxPayload: 16000,
    });
    const timer = setTimeout(() => finish(), 20000);
    function finish(result?: { status: number; code: number; safeReason: boolean }) {
      if (done) return; done = true; clearTimeout(timer); peer.terminate();
      if (!result) reject(new Error(upgraded
        ? 'Hosted relay upgraded but did not complete the rejection/close deadline.'
        : 'Hosted relay transport failed before upgrade; details withheld.'));
      else resolve({ upgraded, messages, ...result });
    }
    peer.on('open', () => {
      upgraded = true;
      if (options.frame) peer.send(JSON.stringify(options.frame));
      else if (!options.idle) peer.close();
    });
    peer.on('message', (raw, binary) => {
      messages++;
      // Only this exact fixed frame can satisfy explicit terminal rejection.
      // Never print frames, and never count a timeout/local close as server close.
      if (options.terminal) {
        if (!binary && raw.toString() === '{"type":"sessionEnded"}') finish({ status: 101, code: 0, safeReason: true });
        else finish();
      }
    });
    peer.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.destroy(); finish({ status, code: 0, safeReason: true });
    });
    peer.on('close', (code, reason) => finish({ status: 101, code,
      safeReason: reason.toString() === 'Account session ended.' }));
    peer.on('error', () => finish());
  });
}

describe.skipIf(!enabled)('hosted staging relay public acceptance', () => {
  it('serves exact non-cacheable health over verified TLS without redirect', async () => {
    let response: Response;
    try { response = await fetch(`${origin}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(55000) }); }
    catch { throw new Error('Hosted relay health transport failed.'); }
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await response.text()) === '{"ok":true}').toBe(true);
  }, 60000);
  it('upgrades WSS then rejects an unauthenticated command without data', async () => {
    const result = await probe({ frame: { type: 'generate', id: 'unauthenticated-probe', prompt: 'synthetic' } });
    expect(result).toEqual({ upgraded: true, status: 101, code: 1008, safeReason: true, messages: 1 });
  }, 25000);
  it('rejects an invalid account token without echoing it', async () => {
    const result = await probe({ frame: { type: 'authenticate', accessToken: 'invalid-synthetic-staging-probe' } });
    expect(result).toEqual({ upgraded: true, status: 101, code: 1008, safeReason: true, messages: 1 });
  }, 25000);
  it('closes an idle unauthenticated connection by its bounded deadline', async () => {
    const result = await probe({ idle: true });
    expect(result).toEqual({ upgraded: true, status: 101, code: 1008, safeReason: true, messages: 1 });
  }, 25000);
  it.each([
    { frame: { type: 'generate', id: 'unauthenticated-probe', prompt: 'synthetic' } },
    { frame: { type: 'authenticate', accessToken: 'invalid-synthetic-staging-probe' } },
    { idle: true },
  ])('observes fixed terminal rejection without depending on close propagation %#', async options => {
    const result = await probe({ ...options, terminal: true });
    expect(result).toEqual({ upgraded: true, status: 101, code: 0, safeReason: true, messages: 1 });
  }, 25000);
  it('rejects browser cookies/origins, header tokens, query strings and subprotocols before upgrade', async () => {
    for (const options of [
      { headers: { Origin: 'https://cluera-ai-staging.vercel.app' } },
      { headers: { Cookie: 'synthetic=not-a-session' } },
      { headers: { Authorization: 'Bearer synthetic-not-a-token' } },
      { headers: { 'Sec-WebSocket-Protocol': 'synthetic' } },
      { suffix: '?synthetic=1' },
    ]) {
      const result = await probe(options);
      expect(result).toEqual({ upgraded: false, status: 403, code: 0, safeReason: true, messages: 0 });
    }
  }, 90000);
});
