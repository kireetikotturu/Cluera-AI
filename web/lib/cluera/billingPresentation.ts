import { stagingAccountConfig } from '../accounts/workspace';
import { accountClients } from '../accounts/clients';
import { clueraBillingCatalog } from '../payments/cluera/checkout';
import type { ClueraPublicRevision } from '../payments/cluera/publicCatalog';
import { onSaleCatalog } from '../payments/cluera/purchaseAvailability';
import { billingUiEnvironment } from '../payments/cluera/billingUi';
import { liveBillingProfile, liveBillingRpc, assertBillingProfileProof } from '../payments/cluera/modeProfile';

type Plans = ClueraPublicRevision[] | null;
const FRESH_MS = 20_000, STALE_MS = 30 * 60_000;
let cached: { plans: ClueraPublicRevision[]; at: number } | null = null;
let inflight: Promise<Plans> | null = null;

async function loadPlans(): Promise<Plans> {
  if (process.env.CLUERA_BILLING_V2_ENABLED !== 'true') return null;
  try {
    const client = accountClients(stagingAccountConfig());
    const env = billingUiEnvironment(), live = liveBillingProfile(env);
    const rawRpc = (name: string, args: Record<string, unknown>) => client.service.rpc(name, args);
    if (live) {
      const proof = await rawRpc('cluera_live_billing_profile', { p_account_digest: live.merchantDigest });
      assertBillingProfileProof(live, proof.error ? null : proof.data, 'checkout', env);
    }
    return onSaleCatalog(await clueraBillingCatalog(live ? liveBillingRpc(rawRpc) : rawRpc), env);
  } catch { return null; } // An unavailable schema is not an approved historical-price fallback.
}
function refresh(): Promise<Plans> {
  inflight ??= loadPlans().then(plans => { if (plans) cached = { plans, at: Date.now() }; return plans; }).finally(() => { inflight = null; });
  return inflight;
}
/** Public projection only. No plan IDs, merchant IDs, private tester or credentials.
 * Returns exactly the plans that are On (possibly none); null only when the catalog cannot be read.
 * The list is remembered for a few seconds so pages open instantly; a stale copy is served while a
 * fresh one loads, and a failed read never replaces the last good list. */
export async function readClueraBillingPresentation(): Promise<Plans> {
  if (process.env.CLUERA_BILLING_V2_ENABLED !== 'true') return null;
  if (process.env.NODE_ENV === 'test') return loadPlans();
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < FRESH_MS) return cached.plans;
  if (cached && age < STALE_MS) { void refresh(); return cached.plans; }
  return (await refresh()) ?? cached?.plans ?? null;
}
/** Forget the remembered list (used after an Admin plan change on the same server). */
export function forgetClueraBillingPresentation(): void { cached = null; }
