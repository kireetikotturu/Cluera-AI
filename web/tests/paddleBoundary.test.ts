import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readSandboxTransaction, verifyPaddleSignature } from '../lib/billing/paddle';
const secret = 'synthetic-webhook-fixture-only', now = 1791020000;
function signature(body: Uint8Array, at = now) { return `ts=${at};h1=${createHmac('sha256', secret).update(`${at}:`).update(body).digest('hex')}`; }
describe('sandbox Paddle security boundary', () => {
  it('accepts exact signed bytes, including rotation signatures', () => {
    const raw = Buffer.from('{ "event_id": "fixture" }');
    expect(() => verifyPaddleSignature(raw, signature(raw), secret, now)).not.toThrow();
    expect(() => verifyPaddleSignature(raw, signature(raw) + ';h1=' + '0'.repeat(64), secret, now)).not.toThrow();
  });
  it('rejects tampering, reserialization, wrong secret, stale/future and malformed signatures', () => {
    const raw = Buffer.from('{ "event_id": "fixture" }'), compact = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    expect(() => verifyPaddleSignature(compact, signature(raw), secret, now)).toThrow();
    expect(() => verifyPaddleSignature(raw, signature(raw), 'wrong-synthetic-secret', now)).toThrow();
    for (const header of [null, '', 'ts=not-time;h1=x', signature(raw, now - 6), signature(raw, now + 6), signature(raw) + `;ts=${now}`, signature(raw) + ';secret=not-allowed']) {
      expect(() => verifyPaddleSignature(raw, header, secret, now)).toThrow();
    }
  });
  it('does not contact live Paddle or trust a caller-provided resource path', async () => {
    const request = vi.fn();
    for (const env of [{}, { PADDLE_ENVIRONMENT: 'production', PADDLE_API_KEY: secret }]) {
      await expect(readSandboxTransaction('txn_' + 'a'.repeat(26), env, request)).rejects.toThrow();
    }
    await expect(readSandboxTransaction('../customers', { PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: secret }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('uses sandbox auth, bounded requests and narrow response projection', async () => {
    const id = 'txn_' + 'a'.repeat(26);
    const request = vi.fn(async () => Response.json({ data: { id, status: 'completed', customer_id: 'ctm_fixture',
      subscription_id: null, currency_code: 'INR', billing_details: { customer: 'do-not-forward' } } }));
    const value = await readSandboxTransaction(id, { PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: secret }, request);
    expect(request).toHaveBeenCalledWith(`https://sandbox-api.paddle.com/transactions/${id}`, expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
    expect(value.id).toBe(id); expect(JSON.stringify(value)).not.toContain('do-not-forward');
    expect(JSON.stringify(value)).not.toContain(secret);
  });
  it('does not expose provider errors or accept oversized/mismatched responses', async () => {
    const id = 'txn_' + 'a'.repeat(26), env = { PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: secret };
    await expect(readSandboxTransaction(id, env, async () => new Response(secret, { status: 500 }))).rejects.toThrow('Paddle sandbox request could not be verified.');
    await expect(readSandboxTransaction(id, env, async () => new Response('x'.repeat(262145)))).rejects.toThrow();
    await expect(readSandboxTransaction(id, env, async () => Response.json({ data: {} }))).rejects.toThrow();
  });
});
