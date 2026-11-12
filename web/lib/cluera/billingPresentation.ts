import { stagingAccountConfig } from '../accounts/workspace';
import { accountClients } from '../accounts/clients';
import { clueraBillingCatalog } from '../payments/cluera/checkout';
import type { ClueraPublicRevision } from '../payments/cluera/publicCatalog';
import { onSaleCatalog } from '../payments/cluera/purchaseAvailability';
import { billingUiEnvironment } from '../payments/cluera/billingUi';
import { liveBillingProfile, liveBillingRpc, assertBillingProfileProof } from '../payments/cluera/modeProfile';

/** Public projection only. No plan IDs, merchant IDs, private tester or credentials.
 * Returns exactly the plans that are On (possibly none); null only when the catalog cannot be read. */
export async function readClueraBillingPresentation(): Promise<ClueraPublicRevision[] | null> {
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
