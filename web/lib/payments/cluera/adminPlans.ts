import { z } from 'zod';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { AccountError } from '../../accounts/config';
import { activeSession, assertAccountOrigin, rateLimit } from '../../accounts/handler';
import { stagingAccountConfig } from '../../accounts/workspace';
import { json } from '../../http';
import { billingRpc, clueraBillingV2Enabled } from './config';
import { readClueraRawBody } from './events';
import { liveBillingProfile, liveBillingRpc } from './modeProfile';

import { adminPlanSchema, adminPlanHistorySchema } from './adminPlans.contracts';

export { adminPlanSchema, type AdminPlan } from './adminPlans.contracts';
const plansList = z.array(adminPlanSchema).max(200), historyList = z.array(adminPlanHistorySchema).max(20);

const money = z.number().int().min(100).max(10_000_000), seconds = z.number().int().min(60).max(3_600_000);
const name = z.string().trim().min(2).max(80);
const common = { operationId: z.uuid(), reason: z.string().trim().max(400).optional() };
const target = { planId: z.uuid(), expectedRevisionId: z.uuid() };
/** No authenticator code is accepted here by design: the existing MFA Admin session is the credential. */
export const planChangeSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('CREATE'), input: z.object({ name, amountPaise: money, allowanceSeconds: seconds, enabled: z.boolean() }).strict() }).strict(),
  z.object({ ...common, ...target, action: z.literal('EDIT'), input: z.object({ name, amountPaise: money, allowanceSeconds: seconds }).strict() }).strict(),
  z.object({ ...common, ...target, action: z.literal('SET_ENABLED'), input: z.object({ enabled: z.boolean() }).strict() }).strict(),
  z.object({ ...common, ...target, action: z.literal('ARCHIVE'), input: z.object({}).strict() }).strict(),
  z.object({ ...common, ...target, action: z.literal('RESTORE'), input: z.object({}).strict() }).strict(),
]);
export type PlanChange = z.infer<typeof planChangeSchema>;

/** Plain-English refusal reasons. The database decides; this only translates. */
const refusals: Record<string, [number, string]> = {
  CONFLICT: [409, 'This plan was changed in another window. Press Refresh and try again.'],
  NOT_FOUND: [404, 'That plan no longer exists. Press Refresh.'],
  DUPLICATE_NAME: [409, 'Another plan already has that name. Choose a different name.'],
  TOO_MANY_PLANS: [409, 'You already have the maximum number of plans. Remove one you no longer sell first.'],
  ARCHIVED: [409, 'This plan was removed. Restore it first.'],
  NO_CHANGE: [409, 'Nothing was changed.'],
  INVALID: [400, 'Please check the name, price and hours and try again.'],
  FORBIDDEN: [403, 'Sign in as Admin with your authenticator first.'],
};
function claims(token: string) { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } }

/** Admin-only plan list and changes for the Live ledger. Server-side authorization on EVERY call:
 * origin, verified session, aal2 token, database Admin check, rate limit, then the database re-checks. */
export async function clueraPlanAdminRequest(request: Request, env: NodeJS.ProcessEnv): Promise<Response> {
  let cookies: AccountCookies | undefined;
  // After the request is validated and sent, ANY failure is a service/unknown outcome (never a "please correct your input" refusal).
  let sent = false;
  try {
    const config = stagingAccountConfig(), live = liveBillingProfile(env);
    if (!live || env.CLUERA_LIVE_ADMIN_ENABLED !== 'true' || live.origin !== config.origin) return json({ error: 'Not found.' }, 404);
    if (!clueraBillingV2Enabled(env)) return json({ code: 'UNAVAILABLE', message: 'Billing is not switched on yet.' }, 503);
    if (request.method === 'POST') assertAccountOrigin(request, config.origin);
    else if (request.method !== 'GET' || request.headers.get('sec-fetch-site') === 'cross-site'
      || (request.headers.has('origin') && request.headers.get('origin') !== config.origin)) throw new AccountError('FORBIDDEN', 403);
    const clients = accountClients(config); cookies = new AccountCookies(request, config);
    const { account, session } = await activeSession(clients, cookies);
    if (cookies.get('recovery') === account.sessionId) throw new AccountError('FORBIDDEN', 403);
    const rawRpc = (rpcName: string, args: Record<string, unknown>) => clients.service.rpc(rpcName, args);
    const rpc = liveBillingRpc(rawRpc), admin = { p_actor: account.userId, p_session: account.sessionId };
    if (claims(session.access_token).aal !== 'aal2' || await billingRpc(rawRpc, 'account_admin_check', { ...admin, p_require_mfa: true }) !== true)
      throw new AccountError('FORBIDDEN', 403);
    await rateLimit(request, config, clients, account.email);

    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      if (params.size > 1 || [...params.keys()].some(key => key !== 'operation')) throw new AccountError('INVALID_INPUT', 400);
      const operation = params.has('operation') ? z.uuid().parse(params.get('operation')) : null;
      sent = true;
      const result = await billingRpc(rpc, 'cluera_billing_plans_read', { ...admin, p_operation: operation }) as { code?: unknown; plans?: unknown; plan?: unknown; history?: unknown };
      if (operation) return cookies.apply(json(result.code === 'APPLIED' ? { code: 'APPLIED', plan: adminPlanSchema.parse(result.plan) } : { code: 'PENDING' }));
      if (result.code !== 'ACTIVE') throw new AccountError('FORBIDDEN', 403);
      return cookies.apply(json({ code: 'ACTIVE', plans: plansList.parse(result.plans), history: historyList.parse(result.history ?? []) }));
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new AccountError('INVALID_INPUT', 400);
    const change = planChangeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readClueraRawBody(request, 4096))));
    sent = true;
    const result = await billingRpc(rpc, 'cluera_billing_plan_change', { ...admin, p_operation: change.operationId, p_action: change.action,
      p_plan: 'planId' in change ? change.planId : null, p_expected_revision: 'expectedRevisionId' in change ? change.expectedRevisionId : null,
      p_reason: change.reason ?? null, p_input: change.input }) as { code?: unknown; plan?: unknown };
    if (result.code === 'APPLIED') return cookies.apply(json({ code: 'APPLIED', plan: adminPlanSchema.parse(result.plan) }));
    const [status, message] = refusals[String(result.code)] ?? [409, 'The change was not made. Press Refresh and try again.'];
    return cookies.apply(json({ code: String(result.code), message }, status));
  } catch (error) {
    const status = error instanceof AccountError ? error.status : !sent && (error instanceof z.ZodError || error instanceof SyntaxError) ? 400 : 503;
    const response = json(status === 400 ? { code: 'INVALID', message: refusals.INVALID[1] }
      : status === 401 || status === 403 ? { code: 'FORBIDDEN', message: refusals.FORBIDDEN[1] }
        : status === 429 ? { code: 'SLOW_DOWN', message: 'Too many requests. Wait a minute and try again.' }
          : { code: 'UNKNOWN', message: 'We could not confirm what happened. Press "Check what happened" before trying again.' }, status);
    if (status === 429) response.headers.set('Retry-After', '60');
    return cookies ? cookies.apply(response) : response;
  }
}
