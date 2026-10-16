import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSandboxWebhook, parseSandboxEvent } from '../lib/billing/webhook';
import { SupabaseOperationError } from '../lib/supabase/diagnostics';

const secret = 'synthetic-paddle-webhook-fixture-only';
const env = { CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'true', SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED: 'true', PADDLE_ENVIRONMENT: 'sandbox',
  SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF: 'yhnqlfcgrmckhyjdxegg', NEXT_PUBLIC_SUPABASE_URL: 'https://yhnqlfcgrmckhyjdxegg.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic-service-fixture-only', PADDLE_WEBHOOK_SECRET: secret };
const event = { event_id: 'evt_' + 'a'.repeat(26), event_type: 'transaction.completed',
  occurred_at: '2026-10-04T01:00:00Z', notification_id: 'ntf_' + 'a'.repeat(26),
  data: { id: 'txn_' + 'a'.repeat(26), custom_data: { user: 'untrusted-user' }, email: 'private@example.invalid' } };
function request(body = JSON.stringify(event), at = Math.floor(Date.now() / 1000), header?: string) {
  const signature = `ts=${at};h1=${createHmac('sha256', secret).update(`${at}:`).update(body).digest('hex')}`;
  return new Request('https://staging.example.invalid/api/billing/paddle/sandbox', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': header ?? signature } });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Paddle sandbox durable intake', () => {
  it('isolates authentic simulator envelopes from the billing RPC and rejects mixed ID namespaces', async () => {
    const simulated = { ...event, event_id: 'ntfsimevt_' + 'a'.repeat(26), notification_id: 'ntfsimntf_' + 'b'.repeat(26) };
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json('STORED'));
    vi.stubGlobal('fetch', transport);
    expect((await handleSandboxWebhook(request(JSON.stringify(simulated)), env)).status).toBe(200);
    expect(transport).toHaveBeenCalledOnce();
    expect(String(transport.mock.calls[0][0])).toBe(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/paddle_sandbox_receive_simulation`);
    expect(parseSandboxEvent(Buffer.from(JSON.stringify(simulated)))?.simulation).toBe(true);
    const receive = vi.fn();
    for (const body of [{ ...simulated, notification_id: event.notification_id }, { ...event, notification_id: simulated.notification_id }]) {
      expect((await handleSandboxWebhook(request(JSON.stringify(body)), env, receive)).status).toBe(400);
    }
    expect((await handleSandboxWebhook(request(JSON.stringify(simulated), undefined, 'invalid'), env, receive)).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });
  it('is disabled by default and rejects live mode or a mismatched project before reading/persisting', async () => {
    const receive = vi.fn();
    for (const config of [{}, { ...env, PADDLE_ENVIRONMENT: 'live' }, { ...env, SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED: 'false' }]) {
      expect((await handleSandboxWebhook(request(), config, receive)).status).toBe(404);
    }
    expect((await handleSandboxWebhook(request(), { ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co' }, receive)).status).toBe(503);
    expect((await handleSandboxWebhook(request(), { ...env, SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'bzccuqforilpifhiysjk',NEXT_PUBLIC_SUPABASE_URL:'https://bzccuqforilpifhiysjk.supabase.co' }, receive)).status).toBe(503);
    expect(receive).not.toHaveBeenCalled();
  });
  it('acknowledges only after durable storage, and never sends payload/PII/custom account mapping to the database', async () => {
    for (const state of ['STORED', 'DUPLICATE']) {
      const receive = vi.fn(async () => state);
      const response = await handleSandboxWebhook(request(), env, receive);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true });
      expect(receive).toHaveBeenCalledOnce();
      expect(receive.mock.calls[0][0]).toEqual({ eventId: event.event_id, eventType: event.event_type,
        occurredAt: event.occurred_at, resourceId: event.data.id, eventDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(receive.mock.calls[0][0])).not.toMatch(/private@|untrusted-user|synthetic-/);
    }
  });
  it('deduplicates the event, not a delivery notification or JSON field order', () => {
    const first = parseSandboxEvent(Buffer.from(JSON.stringify(event)));
    const redelivery = parseSandboxEvent(Buffer.from(JSON.stringify({ data: { email: event.data.email,
      custom_data: event.data.custom_data, id: event.data.id }, notification_id: 'ntf_' + 'b'.repeat(26),
      occurred_at: event.occurred_at, event_type: event.event_type, event_id: event.event_id })));
    expect(redelivery).toEqual(first);
    expect(parseSandboxEvent(Buffer.from(JSON.stringify({ ...event, data: { ...event.data, status: 'changed' } })))?.eventDigest)
      .not.toBe(first?.eventDigest);
  });
  it('uses the installed Supabase SDK to call only the restricted sandbox RPC', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify('STORED'), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', transport);
    const response = await handleSandboxWebhook(request(), env);
    expect(response.status).toBe(200); expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/paddle_sandbox_receive`);
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['p_event_digest', 'p_event_id', 'p_event_type', 'p_occurred_at', 'p_resource_id']);
    expect(body.p_event_id).toBe(event.event_id);
    expect(String(init.body)).not.toContain(event.data.email);
    expect(String(init.body)).not.toContain('custom_data');
    expect(await response.text()).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
  });
  it('rejects missing/invalid/stale signatures, malformed JSON and entity mismatches without a write', async () => {
    const receive = vi.fn();
    for (const req of [request(undefined, undefined, ''), request(undefined, undefined, 'bad'),
      request(undefined, Math.floor(Date.now() / 1000) - 10), request('{'),
      request(JSON.stringify({ ...event, data: { id: 'sub_' + 'a'.repeat(26) } })),
      request(JSON.stringify({ ...event, occurred_at: 'infinity' }))]) {
      expect((await handleSandboxWebhook(req, env, receive)).status).toBe(400);
    }
    expect(receive).not.toHaveBeenCalled();
  });
  it('bounds byte size even without a content-length header and rejects excessive nesting', async () => {
    const receive = vi.fn();
    expect((await handleSandboxWebhook(request('x'.repeat(262145)), env, receive)).status).toBe(400);
    let nested: unknown = {};
    for (let i = 0; i < 40; i++) nested = { nested };
    expect((await handleSandboxWebhook(request(JSON.stringify({ ...event, data: { ...event.data, nested } })), env, receive)).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });
  it('cancels stalled request bodies with a bounded deadline', async () => {
    vi.useFakeTimers();
    try {
      const canceled = vi.fn(), receive = vi.fn();
      const req = new Request('https://staging.example.invalid', { method: 'POST',
        body: new ReadableStream({ cancel: canceled }), headers: { 'content-type': 'application/json', 'paddle-signature': 'synthetic-stalled-request' },
        duplex: 'half' } as RequestInit);
      const response = handleSandboxWebhook(req, env, receive);
      await vi.advanceTimersByTimeAsync(2001);
      expect((await response).status).toBe(400); expect(canceled).toHaveBeenCalled();
      expect(receive).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('returns retriable failures without logging or echoing secrets/PII', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const receive = vi.fn(async () => { throw new SupabaseOperationError('billing.sandbox.receive',
      { code: 'PGRST202', message: `${secret} ${event.data.email}` }, 404); });
    const response = await handleSandboxWebhook(request(), env, receive);
    expect(response.status).toBe(503);
    expect(JSON.stringify(log.mock.calls)).toContain('billing.sandbox.receive');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(event.data.email);
    expect(await response.text()).not.toContain('PGRST202');
  });
  it('quarantines conflicting duplicates without pretending to process a payment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await handleSandboxWebhook(request(), env, async () => 'CONFLICT')).status).toBe(409);
    expect((await handleSandboxWebhook(request(), env, async () => 'PAID')).status).toBe(503);
  });
  it('ignores unrelated signed events and accepts subscription/refund wakeups without granting access', async () => {
    const receive = vi.fn(async () => 'STORED');
    expect((await handleSandboxWebhook(request(JSON.stringify({ ...event, event_type: 'product.updated',
      data: { id: 'pro_' + 'b'.repeat(26) } })), env, receive)).status).toBe(200);
    expect(receive).not.toHaveBeenCalled();
    for (const [type, prefix] of [['subscription.canceled', 'sub'], ['adjustment.created', 'adj'], ['adjustment.updated', 'adj']]) {
      expect((await handleSandboxWebhook(request(JSON.stringify({ ...event, event_type: type,
        data: { id: prefix + '_' + 'b'.repeat(26) } })), env, receive)).status).toBe(200);
    }
    expect(receive).toHaveBeenCalledTimes(3);
  });
});
