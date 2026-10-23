import { z } from 'zod';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { AccountError } from '../../accounts/config';
import { activeSession, assertAccountOrigin, rateLimit } from '../../accounts/handler';
import { stagingAccountConfig } from '../../accounts/workspace';
import { json } from '../../http';
import { createLiveBillingScope, liveBillingProfile, liveBillingRpc, assertBillingProfileProof, liveRuntimeApproved } from './modeProfile';
import { billingOwner, clueraCheckoutAllowed } from './config';
import { callbackSchema, clueraBillingCatalog, clueraBillingStatus, createClueraCheckout, verifyClueraCallback } from './checkout';
import { readClueraRawBody } from './events';
import { approvedPurchaseCatalog } from './purchaseAvailability';
import { readClueraBillingHistory } from './history';
import { resumeClueraCheckout } from './checkoutResume';
import { cancellationInput, cancelClueraSubscription, readClueraCancellation } from './cancellation';
import { ClueraBillingError } from './contracts';

export type LiveBillingAction = 'catalog' | 'checkout' | 'callback' | 'resume' | 'history' | 'cancellation';
/** Separate Live routes; the existing Test receipt destination stays Test.
 * Server identities and an independently read mode/merchant/ledger proof are
 * required. Nothing in a URL, browser body or public catalog enables charging. */
export async function handleLiveBilling(request: Request, action: LiveBillingAction, input = process.env): Promise<Response> {
  if (input.CLUERA_LIVE_OWNER_APPROVED !== 'true' || input.CLUERA_LIVE_RUNTIME_ACCEPTED !== 'true')
    return json({ error: 'Not found.' }, 404);
  let cookies: AccountCookies | undefined;
  try {
    const env = createLiveBillingScope(input), profile = liveBillingProfile(env)!;
    const url = new URL(request.url);
    if (url.origin !== profile.origin || url.pathname !== `/api/account/payments/cluera/live/${action}`
      || !['GET', 'POST'].includes(request.method)) return json({ error: 'Not found.' }, 404);
    if (request.method === 'POST' && !['checkout', 'callback', 'cancellation'].includes(action)
      || request.method === 'GET' && action === 'callback') return json({ error: 'Not found.' }, 404);
    const config = stagingAccountConfig();
    // Initial Live launch uses the existing staging origin. A future origin
    // requires the corresponding reviewed Auth/cookie redirect deployment.
    if (config.origin !== profile.origin) throw new AccountError('UNAVAILABLE', 503);
    if (request.method === 'POST') assertAccountOrigin(request, config.origin);
    else if (request.headers.get('sec-fetch-site') === 'cross-site'
      || request.headers.has('origin') && request.headers.get('origin') !== config.origin) throw new AccountError('FORBIDDEN', 403);
    const clients = accountClients(config), rpc = liveBillingRpc((name, args) => clients.service.rpc(name, args));
    if (action === 'catalog') {
      if (url.searchParams.size) return json({ error: 'Invalid request.' }, 400);
      const proof = await clients.service.rpc('cluera_live_billing_profile', { p_account_digest: profile.merchantDigest });
      assertBillingProfileProof(profile, proof.error ? null : proof.data, 'checkout', env);
      return json({ catalog: approvedPurchaseCatalog(await clueraBillingCatalog(rpc), env) });
    }
    if (!liveRuntimeApproved(env, 'intake')) return json({ error: 'Not found.' }, 404);
    cookies = new AccountCookies(request, config);
    const { account } = await activeSession(clients, cookies);
    if (cookies.get('recovery') === account.sessionId) return cookies.apply(json({ code: 'RECOVERY_SESSION', error: 'Finish password recovery and sign in before checkout.' }, 403));
    await rateLimit(request, config, clients, account.email);
    await billingOwner(rpc, env);
    if (request.method === 'GET') {
      const keys = action === 'cancellation' ? ['expectedAccountId', 'operationId'] : ['expectedAccountId'];
      if (url.searchParams.size !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1)
        || url.searchParams.get('expectedAccountId') !== account.userId) return cookies.apply(json({ code: 'ACCOUNT_MISMATCH', error: 'Account does not match.' }, 403));
      if (action === 'history') return cookies.apply(json({ history: await readClueraBillingHistory(rpc, account, env) }));
      if (action === 'cancellation') return cookies.apply(json(await readClueraCancellation(rpc, account,
        z.uuid().parse(url.searchParams.get('operationId')), env)));
      if (!liveRuntimeApproved(env, 'checkout')) return cookies.apply(json({ code: 'CHECKOUT_DISABLED', error: 'New purchases are currently unavailable.' }, 404));
      if (!clueraCheckoutAllowed(account.userId, env)) return cookies.apply(json({ code: 'LIVE_PURCHASER_REQUIRED', error: 'Public sales are not open for this account.' }, 403));
      const payment = action === 'resume' ? await resumeClueraCheckout(rpc, account, env) : await clueraBillingStatus(rpc, account);
      return cookies.apply(json({ payment }));
    }
    if (url.searchParams.size || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      throw new AccountError('INVALID_INPUT', 400);
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readClueraRawBody(request, 2048)));
    if (raw?.expectedAccountId !== account.userId) return cookies.apply(json({ code: 'ACCOUNT_MISMATCH', error: 'Account does not match.' }, 403));
    if (action === 'cancellation') return cookies.apply(json(await cancelClueraSubscription(rpc, account, cancellationInput.parse(raw), env)));
    if (!liveRuntimeApproved(env, 'checkout')) return cookies.apply(json({ code: 'CHECKOUT_DISABLED', error: 'New purchases are currently unavailable.' }, 404));
    if (!clueraCheckoutAllowed(account.userId, env)) return cookies.apply(json({ code: 'LIVE_PURCHASER_REQUIRED', error: 'Public sales are not open for this account.' }, 403));
    const payment = action === 'callback' ? await verifyClueraCallback(rpc, account, callbackSchema.parse(raw), env)
      : await (async () => {
        const body = z.object({ expectedAccountId: z.uuid(), requestId: z.uuid(), revisionId: z.uuid() }).strict().parse(raw);
        return createClueraCheckout(rpc, account, body.requestId, body.revisionId, env);
      })();
    return cookies.apply(json({ payment }, payment.code === 'PENDING' ? 409 : 200));
  } catch (error) {
    const status = error instanceof AccountError ? error.status : error instanceof ClueraBillingError && error.code === 'PENDING' ? 409
      : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
    if (status === 401) cookies?.clear();
    const response = json({ error: status === 401 ? 'Sign in with a verified email.'
      : status === 429 ? 'Too many requests. Wait before checking the existing payment.'
        : 'Billing is unavailable. Do not repeat a payment.' }, status);
    if (status === 429) response.headers.set('Retry-After', '60');
    return cookies ? cookies.apply(response) : response;
  }
}
