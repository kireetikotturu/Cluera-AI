import { createLiveBillingScope } from './modeProfile';
import { clueraCheckoutEnabled } from './config';
import { clueraBillingHistoryEnabled } from './history';
import { clueraCancellationEnabled } from './cancellation';
import { checkoutWindowSeconds } from './checkoutWindow';

export function billingUiEnvironment(input = process.env) {
  if (input.CLUERA_BILLING_UI_MODE === 'live') return createLiveBillingScope(input);
  if (input.CLUERA_BILLING_UI_MODE && input.CLUERA_BILLING_UI_MODE !== 'test') throw Error('Billing mode is unavailable.');
  return input;
}
/** Browser-safe capabilities only. Never pass the environment/profile to React. */
export function billingUiCapabilities(input = process.env) {
  const mode = input.CLUERA_BILLING_UI_MODE === 'live' ? 'live' as const : 'test' as const;
  try {
    const env = billingUiEnvironment(input);
    return { mode, enabled: clueraCheckoutEnabled(env), checkoutWindowSeconds: checkoutWindowSeconds(input.CLUERA_CHECKOUT_WINDOW_SECONDS),
      historyEnabled: mode === 'live' ? env.CLUERA_LIVE_HISTORY_ENABLED === 'true' : clueraBillingHistoryEnabled(env),
      cancellationEnabled: clueraCancellationEnabled(env) };
  } catch { return { mode, enabled: false, historyEnabled: false, cancellationEnabled: false, checkoutWindowSeconds: 600 }; }
}
