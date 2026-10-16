import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const origin = 'https://cluera-ai-staging.vercel.app';
const sandbox = 'https://sandbox-api.paddle.com';
const destination = `${origin}/api/billing/paddle/sandbox`;
type Json = Record<string, any>;

/** Operator-only test helper. Never imported by the application or a public route. */
export async function runPaddleSimulation(env = process.env, request: typeof fetch = fetch,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  report: (line: string) => void = line => console.info(line)) {
  if (env.SIGMAROUND_RUN_PADDLE_SIMULATION !== 'true' || env.PADDLE_ENVIRONMENT !== 'sandbox'
    || env.SIGMAROUND_ACCOUNT_ORIGIN !== origin
    || env.NEXT_PUBLIC_SUPABASE_URL !== 'https://yhnqlfcgrmckhyjdxegg.supabase.co'
    || env.SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF !== 'yhnqlfcgrmckhyjdxegg'
    || env.SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED !== 'true'
    || !env.PADDLE_API_KEY || env.PADDLE_API_KEY.length < 20
    || !env.PADDLE_WEBHOOK_SECRET || env.PADDLE_WEBHOOK_SECRET.length < 20) {
    throw new Error('Simulation requires explicit dedicated staging configuration.');
  }
  const identifier = (value: unknown, prefix: string): string => {
    if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value)) {
      throw new Error('Simulation API returned an invalid identifier.');
    }
    return value;
  };
  const json = async (response: Response): Promise<Json> => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Simulation response missing.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('Simulation response invalid or too large; details withheld.'); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  };
  const api = async (path: string, method = 'GET', body?: Json): Promise<Json> => {
    let response: Response;
    try {
      response = await request(`${sandbox}${path}`, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}`, 'Paddle-Version': '1', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('Simulation API transport failed; details withheld.'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Simulation API ${method} returned HTTP ${response.status}; no payload logged.`);
    }
    return json(response);
  };
  const settings = await api('/notification-settings?per_page=200');
  const matches = Array.isArray(settings.data) ? settings.data.filter((entry: Json) =>
    entry?.type === 'url' && entry.destination === destination) : [];
  if (matches.length !== 1 || !matches[0].active || matches[0].include_sensitive_fields !== false
    || !['simulation', 'all'].includes(matches[0].traffic_source)) {
    throw new Error('One active non-sensitive simulation-enabled staging destination is required.');
  }
  const selected = matches[0];
  const settingId = identifier(selected.id, 'ntfset');
  if (typeof selected.endpoint_secret_key !== 'string' || !timingSafeEqual(
    createHash('sha256').update(selected.endpoint_secret_key).digest(),
    createHash('sha256').update(env.PADDLE_WEBHOOK_SECRET).digest())) {
    throw new Error('Staging destination and configured webhook secret do not match.');
  }
  report('Staging simulation destination and webhook-secret match verified.');
  // Mutations are simulations only. No customer, transaction, subscription,
  // destination, payment or entitlement is created/changed. POST is never retried.
  report('Creating sandbox simulation (requires notification_simulation.write).');
  const simulation = await api('/simulations', 'POST', {
    notification_setting_id: settingId, name: 'SigmaRound staging intake acceptance',
    type: 'transaction.completed',
  });
  const simulationId = identifier(simulation.data?.id, 'ntfsim');
  report(`Staging simulation created: ${simulationId}`);
  const run = await api(`/simulations/${simulationId}/runs`, 'POST');
  const runId = identifier(run.data?.id, 'ntfsimrun');
  report(`Staging simulation run: ${runId}`);
  const runPath = `/simulations/${simulationId}/runs/${runId}`;
  const delivery = async (eventLogId?: string): Promise<Json> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await api(`${runPath}?include=events`);
      const events = Array.isArray(result.data?.events) ? result.data.events : [];
      const event = eventLogId ? events.find((item: Json) => item.id === eventLogId) : events[0];
      if (event && ['failed', 'aborted'].includes(event.status)) {
        const code = Number.isInteger(event.response?.status_code) ? event.response.status_code : 0;
        throw new Error(`Paddle-generated simulation delivery failed (HTTP ${code}); payload withheld.`);
      }
      if (event?.status === 'success') {
        if (event.response?.status_code !== 200 || event.event_type !== 'transaction.completed') {
          throw new Error('Unexpected simulation delivery result.');
        }
        return event;
      }
      if (attempt < 11) await pause(2000); // Bounded acceptance wait only; no application polling.
    }
    throw new Error('Simulation delivery did not complete within the acceptance deadline.');
  };
  const first = await delivery();
  const logId = identifier(first.id, 'ntfsimevt');
  const envelope = (event: Json) => {
    try {
      const body = JSON.parse(event.request.body);
      identifier(body.event_id, 'ntfsimevt');
      if (body.event_type !== 'transaction.completed') throw new Error();
      return body;
    } catch { throw new Error('Simulation event envelope unavailable; details withheld.'); }
  };
  const firstEnvelope = envelope(first);
  report(`Paddle-generated event delivered: ${firstEnvelope.event_id}; HTTP 200`);
  const replay = await api(`${runPath}/events/${logId}/replay`, 'POST');
  const replayLogId = identifier(replay.data?.id, 'ntfsimevt');
  const second = await delivery(replayLogId);
  const replayEnvelope = envelope(second);
  report(`Paddle replay delivered: ${replayEnvelope.event_id}; HTTP 200; same event: ${firstEnvelope.event_id === replayEnvelope.event_id}`);

  // If Paddle's simulator generates another event on replay, explicitly test
  // same-event re-delivery without pretending distinct events prove deduplication.
  const raw = first.request.body as string;
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', env.PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
  const retries = await Promise.all([1, 2].map(async () => {
    try {
      const response = await request(destination, { method: 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json',
          'Paddle-Signature': `ts=${ts};h1=${signature}` }, body: raw });
      await response.body?.cancel(); return response.status;
    } catch { throw new Error('Concurrent same-event retry transport failed; details withheld.'); }
  }));
  if (retries.some(status => status !== 200)) throw new Error('Same-event retry did not return HTTP 200.');
  report(`Concurrent same-event retries: ${firstEnvelope.event_id}; HTTP 200/200`);
  return { simulationId, runId, eventId: firstEnvelope.event_id as string,
    replayEventId: replayEnvelope.event_id as string };
}
