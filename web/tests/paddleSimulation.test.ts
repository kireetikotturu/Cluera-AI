import { describe, expect, it, vi } from 'vitest';
import { runPaddleSimulation } from './helpers/paddleSimulation';

const origin = 'https://cluera-ai-staging.vercel.app';
const secret = 'synthetic-webhook-secret-for-unit-tests';
const env = { SIGMAROUND_RUN_PADDLE_SIMULATION: 'true', PADDLE_ENVIRONMENT: 'sandbox',
  SIGMAROUND_ACCOUNT_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: 'https://dwqltsqumiwsxtkzdoaa.supabase.co',
  SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF: 'dwqltsqumiwsxtkzdoaa',
  SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED: 'true', PADDLE_API_KEY: 'synthetic-sandbox-api-key-only',
  PADDLE_WEBHOOK_SECRET: secret };
const id = (prefix: string, char = 'a') => `${prefix}_${char.repeat(26)}`;
const setting = { id: id('ntfset'), type: 'url', destination: `${origin}/api/billing/paddle/sandbox`,
  active: true, include_sensitive_fields: false, traffic_source: 'simulation', endpoint_secret_key: secret };
const event = (replay = false) => ({ id: id('ntfsimevt', replay ? 'b' : 'a'), status: 'success',
  event_type: 'transaction.completed', response: { status_code: 200 },
  request: { body: JSON.stringify({ event_id: id('ntfsimevt'), event_type: 'transaction.completed',
    notification_id: id('ntfsimntf'), occurred_at: '2026-10-04T00:00:00Z', data: { id: id('txn') } }) } });

describe('operator simulation safeguards', () => {
  it('refuses disabled, live, wrong-project or wrong-origin runs before network work', async () => {
    for (const change of [{ SIGMAROUND_RUN_PADDLE_SIMULATION: 'false' }, { PADDLE_ENVIRONMENT: 'live' },
      { SIGMAROUND_ACCOUNT_ORIGIN: 'https://production.invalid' },
      { NEXT_PUBLIC_SUPABASE_URL: 'https://bzccuqforilpifhiysjk.supabase.co' }]) {
      const request = vi.fn();
      await expect(runPaddleSimulation({ ...env, ...change }, request)).rejects.toThrow('dedicated staging');
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('never writes before exact destination, enabled simulation and matching secret checks', async () => {
    for (const change of [{ destination: 'https://production.invalid' }, { active: false },
      { traffic_source: 'platform' }, { include_sensitive_fields: true }, { endpoint_secret_key: 'different' }]) {
      const request = vi.fn(async () => Response.json({ data: [{ ...setting, ...change }] }));
      await expect(runPaddleSimulation(env, request)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(expect.stringContaining('/notification-settings?'), expect.objectContaining({ method: 'GET', redirect: 'error' }));
    }
  });
  it('redacts provider errors and refuses oversized secret-bearing responses', async () => {
    await expect(runPaddleSimulation(env, async () => Response.json({ error: { detail: secret } }, { status: 403 })))
      .rejects.toThrow('HTTP 403; no payload logged.');
    await expect(runPaddleSimulation(env, async () => new Response('x'.repeat(256 * 1024 + 1))))
      .rejects.toThrow('invalid or too large; details withheld.');
  });
  it('stops at denied simulation creation without retrying POST or creating a run', async () => {
    const lines: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/notification-settings?')
      ? Response.json({ data: [setting] })
      : Response.json({ error: { detail: secret } }, { status: 403 }));
    await expect(runPaddleSimulation(env, request, async () => {}, line => lines.push(line)))
      .rejects.toThrow('Simulation API POST returned HTTP 403; no payload logged.');
    expect(request).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toContain('destination and webhook-secret match verified');
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('Staging simulation created:');
  });
  it('uses only sandbox simulation mutations, confirms delivery and performs concurrent same-event retries', async () => {
    let replayed = false; const lines: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/notification-settings?')) return Response.json({ data: [setting] });
      if (url.endsWith('/simulations')) return Response.json({ data: { id: id('ntfsim') } }, { status: 201 });
      if (url.endsWith('/runs')) return Response.json({ data: { id: id('ntfsimrun') } }, { status: 201 });
      if (url.endsWith('/replay')) { replayed = true; return Response.json({ data: { id: id('ntfsimevt', 'b') } }, { status: 202 }); }
      if (url.endsWith('?include=events')) return Response.json({ data: { events: replayed ? [event(), event(true)] : [event()] } });
      expect(url).toBe(`${origin}/api/billing/paddle/sandbox`);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return Response.json({ received: true });
    });
    const result = await runPaddleSimulation(env, request, async () => {}, line => lines.push(line));
    expect(result.eventId).toBe(id('ntfsimevt'));
    expect(result.replayEventId).toBe(id('ntfsimevt'));
    const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(5); // Create simulation, run, replay, two same-event deliveries.
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(env.PADDLE_API_KEY);
    expect(lines.join('\n')).not.toContain('notification_id');
  });
  it('does not confuse a completed run with a successfully delivered event', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/notification-settings?')) return Response.json({ data: [setting] });
      if (url.endsWith('/simulations')) return Response.json({ data: { id: id('ntfsim') } });
      if (url.endsWith('/runs')) return Response.json({ data: { id: id('ntfsimrun') } });
      return Response.json({ data: { status: 'completed', events: [{ ...event(), status: 'failed', response: { status_code: 400, body: secret } }] } });
    });
    await expect(runPaddleSimulation(env, request, async () => {}, () => {})).rejects.toThrow('delivery failed (HTTP 400); payload withheld.');
    expect(request).toHaveBeenCalledTimes(4);
  });
});
