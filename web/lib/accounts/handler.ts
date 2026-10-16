import { createHmac } from 'node:crypto';
import type { Session } from '@supabase/supabase-js';
import { z } from 'zod';
import { accountConfig, AccountError, type AccountConfig } from './config';
import { accountClients } from './clients';
import { AccountCookies } from './cookies';
import { clientIp, json, readJsonBody, apiError } from '../http';
import { SupabaseOperationError } from '../supabase/diagnostics';
import { usageService } from '../usage/service';
import { sandboxCheckoutAllowed, sandboxCheckoutEnabled } from '../billing/checkout/gate';
import { checkoutService } from '../billing/checkout/service';
import { resumeSandboxCheckout } from '../billing/checkout/resume';
import {CLUERA_AUTH_ISSUER,CLUERA_SUPABASE_URL} from '../supabase/target';

const emailSchema = z.string().trim().email().max(254);
const passwordSchema = z.string().min(12).max(128);
const sessionClaims = z.object({ sub:z.uuid(),session_id:z.uuid(),iss:z.literal(CLUERA_AUTH_ISSUER),
  aud:z.union([z.literal('authenticated'),z.tuple([z.literal('authenticated')])]),role:z.literal('authenticated'),exp:z.number().int().positive() });
type Clients = ReturnType<typeof accountClients>;
type Account = { userId: string; email: string; trialSecondsGranted: number; remoteDesktop: false };
export function authFailure(error: { status?: number } | null | undefined): AccountError {
  return error && (!error.status || error.status >= 500)
    ? new AccountError('UNAVAILABLE', 503) : new AccountError('UNAUTHENTICATED', 401);
}

export function assertAccountOrigin(request: Request, origin: string): void {
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AccountError('FORBIDDEN', 403);
  }
}
export async function authorizeCustomer(clients: Clients, token: string): Promise<Account & { sessionId: string }> {
  const { data, error } = await clients.auth.auth.getUser(token);
  if (error) throw authFailure(error);
  if (!data.user?.email || !data.user.email_confirmed_at || data.user.is_anonymous) {
    throw new AccountError('UNAUTHENTICATED', 401);
  }
  // Decode only AFTER Auth has validated the token; never authorize from user_metadata.
  let claims: z.infer<typeof sessionClaims>;
  try { claims = sessionClaims.parse(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())); }
  catch { throw new AccountError('UNAUTHENTICATED', 401); }
  if (claims.sub !== data.user.id || claims.exp<=Math.floor(Date.now()/1000)) throw new AccountError('UNAUTHENTICATED', 401);
  const { data: account, error: dbError, status } = await clients.service.rpc('customer_authorize', {
    p_user_id: data.user.id, p_session_id: claims.session_id,
  });
  if (dbError) throw new SupabaseOperationError('account.authorize', dbError, status);
  if (account?.code === 'SUSPENDED') throw new AccountError('FORBIDDEN', 403);
  if (account?.code !== 'ACTIVE' || account.userId !== data.user.id || account.trialSecondsGranted !== 900
    || account.remoteDesktop !== false) throw new AccountError('UNAUTHENTICATED', 401);
  return { userId: data.user.id, email: data.user.email, sessionId: claims.session_id,
    trialSecondsGranted: 900, remoteDesktop: false };
}
export async function rateLimit(request: Request, config: AccountConfig, clients: Clients, email?: string): Promise<void> {
  const identifiers = [`ip:${clientIp(request)}`, ...(email ? [`email:${email.toLowerCase()}`] : [])];
  for (const identifier of identifiers) {
    const bucket = createHmac('sha256', config.rateKey).update(`customer-auth-v2:${CLUERA_SUPABASE_URL}:${identifier}`).digest('hex');
    const { data, error, status } = await clients.service.rpc('customer_auth_rate_limit', {
      p_bucket_hash: bucket, p_maximum: identifier.startsWith('ip:') ? 60 : 15,
    });
    if (error) throw new SupabaseOperationError('account.rateLimit', error, status);
    if (data !== true) throw new AccountError('RATE_LIMITED', 429);
  }
}
function saveSession(cookies: AccountCookies, session: Session) {
  cookies.set('access', session.access_token, Math.max(1, Math.min(session.expires_in - 30, 3570)));
  cookies.set('refresh', session.refresh_token, 30 * 86400);
}
export async function activeSession(clients: Clients, cookies: AccountCookies) {
  const access = cookies.get('access'); const refresh = cookies.get('refresh');
  if (typeof refresh !== 'string') throw new AccountError('UNAUTHENTICATED', 401);
  let previous: z.infer<typeof sessionClaims> | undefined;
  if (typeof access === 'string') {
    try { return { session: { access_token: access, refresh_token: refresh }, account: await authorizeCustomer(clients, access) }; }
    catch (error) {
      // A request can cross the token expiry boundary while its sealed cookie
      // is still present. Only expiry selects a refresh attempt, never access.
      // Network failures, suspension and non-expired revocation stay failures.
      if (!(error instanceof AccountError) || error.status !== 401) throw error;
      try {
        const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
        if (!Number.isSafeInteger(claims.exp) || claims.exp > Math.floor(Date.now()/1000)) throw error;
        previous = sessionClaims.parse(claims);
      } catch { throw error; }
    }
  }
  const { data, error } = await clients.auth.auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) throw authFailure(error);
  const account = await authorizeCustomer(clients, data.session.access_token);
  if (previous && (previous.sub !== account.userId || previous.session_id !== account.sessionId)) {
    throw new AccountError('UNAUTHENTICATED', 401);
  }
  if (data.session.access_token !== access) saveSession(cookies, data.session);
  return { session: data.session, account };
}
const publicAccount = ({ sessionId: _sessionId, ...account }: Account & { sessionId: string }) => account;

/** Separate BFF auth surface: no customer Auth tokens in JSON, localStorage or React props. */
export async function handleAccount(request: Request, action: string): Promise<Response> {
  let cookies: AccountCookies | undefined;
  try {
    if(['checkout','checkout-resume'].includes(action)&&!sandboxCheckoutEnabled())return json({error:'Not found.'},404);
    const config = accountConfig();
    cookies = new AccountCookies(request, config);
    const storedFlow = cookies.get('flow');
    const parsedFlow = z.record(z.string().max(160), z.string().max(1024)).safeParse(storedFlow);
    // Only callbacks resume a verifier. Starting a new attempt replaces the old
    // pending flow, keeping cookie size bounded even after repeated email requests.
    const clients = accountClients(config, action === 'callback' && parsedFlow.success ? parsedFlow.data : {});
    const callback = `${config.origin}/api/account/callback`;
    if (request.method === 'POST') assertAccountOrigin(request, config.origin);
    if(action==='checkout-resume'){
      if(request.method!=='GET')return cookies.apply(json({error:'Not found.'},404));
      // Browsers may omit Origin on same-origin GET. Require corroborating
      // Fetch Metadata AND an exact-origin referrer in that case, never CORS.
      if(request.headers.has('origin'))assertAccountOrigin(request,config.origin);
      else {
        let refererOrigin:string|undefined;try{refererOrigin=new URL(request.headers.get('referer')??'').origin;}catch{}
        if(request.headers.get('sec-fetch-site')!=='same-origin'||refererOrigin!==config.origin)throw new AccountError('FORBIDDEN',403);
      }
      const query=new URL(request.url).searchParams;
      if(query.size!==1||query.getAll('expectedAccountId').length!==1)throw new AccountError('INVALID_INPUT',400);
      const expected=z.uuid().parse(query.get('expectedAccountId'));
      const {account}=await activeSession(clients,cookies);
      if(cookies.get('recovery')===account.sessionId||expected!==account.userId||!sandboxCheckoutAllowed(account.userId))throw new AccountError('FORBIDDEN',403);
      await rateLimit(request,config,clients,account.email);
      const checkout=await resumeSandboxCheckout((name,args)=>clients.service.rpc(name,args),account);
      return cookies.apply(json({checkout},checkout.code==='RESUMABLE'?200:409));
    }
    if (request.method === 'GET' && action === 'session') {
      const { account } = await activeSession(clients, cookies);
      const recovery = cookies.get('recovery');
      return cookies.apply(json({ account: publicAccount(account), passwordRecovery: recovery === account.sessionId }));
    }
    if (request.method === 'GET' && action === 'usage') {
      const { account } = await activeSession(clients, cookies);
      const usage = await usageService((name, args) => clients.service.rpc(name, args)).balance(account);
      return cookies.apply(json({ usage }));
    }
    if (request.method === 'GET' && action === 'callback') {
      await rateLimit(request, config, clients);
      if (!parsedFlow.success) throw new AccountError('UNAUTHENTICATED', 401);
      const url = new URL(request.url);
      const code = z.string().min(1).max(1024).parse(url.searchParams.get('code'));
      const flowId = url.searchParams.get('sb_flow_id');
      const { data, error } = await clients.auth.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
      if (error || !data.session) throw authFailure(error);
      cookies.set('flow', null, 0);
      const account = await authorizeCustomer(clients, data.session.access_token);
      saveSession(cookies, data.session);
      cookies.set('recovery', clients.recovery() ? account.sessionId : null, clients.recovery() ? 600 : 0);
      return cookies.apply(new Response(null, { status: 303, headers: { Location: `${config.origin}/account` } }));
    }
    if (request.method !== 'POST') return cookies.apply(json({ error: 'Not found.' }, 404));
    if(action==='checkout'){
      const {account}=await activeSession(clients,cookies);
      if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
      if(!sandboxCheckoutAllowed(account.userId))throw new AccountError('FORBIDDEN',403);
      await rateLimit(request,config,clients,account.email);
      const input=z.object({requestId:z.uuid(),offerCode:z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly']),expectedAccountId:z.uuid().optional()})
        .strict().parse(await readJsonBody(request,1024));
      if(input.expectedAccountId&&input.expectedAccountId!==account.userId)throw new AccountError('FORBIDDEN',403);
      const result=await checkoutService((name,args)=>clients.service.rpc(name,args)).prepare(account,{requestId:input.requestId,offerCode:input.offerCode});
      return cookies.apply(json({checkout:result},result.code==='BOUND'?200:result.code==='RATE_LIMITED'?429:409));
    }
    if (action === 'logout') {
      // Local scope revokes this Auth session only, never other devices or Admin's separate session.
      const access = cookies.get('access');
      if (typeof access === 'string') {
        const { error } = await clients.service.auth.admin.signOut(access, 'local');
        if (error && error.status !== 401 && error.status !== 403 && error.status !== 404) throw new AccountError('UNAVAILABLE', 503);
      } else if (typeof cookies.get('refresh') === 'string') {
        const { data, error } = await clients.auth.auth.refreshSession({ refresh_token: cookies.get('refresh') as string });
        if (!error && data.session) {
          const signedOut = await clients.service.auth.admin.signOut(data.session.access_token, 'local');
          if (signedOut.error) throw new AccountError('UNAVAILABLE', 503);
        } else if (error && (!error.status || error.status >= 500)) throw new AccountError('UNAVAILABLE', 503);
      }
      cookies.clear(); return cookies.apply(json({ ok: true }));
    }
    if (action === 'reset-password') {
      const input = z.object({ password: passwordSchema }).strict().parse(await readJsonBody(request, 4096));
      const { session, account } = await activeSession(clients, cookies);
      if (cookies.get('recovery') !== account.sessionId) throw new AccountError('FORBIDDEN', 403);
      await rateLimit(request, config, clients, account.email);
      const restored = await clients.auth.auth.setSession(session);
      if (restored.error) throw authFailure(restored.error);
      const { error } = await clients.auth.auth.updateUser({ password: input.password });
      if (error) throw new AccountError('INVALID_INPUT', 400);
      const signedOut = await clients.service.auth.admin.signOut(session.access_token, 'global');
      cookies.clear();
      if (signedOut.error) throw new AccountError('UNAVAILABLE', 503);
      return cookies.apply(json({ ok: true, message: 'Password updated. Sign in again.' }));
    }
    if (!['login', 'signup', 'forgot-password', 'resend-verification', 'google'].includes(action)) return cookies.apply(json({ error: 'Not found.' }, 404));
    const raw = await readJsonBody(request, 4096);
    const input = action === 'google' ? z.object({}).strict().parse(raw) : ['forgot-password','resend-verification'].includes(action)
      ? z.object({ email: emailSchema }).strict().parse(raw)
      : z.object({ email: emailSchema, password: action === 'signup' ? passwordSchema : z.string().min(1).max(128) }).strict().parse(raw);
    const email = 'email' in input ? input.email as string : undefined;
    await rateLimit(request, config, clients, email);
    if (action === 'login') {
      const { data, error } = await clients.auth.auth.signInWithPassword(input as { email: string; password: string });
      if (error || !data.session) throw authFailure(error);
      const account = await authorizeCustomer(clients, data.session.access_token);
      saveSession(cookies, data.session); cookies.set('recovery', null, 0); cookies.set('flow', null, 0);
      return cookies.apply(json({ account: publicAccount(account) }));
    }
    if (action === 'google') {
      const { data, error } = await clients.auth.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback, skipBrowserRedirect: true } });
      if (error || !data.url) throw new AccountError('UNAVAILABLE', 503);
      const target = new URL(data.url);
      if (target.origin !== config.url || target.pathname !== '/auth/v1/authorize') throw new AccountError('UNAVAILABLE', 503);
      cookies.set('flow', clients.flow(), 600);
      return cookies.apply(json({ redirectUrl: target.href }));
    }
    const result = action === 'signup'
      ? await clients.auth.auth.signUp({ ...(input as { email: string; password: string }), options: { emailRedirectTo: callback } })
      : action === 'resend-verification'
      ? await clients.auth.auth.resend({type:'signup',email:email!,options:{emailRedirectTo:callback}})
      : await clients.auth.auth.resetPasswordForEmail(email!, { redirectTo: callback });
    // Avoid account enumeration; delivery/account-existence responses never reach the browser.
    // Service failures are distinct from account-specific rejections.
    if (result.error && (!result.error.status || result.error.status >= 500)) throw new AccountError('UNAVAILABLE', 503);
    // The installed SDK creates a NEW PKCE verifier for resend. Export that
    // request-local slot; the owner must open the latest link in this browser.
    cookies.set('flow', clients.flow(), 3600);
    return cookies.apply(json({ message: 'If this request is eligible, check your email. Open the link in this browser.' }));
  } catch (error) {
    if (error instanceof AccountError) {
      const messages = { UNAVAILABLE: 'Account service is unavailable.', UNAUTHENTICATED: 'Sign in with a verified email to continue.',
        FORBIDDEN: 'This action is not allowed.', INVALID_INPUT: 'The request could not be accepted.', RATE_LIMITED: 'Too many attempts. Try again later.' };
      if (error.status === 401) cookies?.clear();
      const response = json({ error: messages[error.code] }, error.status);
      return cookies ? cookies.apply(response) : response;
    }
    const response = apiError(error);
    return cookies ? cookies.apply(response) : response;
  }
}
