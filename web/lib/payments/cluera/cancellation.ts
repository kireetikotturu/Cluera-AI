import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc, clueraBillingConfig, clueraBillingV2Enabled } from './config';
import { bindingSchema, ClueraBillingError } from './contracts';
import { cancellationInput, cancellationResult as publicResult } from './cancellationContracts';
import { clueraRazorpayAdapter } from './adapter';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { AccountError } from '../../accounts/config';
import { activeSession, assertAccountOrigin, rateLimit } from '../../accounts/handler';
import { stagingAccountConfig } from '../../accounts/workspace';
import { readClueraRawBody } from './events';
import { json } from '../../http';
import { liveBillingProfile, liveRuntimeApproved } from './modeProfile';

export { cancellationInput } from './cancellationContracts';
type Account = { userId: string; sessionId: string };
type Gateway = Pick<ReturnType<typeof clueraRazorpayAdapter>, 'cancelFuture' | 'cancellationStatus'>;

/** Separate schema/acceptance gate, never enabled by checkout or history. New
 * purchase pauses must not disable an already approved cancellation facility. */
export function clueraCancellationEnabled(env = process.env) {
  try { clueraBillingConfig(env); } catch { return false; }
  if (liveBillingProfile(env)) return clueraBillingV2Enabled(env)
    && env.CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED === 'true' && liveRuntimeApproved(env, 'intake');
  return clueraBillingV2Enabled(env) && env.CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED === 'true'
    && env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED === 'true' && env.SIGMAROUND_PAYMENT_PROVIDER === 'razorpay'
    && (!env.VERCEL_ENV || env.VERCEL_ENV === 'production')
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production')
    && (!env.VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID === 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B')
    && (!env.VERCEL_ORG_ID || env.VERCEL_ORG_ID === 'team_AksnPXhi2VBXI5UsY2xBIakc');
}
function allowed(user: string, env: NodeJS.ProcessEnv) {
  if (liveBillingProfile(env)) return clueraCancellationEnabled(env) && z.uuid().safeParse(user).success;
  const ids = (env.SIGMAROUND_PAYMENT_TESTER_IDS ?? '').split(',').map(value => value.trim());
  return clueraCancellationEnabled(env) && ids.length <= 50 && ids.every(value => z.uuid().safeParse(value).success) && ids.includes(user);
}
function ownedBinding(raw: unknown, account: Account, resource: string) {
  const binding = bindingSchema.parse(raw);
  if (binding.userId !== account.userId || binding.subscriptionId !== resource || binding.code !== 'VERIFIED'
    || binding.revision.kind !== 'RECURRING') throw new ClueraBillingError('INVALID');
  return binding;
}

/** Exactly one fresh durable claim may send POST. Replayed operations, changed
 * operation IDs and unknown outcomes only return preserved state. */
export async function cancelClueraSubscription(rpc: PaymentRpc, account: Account, raw: unknown,
  env = process.env, gateway: Gateway = clueraRazorpayAdapter(env)) {
  const input = cancellationInput.parse(raw);
  if (!allowed(account.userId, env) || input.expectedAccountId !== account.userId) throw new ClueraBillingError('CONFIGURATION');
  const { accountDigest, epoch } = await billingOwner(rpc, env);
  const args = { p_user: account.userId, p_session: account.sessionId, p_operation: input.operationId,
    p_subscription: input.subscriptionId, p_account_digest: accountDigest, p_epoch: epoch };
  const result = await billingRpc(rpc, 'cluera_billing_cancel_prepare', args);
  if ((result as { code?: unknown })?.code !== 'CLAIMED') return publicResult.parse(result);
  const claim = z.object({ code: z.literal('CLAIMED'), claimId: z.uuid(), binding: bindingSchema }).strict().parse(result);
  const binding = ownedBinding(claim.binding, account, input.subscriptionId);
  const finish = { ...args, p_claim: claim.claimId };
  try {
    const evidence = await gateway.cancelFuture(binding);
    return publicResult.parse(await billingRpc(rpc, 'cluera_billing_cancel_finish', { ...finish, p_evidence: evidence }));
  } catch {
    // A network/parse/SQL failure can follow an accepted provider command. Never
    // obtain a second lease or replay the POST, including under a new UUID.
    await billingRpc(rpc, 'cluera_billing_cancel_finish', { ...finish, p_evidence: null }).catch(() => undefined);
    return { code: 'RECORDED' as const, command: { operationId: input.operationId, subscriptionId: input.subscriptionId, state: 'UNCERTAIN' as const } };
  }
}

/** A same-owner read may independently confirm a terminal resource; it can
 * neither send a cancellation again nor change any financial entitlement. */
export async function readClueraCancellation(rpc: PaymentRpc, account: Account, operationId: string,
  env = process.env, gateway: Gateway = clueraRazorpayAdapter(env)) {
  z.uuid().parse(operationId);
  if (!allowed(account.userId, env)) throw new ClueraBillingError('CONFIGURATION');
  const { accountDigest, epoch } = await billingOwner(rpc, env);
  const args = { p_user: account.userId, p_session: account.sessionId, p_operation: operationId, p_account_digest: accountDigest, p_epoch: epoch };
  const result = z.object({ ...publicResult.shape, binding: bindingSchema }).strict().parse(await billingRpc(rpc, 'cluera_billing_cancel_read', args));
  const record = publicResult.parse({ code: result.code, command: result.command });
  if (record.command.operationId !== operationId) throw new ClueraBillingError('INVALID');
  const binding = ownedBinding(result.binding, account, record.command.subscriptionId);
  if (record.command.state === 'CONFIRMED') return record;
  try {
    const evidence = await gateway.cancellationStatus(binding);
    if (!['cancelled','completed','expired'].includes(evidence.providerState)) return record;
    return publicResult.parse(await billingRpc(rpc, 'cluera_billing_cancel_observe', { ...args, p_evidence: evidence }));
  } catch { return record; }
}

export async function handleClueraCancellation(request: Request): Promise<Response> {
  if (!clueraCancellationEnabled()) return json({ error: 'Subscription changes are unavailable.' }, 404);
  let cookies: AccountCookies | undefined;
  try {
    const config = stagingAccountConfig(), url = new URL(request.url);
    if (url.origin !== config.origin || url.pathname !== '/api/account/payments/cluera/cancellation'
      || !['GET','POST'].includes(request.method)) throw new AccountError('FORBIDDEN',403);
    if (request.method === 'POST') assertAccountOrigin(request,config.origin);
    else if (request.headers.get('sec-fetch-site') === 'cross-site'
      || (request.headers.has('origin') && request.headers.get('origin') !== config.origin)) throw new AccountError('FORBIDDEN',403);
    const query = url.searchParams;
    if (request.method === 'POST' ? query.size !== 0 : query.size !== 2 || query.getAll('expectedAccountId').length !== 1 || query.getAll('operationId').length !== 1)
      throw new AccountError('INVALID_INPUT',400);
    const clients = accountClients(config); cookies = new AccountCookies(request,config);
    const { account } = await activeSession(clients,cookies);
    if (cookies.get('recovery') === account.sessionId || !allowed(account.userId,process.env)) throw new AccountError('FORBIDDEN',403);
    await rateLimit(request,config,clients,account.email);
    const rpc: PaymentRpc = (name,args) => clients.service.rpc(name,args);
    if (request.method === 'GET') {
      if (query.get('expectedAccountId') !== account.userId) throw new AccountError('FORBIDDEN',403);
      return cookies.apply(json(await readClueraCancellation(rpc,account,z.uuid().parse(query.get('operationId')))));
    }
    if (request.headers.get('content-type')?.split(';',1)[0].trim() !== 'application/json') throw new AccountError('INVALID_INPUT',400);
    const input = cancellationInput.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readClueraRawBody(request,1024))));
    if (input.expectedAccountId !== account.userId) throw new AccountError('FORBIDDEN',403);
    return cookies.apply(json(await cancelClueraSubscription(rpc,account,input)));
  } catch (error) {
    const status = error instanceof AccountError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
    if (status === 401) cookies?.clear();
    const response = json({ error: status === 401 ? 'Sign in with a verified Cluera account.'
      : status === 429 ? 'Too many subscription requests. Please wait before checking again.'
        : 'Subscription verification is unavailable. Do not submit another cancellation; check the original request.' },status);
    return cookies ? cookies.apply(response) : response;
  }
}
