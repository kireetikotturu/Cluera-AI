import { z } from 'zod';
import { accountConfig, AccountError } from './config';
import { accountClients } from './clients';
import { authorizeCustomer, authFailure, rateLimit } from './handler';
import { json, apiError, readJsonBody } from '../http';
import { usageService } from '../usage/service';
import { accountContextCommand } from './context';
import { readCredits } from './credits';
import {CLUERA_AUTH_STORAGE_KEY,CLUERA_SUPABASE_URL} from '../supabase/target';

/** Explicit native-main API, separate from browser HttpOnly-cookie BFF. Never
 * accepts cookies, browser Origin, query credentials or a client account ID.
 * Tokens returned here must be consumed only by Electron main, never preload.
 * This is a public Auth API, not an app-secret authentication mechanism. */
export async function handleNativeAccount(request: Request, action: string): Promise<Response> {
  try {
    const config = accountConfig();
    if (config.origin !== 'https://cluera-ai-staging.vercel.app'
      || config.url !== CLUERA_SUPABASE_URL) throw new AccountError('UNAVAILABLE', 503);
    if (request.headers.has('origin') || request.headers.has('cookie') || request.headers.has('sec-fetch-site')
      || new URL(request.url).search) throw new AccountError('FORBIDDEN', 403);
    let clients = accountClients(config);
    if (!['login', 'refresh', 'session', 'logout', 'oauth-exchange', 'context', 'credits'].includes(action)
      || request.method !== (action === 'session' || action === 'credits' ? 'GET' : 'POST')) return json({ error: 'Not found.' }, 404);
    // Shared HMAC rate-limit policy with web login; no plaintext identity bucket.
    if (action !== 'login') await rateLimit(request, config, clients);
    if (action === 'login' || action === 'refresh' || action === 'oauth-exchange') {
      if (request.headers.has('authorization')) throw new AccountError('FORBIDDEN', 403);
      const raw = await readJsonBody(request, 16000);
      const input = action === 'login'
        ? z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) }).strict().parse(raw)
        // Opaque refresh credentials have no JWT-like minimum length. Auth,
        // verified identity and the live-session RPC remain authoritative.
        : action==='refresh'?z.object({ refreshToken: z.string().min(1).max(12000) }).strict().parse(raw)
        : z.object({code:z.string().min(1).max(1024),verifier:z.string().regex(/^[A-Za-z0-9_-]{43,128}$/)}).strict().parse(raw);
      if('verifier' in input)clients=accountClients(config,{[`${CLUERA_AUTH_STORAGE_KEY}-code-verifier`]:JSON.stringify(input.verifier)});
      if ('email' in input) await rateLimit(request, config, clients, input.email);
      const { data, error } = 'email' in input
        ? await clients.auth.auth.signInWithPassword(input)
        : 'verifier' in input?await clients.auth.auth.exchangeCodeForSession(input.code)
        : await clients.auth.auth.refreshSession({ refresh_token: input.refreshToken });
      if (error || !data.session) throw authFailure(error);
      // Persist rotated credentials in native main BEFORE fetching balance: a
      // temporary ledger outage must not discard a successfully rotated token.
      const account = await authorizeCustomer(clients, data.session.access_token);
      const validForMilliseconds = Math.floor(Math.min(3600000,
        ((data.session.expires_at ?? 0) * 1000) - Date.now()));
      if (validForMilliseconds <= 0) throw new AccountError('UNAUTHENTICATED', 401);
      return json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token,
        validForMilliseconds, userId: account.userId });
    }
    const bearer = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_.-]{20,12000}$/.test(bearer)) throw new AccountError('UNAUTHENTICATED', 401);
    const token = bearer.slice(7);
    if (action === 'logout') {
      const { allDevices } = z.object({ allDevices: z.boolean() }).strict().parse(await readJsonBody(request, 256));
      // Suspension must not prevent a real user from revoking their own sessions.
      // Auth validates this token; no caller-supplied account identifier is used.
      const verified = await clients.auth.auth.getUser(token);
      if (verified.error || !verified.data.user) throw authFailure(verified.error);
      const { error } = await clients.service.auth.admin.signOut(token, allDevices ? 'global' : 'local');
      if (error) throw authFailure(error);
      return json({ ok: true });
    }
    const account = await authorizeCustomer(clients, token);
    if(action==='credits')return json(await readCredits((name,args)=>clients.service.rpc(name,args),account));
    if(action==='context')return json(await accountContextCommand((name,args)=>clients.service.rpc(name,args),account,await readJsonBody(request,768000)));
    const usage = await usageService((name, args) => clients.service.rpc(name, args)).balance(account);
    // Safe DTO only: do not return auth.sessions IDs, user_metadata or credentials.
    return json({ account: { userId: account.userId, email: account.email }, usage });
  } catch (error) {
    if (error instanceof AccountError) return json({ error: error.code }, error.status);
    return apiError(error);
  }
}
