import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { usageService } from '../usage/service';
import { createUsageCoordinator } from '../usage/coordinator';
import { STAGING_DATABASE, STAGING_SITE, type RelayConfig } from './config';

const claimsSchema = z.object({ sub: z.uuid(), session_id: z.uuid(), exp: z.number().int().positive() });
export type RelayAuthorization = { remainingTokenMs: number; createRun: () => ReturnType<typeof createUsageCoordinator> };

// Auth verifies the JWT before claims are decoded. The existing RPC separately
// checks the live auth.sessions row and account suspension, including on renewal.
export async function authorizeRelay(token: string, config: RelayConfig, env = process.env): Promise<RelayAuthorization> {
  if (config.database !== STAGING_DATABASE || config.site !== STAGING_SITE) throw new Error('Account relay authorization unavailable.');
  const client = createClient(config.database, config.serviceKey, { auth: {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false,
  }, global: { fetch: (input, init) => fetch(input, { ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) } });
  const usage = usageService((name, args) => client.rpc(name, args), env);
  const reject = () => { throw new Error('Account relay authorization unavailable.'); };
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.email_confirmed_at || !data.user.email || data.user.is_anonymous) return reject();
  let claims: z.infer<typeof claimsSchema>;
  try { claims = claimsSchema.parse(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())); }
  catch { return reject(); }
  if (claims.sub !== data.user.id) return reject();
  const who = { userId: claims.sub, sessionId: claims.session_id };
  const account = await client.rpc('customer_authorize', { p_user_id: who.userId, p_session_id: who.sessionId });
  if (account.error || account.data?.code !== 'ACTIVE' || account.data.userId !== who.userId) return reject();
  const bucket = createHmac('sha256', Buffer.from(config.rateKey, 'base64'))
    .update(`account-relay-v1:${who.userId}`).digest('hex');
  const rate = await client.rpc('customer_auth_rate_limit', { p_bucket_hash: bucket, p_maximum: 30 });
  if (rate.error || rate.data !== true) return reject();
  const remainingTokenMs = Math.min(3600000, claims.exp * 1000 - Date.now());
  if (remainingTokenMs < 1000) return reject();
  return { remainingTokenMs, createRun: () => createUsageCoordinator(input => usage.command(who, input)) };
}
