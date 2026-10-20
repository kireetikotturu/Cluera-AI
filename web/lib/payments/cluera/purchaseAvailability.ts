import { clueraNativeRecurringEnabled } from './nativeRecurring';
import { clueraCancellationEnabled } from './cancellation';
import type { ClueraPublicRevision } from './publicCatalog';

/** Catalog validation alone never approves a subscription lifecycle. */
export function approvedPurchaseCatalog(catalog: ClueraPublicRevision[], env = process.env) {
  const monthly = clueraNativeRecurringEnabled(env) && clueraCancellationEnabled(env);
  return catalog.map(row => ({
    ...row,
    enabled: row.enabled && (row.kind === 'PACK' || monthly)
      && (row.offerCode !== 'cluera_monthly_200h_v2' || env.CLUERA_ENTERPRISE_CHECKOUT_APPROVED === 'true'),
  }));
}
