import { stagingAccountConfig } from '../accounts/workspace';
import { accountClients } from '../accounts/clients';
import { clueraBillingCatalog } from '../payments/cluera/checkout';
import type { ClueraPublicRevision } from '../payments/cluera/publicCatalog';
import { approvedPurchaseCatalog } from '../payments/cluera/purchaseAvailability';

/** Public projection only. No plan IDs, merchant IDs, private tester or credentials. */
export async function readClueraBillingPresentation(): Promise<ClueraPublicRevision[] | null> {
  if (process.env.CLUERA_BILLING_V2_ENABLED !== 'true') return null;
  try {
    const client = accountClients(stagingAccountConfig());
    const catalog = await clueraBillingCatalog((name, args) => client.service.rpc(name, args));
    return catalog.length === 4 ? approvedPurchaseCatalog(catalog) : null;
  } catch { return null; } // An unavailable schema is not an approved historical-price fallback.
}
