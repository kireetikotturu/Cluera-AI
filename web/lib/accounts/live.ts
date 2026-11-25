import { z } from 'zod';
import { AccountError } from './config';
import { accountClients } from './clients';
import { AccountCookies } from './cookies';
import { activeSession, assertAccountOrigin, authorizeCustomer, rateLimit, saveSession } from './handler';
import { stagingAccountConfig } from './workspace';
import { accountContextCommand } from './context';
import { phoneSessionAction } from './phoneSessions';
import { apiError, json, readJsonBody } from '../http';
import { ACCOUNT_DISTRIBUTION } from '../../../desktop/src/shared/accountDistribution';
import { modelRegistry, isTextProvider } from '../accountRelay/models';
import { effectiveSessionDefaults } from './sessionDefaults';
import { SupabaseOperationError } from '../supabase/diagnostics';

/** A sign-in shorter than this would end the live connection almost at once, so it is renewed first. */
const MINIMUM_ACCESS_MS = 120_000;

const command = z.union([
  // The phone connects to the live relay itself, so it needs the short-lived access token of this browser's own sign-in.
  z.object({ action: z.literal('ACCESS') }).strict(),
  // Résumé, job description and notes the customer saved on their account (bodies included).
  z.object({ action: z.literal('DOCUMENTS'), ids: z.array(z.uuid()).max(8) }).strict(),
  // The answer models the customer may choose, with the starting texts the Admin set.
  z.object({ action: z.literal('MODELS') }).strict(),
  // History actions are checked in full by the phone-session contract.
  z.object({ action: z.enum(['LIST', 'READ', 'SAVE', 'DELETE']) }).loose(),
]);

function expiryOf(token: string): number {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  } catch { return 0; }
}

/**
 * The phone live session. Same-origin only, signed-in only, never cached. The access token leaves the server only here,
 * only for this browser's own account, and only to be used as the relay's first message; it lasts at most an hour and
 * stops working the moment the account signs out.
 */
export async function liveRequest(request: Request): Promise<Response> {
  let cookies: AccountCookies | undefined;
  try {
    const config = stagingAccountConfig();
    if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
    assertAccountOrigin(request, config.origin);
    const clients = accountClients(config);
    cookies = new AccountCookies(request, config);
    let { session, account } = await activeSession(clients, cookies);
    if (cookies.get('recovery') === account.sessionId) throw new AccountError('FORBIDDEN', 403);
    const input = command.parse(await readJsonBody(request, 760_000));
    // Saving is bounded by the database; the read-style calls share the billing-read allowance.
    if (input.action !== 'SAVE' && input.action !== 'DELETE') await rateLimit(request, config, clients, account.email, 'billing-read');
    const rpc = (name: string, args: Record<string, unknown>) => clients.service.rpc(name, args);
    const owner = { userId: account.userId, sessionId: account.sessionId };
    if (input.action === 'ACCESS') {
      if (expiryOf(session.access_token) - Date.now() < MINIMUM_ACCESS_MS) {
        const renewed = await clients.auth.auth.refreshSession({ refresh_token: session.refresh_token });
        if (renewed.error || !renewed.data.session) throw new AccountError('UNAUTHENTICATED', 401);
        const checked = await authorizeCustomer(clients, renewed.data.session.access_token, owner);
        saveSession(cookies, renewed.data.session, checked);
        session = renewed.data.session;
      }
      const expiresInMs = Math.min(3_600_000, expiryOf(session.access_token) - Date.now());
      if (expiresInMs < 30_000) throw new AccountError('UNAUTHENTICATED', 401);
      return cookies.apply(json({ accessToken: session.access_token, expiresInMs, userId: account.userId,
        relayEndpoint: ACCOUNT_DISTRIBUTION.relayEndpoint }));
    }
    if (input.action === 'MODELS') {
      const registry = modelRegistry(async () => {
        const { data, error, status } = await clients.service.rpc('account_models_read');
        if (error) throw new SupabaseOperationError('account.models', error, status);
        return data;
      });
      const listed = (await registry.list()).filter(model => isTextProvider(model.provider) && model.enabled && model.health !== 'UNAVAILABLE')
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.priority - b.priority || a.modelId.localeCompare(b.modelId));
      let defaults = effectiveSessionDefaults(null);
      try {
        const { data, error } = await clients.service.rpc('account_session_defaults_read');
        if (!error) defaults = effectiveSessionDefaults(data);
      } catch { /* the built-in starting texts apply */ }
      let defaultTaken = false;
      return cookies.apply(json({ sessionDefaults: defaults, models: listed.map(model => {
        const isDefault = model.isDefault && !defaultTaken; defaultTaken ||= isDefault;
        return { modelId: model.modelId, displayName: model.displayName, provider: model.provider, isDefault, tag: model.tag ?? '',
          image: model.capabilities.includes('image') };
      }) }));
    }
    if (input.action === 'DOCUMENTS') {
      const result = await accountContextCommand(rpc, owner, { action: 'READ', ids: input.ids }) as { documents: unknown[] };
      return cookies.apply(json({ documents: result.documents }));
    }
    const result = await phoneSessionAction(rpc, owner, input);
    return cookies.apply(json(result));
  } catch (error) {
    if (error instanceof z.ZodError) return json({ error: 'INVALID_INPUT' }, 400);
    return error instanceof AccountError ? json({ error: error.code }, error.status) : apiError(error);
  }
}
