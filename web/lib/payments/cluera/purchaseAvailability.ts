import { clueraNativeRecurringEnabled } from './nativeRecurring';
import { clueraCancellationEnabled } from './cancellation';
import type { ClueraPublicRevision } from './publicCatalog';

/** Catalog validation alone never approves a subscription lifecycle. A one-time
 * pack needs no provider plan, so it is always "validated"; the database Live
 * catalog does not report that flag for packs, and a false value would keep
 * every Buy button disabled. */
export function approvedPurchaseCatalog(catalog: ClueraPublicRevision[], env = process.env) {
  const monthly = clueraNativeRecurringEnabled(env) && clueraCancellationEnabled(env);
  return catalog.map(row => ({
    ...row,
    testPlanValidated: row.kind === 'PACK' || row.testPlanValidated,
    enabled: row.enabled && (row.kind === 'PACK' || monthly)
      && (row.offerCode !== 'cluera_monthly_200h_v2' || env.CLUERA_ENTERPRISE_CHECKOUT_APPROVED === 'true'),
  }));
}

/** Customer-facing list: only plans that are On. Off, archived and unapproved monthly plans never appear. */
export function onSaleCatalog(catalog: ClueraPublicRevision[], env = process.env) {
  return approvedPurchaseCatalog(catalog, env).filter(row => row.enabled);
}
