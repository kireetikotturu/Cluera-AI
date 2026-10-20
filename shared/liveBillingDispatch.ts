import { createHash, createHmac, randomUUID } from 'node:crypto';

const bodyDigest = createHash('sha256').update('{}').digest('hex');
export function liveWorkerMessage(origin: string, epoch: number, seconds: number, nonce: string, merchantDigest: string) {
  return ['CLUERA-BILLING-LIVE-TICK', 'POST', `${origin}/api/internal/billing/cluera/live/tick`,
    epoch, seconds, nonce, merchantDigest, bodyDigest].join('\n');
}
/** The dispatcher needs a dedicated signer, never merchant API credentials.
 * The receiver independently validates its database profile, epoch and nonce. */
export function liveDispatchConfig(env: Record<string, string | undefined>) {
  if (env.CLUERA_LIVE_SCHEDULER_ENABLED !== 'true') return null;
  const origin = env.CLUERA_LIVE_ACCOUNT_ORIGIN ?? '', secret = env.CLUERA_LIVE_WORKER_SECRET ?? '';
  const digest = env.CLUERA_LIVE_MERCHANT_DIGEST ?? '', epoch = Number(env.CLUERA_LIVE_WORKER_EPOCH);
  let url: URL;
  try { url = new URL(origin); } catch { throw Error('LIVE_DISPATCH_CONFIGURATION'); }
  if (env.CLUERA_LIVE_OWNER_APPROVED !== 'true' || env.CLUERA_LIVE_RUNTIME_ACCEPTED !== 'true'
    || env.NEXT_PUBLIC_SUPABASE_URL !== 'https://yhnqlfcgrmckhyjdxegg.supabase.co'
    || origin !== env.CLUERA_LIVE_APPROVED_ORIGIN || url.origin !== origin || url.protocol !== 'https:'
    || url.port || url.username || url.password || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname)
    || /(^|\.)(localhost|local|invalid|internal|test)$/.test(url.hostname)
    || !/^[1-9][0-9]{0,15}$/.test(env.CLUERA_LIVE_WORKER_EPOCH ?? '') || !Number.isSafeInteger(epoch)
    || !/^[a-f0-9]{64}$/.test(digest) || secret.length < 32 || secret.length > 256
    || secret.trim() !== secret || /[\x00-\x1f\x7f]/.test(secret)
    || [env.SIGMAROUND_BILLING_WORKER_SECRET, env.SUPABASE_SERVICE_ROLE_KEY,
      env.RAZORPAY_LIVE_KEY_SECRET, env.RAZORPAY_LIVE_WEBHOOK_SECRET].includes(secret))
    throw Error('LIVE_DISPATCH_CONFIGURATION');
  return { origin, secret, digest, epoch };
}
export function liveDispatchHeaders(config: NonNullable<ReturnType<typeof liveDispatchConfig>>, now = Date.now()) {
  const seconds = Math.floor(now / 1000), nonce = randomUUID();
  return { 'Content-Type': 'application/json', 'x-cluera-billing-time': String(seconds),
    'x-cluera-billing-nonce': nonce, 'x-cluera-billing-epoch': String(config.epoch),
    'x-cluera-billing-proof': createHmac('sha256', config.secret)
      .update(liveWorkerMessage(config.origin, config.epoch, seconds, nonce, config.digest)).digest('hex') };
}
