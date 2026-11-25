/** The one address both apps use to save a résumé. The phone signs in with this browser's own sign-in (same site only);
 * the Windows app sends its access token the way the other native account calls do (no cookies, no browser headers). */
import { z } from 'zod';
import { accountConfig, AccountError } from './config';
import { accountClients } from './clients';
import { AccountCookies } from './cookies';
import { activeSession, assertAccountOrigin, authorizeCustomer, rateLimit } from './handler';
import { stagingAccountConfig } from './workspace';
import { resumeCommand, resumeInput, type ResumeService } from './resumes';
import { apiError, json, readJsonBody } from '../http';
import { CLUERA_SITE_ORIGIN, CLUERA_SUPABASE_URL } from '../supabase/target';

export async function resumeRequest(request: Request): Promise<Response> {
  let cookies: AccountCookies | undefined;
  try {
    if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
    const bearer = request.headers.get('authorization');
    let clients: ReturnType<typeof accountClients>, owner: { userId: string; sessionId: string; email: string }, config;
    if (bearer !== null) {
      config = accountConfig();
      if (config.origin !== CLUERA_SITE_ORIGIN || config.url !== CLUERA_SUPABASE_URL) throw new AccountError('UNAVAILABLE', 503);
      if (request.headers.has('origin') || request.headers.has('cookie') || request.headers.has('sec-fetch-site')
        || new URL(request.url).search) throw new AccountError('FORBIDDEN', 403);
      if (!/^Bearer [A-Za-z0-9_.-]{20,12000}$/.test(bearer)) throw new AccountError('UNAUTHENTICATED', 401);
      clients = accountClients(config);
      owner = await authorizeCustomer(clients, bearer.slice(7));
    } else {
      config = stagingAccountConfig();
      assertAccountOrigin(request, config.origin);
      clients = accountClients(config);
      cookies = new AccountCookies(request, config);
      const { account } = await activeSession(clients, cookies);
      if (cookies.get('recovery') === account.sessionId) throw new AccountError('FORBIDDEN', 403);
      owner = account;
    }
    await rateLimit(request, config, clients, owner.email, 'billing-read');
    const input = resumeInput.parse(await readJsonBody(request, 760_000));
    const result = await resumeCommand(clients.service as unknown as ResumeService, { userId: owner.userId, sessionId: owner.sessionId },
      input, bearer !== null ? 'windows' : 'phone');
    return cookies ? cookies.apply(json(result)) : json(result);
  } catch (error) {
    const response = error instanceof z.ZodError ? json({ error: 'INVALID_INPUT' }, 400)
      : error instanceof AccountError ? json({ error: error.code }, error.status) : apiError(error);
    return cookies ? cookies.apply(response) : response;
  }
}
