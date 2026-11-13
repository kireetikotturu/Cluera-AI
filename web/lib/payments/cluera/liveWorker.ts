import { createClient } from '@supabase/supabase-js';
import { json } from '../../http';
import { createLiveBillingScope, liveBillingProfile, liveBillingRpc, assertBillingProfileProof } from './modeProfile';
import { handleClueraWebhook } from './events';
import { handleClueraBillingTick } from './scheduler';
import type { PaymentRpc } from '../core/types';

const configured = (env: NodeJS.ProcessEnv) => env.CLUERA_LIVE_OWNER_APPROVED === 'true'
  && env.CLUERA_LIVE_RUNTIME_ACCEPTED === 'true' && env.CLUERA_LIVE_INTAKE_ENABLED === 'true';
export async function handleLiveWebhook(request: Request, input = process.env, injectedRpc?: PaymentRpc, onStored?: () => void) {
  if (!configured(input)) return json({ error: 'Not found.' }, 404);
  try {
    const env = createLiveBillingScope(input), profile = liveBillingProfile(env)!;
    if (request.url !== profile.webhookUrl || request.headers.has('cookie') || request.headers.has('authorization')
      || request.headers.has('origin')) return json({ error: 'Invalid request.' }, 400);
    const service = injectedRpc ? null : createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) }) },
    });
    const rawRpc: PaymentRpc = injectedRpc ?? ((name, args) => service!.rpc(name, args));
    const scoped = liveBillingRpc(rawRpc);
    // The common receiver verifies raw HMAC and merchant before calling here.
    const admitted: PaymentRpc = async (name, args) => {
      const proof = await rawRpc('cluera_live_billing_profile', { p_account_digest: profile.merchantDigest });
      assertBillingProfileProof(profile, proof.error ? null : proof.data, 'intake', env);
      return scoped(name, args);
    };
    return handleClueraWebhook(request, env, admitted, onStored);
  } catch { return json({ error: 'Webhook intake is unavailable.' }, 503); }
}
export async function handleLiveTick(request: Request, input = process.env,
  deps: Parameters<typeof handleClueraBillingTick>[2] = {}) {
  if (!configured(input)) return json({ error: 'Not found.' }, 404);
  try { return await handleClueraBillingTick(request, createLiveBillingScope(input), deps); }
  catch { return json({ error: 'Worker unavailable.' }, 503); }
}
