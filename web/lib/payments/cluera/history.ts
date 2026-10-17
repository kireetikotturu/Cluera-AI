import { z } from 'zod';
import { assertPaymentStaging } from '../core/config';
import type { PaymentRpc } from '../core/types';
import { billingRpc, clueraBillingV2Enabled } from './config';
import { ClueraBillingError } from './contracts';
import { clueraBillingHistorySchema } from './historyContracts';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { AccountError } from '../../accounts/config';
import { activeSession, rateLimit } from '../../accounts/handler';
import { stagingAccountConfig } from '../../accounts/workspace';
import { json } from '../../http';

/** Read-only history has a separate, default-disabled schema-readiness gate.
 * It never enables checkout, intake, scheduling or provider spending. */
export function clueraBillingHistoryEnabled(env = process.env): boolean {
  if (env.CLUERA_BILLING_HISTORY_ENABLED !== 'true' || !clueraBillingV2Enabled(env)) return false;
  try { assertPaymentStaging(env); } catch { return false; }
  return (!env.VERCEL_ENV || env.VERCEL_ENV === 'production')
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production')
    && (!env.VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID === 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B')
    && (!env.VERCEL_ORG_ID || env.VERCEL_ORG_ID === 'team_AksnPXhi2VBXI5UsY2xBIakc');
}

/** Customer GET only. The expected owner is a fence, never authorization;
 * the live BFF session and SELECT RPC independently establish ownership. */
export async function handleClueraBillingHistory(request: Request): Promise<Response> {
  let cookies: AccountCookies | undefined;
  if (request.method !== 'GET' || !clueraBillingHistoryEnabled()) return json({ error: 'Billing history is unavailable.' }, 404);
  try {
    const config = stagingAccountConfig(), url = new URL(request.url), query = url.searchParams;
    if (url.origin !== config.origin || url.pathname !== '/api/account/payments/cluera/history'
      || request.headers.get('sec-fetch-site') === 'cross-site'
      || (request.headers.has('origin') && request.headers.get('origin') !== config.origin))
      throw new AccountError('FORBIDDEN', 403);
    if (query.size !== 1 || query.getAll('expectedAccountId').length !== 1
      || !z.uuid().safeParse(query.get('expectedAccountId')).success)
      return json({ error: 'The history request could not be accepted.' }, 400);
    const clients = accountClients(config); cookies = new AccountCookies(request, config);
    const { account } = await activeSession(clients, cookies);
    if (cookies.get('recovery') === account.sessionId || query.get('expectedAccountId') !== account.userId)
      throw new AccountError('FORBIDDEN', 403);
    await rateLimit(request, config, clients, account.email);
    const history = await readClueraBillingHistory((name, args) => clients.service.rpc(name, args), account);
    return cookies.apply(json({ history }));
  } catch (error) {
    const status = error instanceof AccountError ? error.status : 503;
    if (status === 401) cookies?.clear();
    const message = status === 401 ? 'Sign in with a verified Cluera account.'
      : status === 403 ? 'This history request is not allowed.'
        : status === 429 ? 'Too many history requests. Please wait before refreshing.' : 'Billing history is unavailable. No payment action was taken.';
    const response = json({ error: message }, status);
    return cookies ? cookies.apply(response) : response;
  }
}

/** Prepared service read, not a public handler. Caller must first validate its
 * live BFF session; SQL independently checks the same user/session. Pausing
 * checkout never hides already recorded customer payment/subscription history.
 * Requires the separately reviewed history RPC proposal, which is NOT applied.
 */
export async function readClueraBillingHistory(rpc: PaymentRpc,
  account: { userId: string; sessionId: string }, env = process.env) {
  if (!clueraBillingV2Enabled(env)) throw new ClueraBillingError('CONFIGURATION');
  assertPaymentStaging(env);
  z.uuid().parse(account.userId); z.uuid().parse(account.sessionId);
  const history = clueraBillingHistorySchema.parse(await billingRpc(rpc, 'cluera_billing_history', {
    p_user: account.userId, p_session: account.sessionId,
  }));
  if (history.userId !== account.userId) throw new ClueraBillingError('UNAVAILABLE');
  return history;
}
