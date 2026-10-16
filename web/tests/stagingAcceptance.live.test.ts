import { createHmac, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { accountConfig } from '../lib/accounts/config';
import { sandboxOffers, verifySandboxOffer } from '../lib/billing/sandboxCatalog';

// Explicit operator-only acceptance run. Never run against arbitrary env URLs.
// Inject staging env into this process; never pull secrets into a file or log them.
const enabled = process.env.SIGMAROUND_RUN_STAGING_ACCEPTANCE === 'true';
const origin = 'https://cluera-ai-staging.vercel.app';
const database = 'https://yhnqlfcgrmckhyjdxegg.supabase.co';
function assertStaging() {
  if (process.env.SIGMAROUND_ACCOUNT_ORIGIN !== origin
    || process.env.NEXT_PUBLIC_SUPABASE_URL !== database
    || process.env.PADDLE_ENVIRONMENT !== 'sandbox'
    || process.env.SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF !== 'yhnqlfcgrmckhyjdxegg') {
    throw new Error('Refusing acceptance checks outside the dedicated staging targets.');
  }
}
async function postEvent(raw: string, timestamp = Math.floor(Date.now() / 1000), invalid = false) {
  assertStaging();
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret || secret.length < 20) throw new Error('Staging webhook credential unavailable to the private test process.');
  const signature = createHmac('sha256', secret).update(`${timestamp}:${raw}`).digest('hex');
  try {
    const response = await fetch(`${origin}/api/billing/paddle/sandbox`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'Paddle-Signature': `ts=${timestamp};h1=${invalid ? '0'.repeat(64) : signature}` },
      body: raw,
    });
    await response.body?.cancel();
    return response.status;
  } catch { throw new Error('Staging webhook transport failed; details withheld.'); }
}

describe.skipIf(!enabled)('operator-only dedicated staging acceptance', () => {
  beforeAll(() => {
    assertStaging();
    if (!process.env.PADDLE_API_KEY || process.env.PADDLE_API_KEY.length < 20
      || !process.env.PADDLE_WEBHOOK_SECRET || process.env.PADDLE_WEBHOOK_SECRET.length < 20) {
      throw new Error('Private staging credentials unavailable; no live checks were attempted.');
    }
  });
  it('uses the exact staging origins and valid private account configuration', () => {
    assertStaging();
    let valid = false;
    try {
      const config = accountConfig();
      valid = config.secure && !config.cookieKey.equals(config.rateKey);
    } catch { /* Never print config or validation input. */ }
    expect(valid, 'Private staging account configuration unavailable/invalid.').toBe(true);
  });
  for (const offer of sandboxOffers) {
    it(`verifies the real sandbox price for ${offer.code}`, async () => {
      assertStaging();
      let verified = false;
      const diagnosticFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        // Status is a bounded integer. Never log headers, URLs, response errors or payloads.
        console.info(`Sandbox catalog ${offer.code}: HTTP ${response.status}`);
        if (response.status === 403) {
          // Read-only permission diagnosis, NOT a fallback for catalog validation.
          const bare = await fetch(`https://sandbox-api.paddle.com/prices/${offer.priceId}`, init);
          console.info(`Sandbox price-only ${offer.code}: HTTP ${bare.status}`);
          await bare.body?.cancel();
        }
        return response;
      };
      try { verified = (await verifySandboxOffer(offer.code, process.env, diagnosticFetch)).priceId === offer.priceId; }
      catch { /* Provider error/payload/credentials must not enter test output. */ }
      expect(verified, `Catalog validation or API access failed for ${offer.code}; no raw provider output logged.`).toBe(true);
    }, 15000);
  }
  it('can inspect the existing sandbox simulation destination without exposing its secret', async () => {
    assertStaging();
    const response = await fetch('https://sandbox-api.paddle.com/notification-settings?per_page=200', {
      headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, 'Paddle-Version': '1' },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    }).catch(() => { throw new Error('Sandbox notification-settings transport failed; details withheld.'); });
    const status = response.status;
    if (status !== 200) {
      await response.body?.cancel();
      throw new Error(`Sandbox notification-settings HTTP ${status}; API permission notification_setting.read required.`);
    }
    // The response contains endpoint_secret_key. Bound it in memory and emit only
    // booleans/counts, never raw settings, secrets, headers or provider errors.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Sandbox notification-settings response missing.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > 256 * 1024) throw new Error('Sandbox notification-settings response exceeds diagnostic limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let valid = false;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const matching = Array.isArray(parsed.data) ? parsed.data.filter((entry: Record<string, unknown>) =>
        entry.type === 'url' && entry.destination === `${origin}/api/billing/paddle/sandbox`) : [];
      valid = matching.length === 1 && matching[0].active === true
        && ['all', 'simulation'].includes(matching[0].traffic_source)
        && matching[0].include_sensitive_fields === false;
    } catch { /* No raw payload or parsing error may enter the test reporter. */ }
    expect(valid, 'One active, non-sensitive, simulation-enabled staging destination is required.').toBe(true);
  }, 15000);
  it('rejects invalid/stale/future signatures, deduplicates delivery and quarantines conflicts', async () => {
    assertStaging();
    if (process.env.SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED !== 'true') throw new Error('Staging intake is not enabled.');
    const suffix = randomBytes(13).toString('hex');
    const event = { event_id: `evt_${suffix}`, event_type: 'transaction.completed',
      occurred_at: new Date().toISOString(), notification_id: `ntf_${suffix}`,
      data: { id: `txn_${suffix}`, status: 'completed', custom_data: { acceptance: 'sigmaround-synthetic-intake-only' } } };
    const raw = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);
    expect(await postEvent(raw, now, true)).toBe(400);
    expect(await postEvent(raw, now - 120)).toBe(400);
    expect(await postEvent(raw, now + 120)).toBe(400);
    expect(await postEvent(raw)).toBe(200);
    expect(await postEvent(raw)).toBe(200);
    expect(await postEvent(JSON.stringify({ ...event, notification_id: `ntf_${randomBytes(13).toString('hex')}` }))).toBe(200);
    expect(await postEvent(JSON.stringify({ ...event, data: { ...event.data, status: 'changed-synthetic-fixture' } }))).toBe(409);
    // Public synthetic ID only, allowing narrow DB verification. Not a real Paddle event/payment.
    console.info(`Synthetic staging acceptance event: ${event.event_id}`);
  }, 90000);
});
