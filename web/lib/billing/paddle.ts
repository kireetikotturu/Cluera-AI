import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export class PaddleBoundaryError extends Error {
  constructor() { super('Paddle sandbox request could not be verified.'); }
}
/** Verify the exact raw bytes before JSON parsing. No secrets or payload in errors. */
export function verifyPaddleSignature(raw: Uint8Array, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (!header || header.length > 1024 || raw.byteLength > 256 * 1024 || secret.length < 20) throw new PaddleBoundaryError();
  const fields = header.split(';').map(part => part.trim().split('='));
  if (fields.some(parts => parts.length !== 2 || !['ts', 'h1'].includes(parts[0]))) throw new PaddleBoundaryError();
  const timestamps = fields.filter(([key]) => key === 'ts').map(([, value]) => value);
  const signatures = fields.filter(([key]) => key === 'h1').map(([, value]) => value);
  if (timestamps.length !== 1 || !/^\d{10}$/.test(timestamps[0]) || signatures.length < 1 || signatures.length > 5
    || signatures.some(value => !/^[a-f0-9]{64}$/.test(value)) || !Number.isSafeInteger(nowSeconds)
    || Math.abs(Number(timestamps[0]) - nowSeconds) > 5) throw new PaddleBoundaryError();
  const expected = createHmac('sha256', secret).update(`${timestamps[0]}:`).update(raw).digest();
  if (!signatures.some(value => timingSafeEqual(Buffer.from(value, 'hex'), expected))) throw new PaddleBoundaryError();
}

const transaction = z.object({
  id: z.string().regex(/^txn_[a-z0-9]{26}$/),
  status: z.enum(['draft', 'ready', 'billed', 'paid', 'completed', 'canceled', 'past_due']),
  customer_id: z.string().nullable(), subscription_id: z.string().nullable(),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
});
export type PaddleTransaction = z.infer<typeof transaction>;

/** Only these read-only sandbox resources are allowed; no caller-supplied host/path. */
export async function readSandboxResource(kind: 'transactions' | 'prices' | 'customers' | 'subscriptions' | 'adjustments', id: string,
  env = process.env, request: typeof fetch = fetch): Promise<unknown> {
  const pattern = {transactions:/^txn_[a-z0-9]{26}$/,prices:/^pri_[a-z0-9]{26}$/,
    customers:/^ctm_[a-z0-9]{26}$/,subscriptions:/^sub_[a-z0-9]{26}$/,adjustments:/^adj_[a-z0-9]{26}$/}[kind];
  if (env.PADDLE_ENVIRONMENT !== 'sandbox' || !env.PADDLE_API_KEY || env.PADDLE_API_KEY.length < 20
    || !pattern?.test(id)) throw new PaddleBoundaryError();
  try {
    const response = await request(`https://sandbox-api.paddle.com/${kind}/${id}${kind === 'prices' ? '?include=product' : ''}`, {
      headers: { Authorization: `Bearer ${env.PADDLE_API_KEY}`, 'Paddle-Version': '1', Accept: 'application/json' },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new PaddleBoundaryError(); }
    const reader = response.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength; if (total > 256 * 1024) throw new PaddleBoundaryError(); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).data;
  } catch { throw new PaddleBoundaryError(); }
}

/** Server-only sandbox boundary. Intentionally no live payment creation or entitlement writes. */
export async function readSandboxTransaction(id: string, env = process.env, request: typeof fetch = fetch): Promise<PaddleTransaction> {
  try {
    const parsed = transaction.parse(await readSandboxResource('transactions', id, env, request));
    if (parsed.id !== id) throw new PaddleBoundaryError();
    return parsed; // Drops all unneeded billing/customer fields, never forwards raw API responses.
  } catch { throw new PaddleBoundaryError(); }
}
