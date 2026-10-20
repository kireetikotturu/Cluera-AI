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
import {CLUERA_AUTH_ISSUER,CLUERA_SUPABASE_URL,CLUERA_SITE_ORIGIN} from '../supabase/target';
import {MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH,weakPasswordNotice} from './passwordPolicy';
import {emailNotice,emailDeliveryNotice} from './publicAuth';
import {readAuthOptions} from './authOptions';

const emailSchema = z.string().trim().email().max(254);
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);
class AuthMailError extends Error {
  constructor(readonly code:'WEAK_PASSWORD'|'EMAIL_DELIVERY_FAILED',readonly status:400|503){super(code);}
}
type PasswordCode='REAUTHENTICATION_REQUIRED'|'INVALID_REAUTHENTICATION'|'CURRENT_PASSWORD_REQUIRED'|'CURRENT_PASSWORD_MISMATCH'
 |'SAME_PASSWORD'|'PASSWORD_UPDATE_REJECTED'|'PASSWORD_UPDATE_UNCERTAIN'|'AUTHENTICATION_REQUIRED'|'RECOVERY_SESSION_REQUIRED'
 |'PASSWORD_RECOVERY_ACTIVE'|'REAUTHENTICATION_UNAVAILABLE'|'MFA_REQUIRED';
class PasswordChangeError extends Error {
 constructor(readonly code:PasswordCode,readonly status:400|401|403|503){super(code);}
}
const passwordActions=['reset-password','change-password','reauthenticate'];
const passwordSessionSchema=z.object({access_token:z.string().min(1).max(16000),refresh_token:z.string().min(1).max(16000),
 expires_in:z.number().finite().positive()}).passthrough();
function rejectPasswordFailure(error:{status?:number;code?:string}|null|undefined){
 if(!error)return;
 if(error.code==='insufficient_aal')throw new PasswordChangeError('MFA_REQUIRED',403);
 if(error.code==='weak_password')throw new AuthMailError('WEAK_PASSWORD',400);
 if(error.status===429||['over_request_rate_limit','over_email_send_rate_limit'].includes(error.code??''))throw new AccountError('RATE_LIMITED',429);
 const mapped:{[key:string]:[PasswordCode,400|403]}={reauthentication_needed:['REAUTHENTICATION_REQUIRED',403],
  reauthentication_not_valid:['INVALID_REAUTHENTICATION',400],current_password_required:['CURRENT_PASSWORD_REQUIRED',400],
  current_password_mismatch:['CURRENT_PASSWORD_MISMATCH',400],same_password:['SAME_PASSWORD',400]};
 if(error.code&&Object.hasOwn(mapped,error.code)){const [code,status]=mapped[error.code];throw new PasswordChangeError(code,status);}
 if(error.status===401||error.status===403)throw new PasswordChangeError('AUTHENTICATION_REQUIRED',401);
 if(!error.status||error.status>=500)throw new PasswordChangeError('PASSWORD_UPDATE_UNCERTAIN',503);
 throw new PasswordChangeError('PASSWORD_UPDATE_REJECTED',400);
}
// Inspect only documented fixed categories, never provider messages/identities.
function rejectMailFailure(error:{status?:number;code?:string}|null|undefined){
  if(!error)return;
  if(error.status===429||['over_email_send_rate_limit','over_request_rate_limit'].includes(error.code??''))throw new AccountError('RATE_LIMITED',429);
  if(error.code==='weak_password')throw new AuthMailError('WEAK_PASSWORD',400);
  if(!error.status||error.status>=500||['email_address_not_authorized','email_provider_disabled','signup_disabled'].includes(error.code??''))throw new AuthMailError('EMAIL_DELIVERY_FAILED',503);
  // All other account-specific outcomes retain the same anti-enumeration response.
}
const sessionClaims = z.object({ sub:z.uuid(),session_id:z.uuid(),iss:z.literal(CLUERA_AUTH_ISSUER),
  aud:z.union([z.literal('authenticated'),z.tuple([z.literal('authenticated')])]),role:z.literal('authenticated'),exp:z.number().int().positive() });
type Clients = ReturnType<typeof accountClients>;
type Account = { userId: string; email: string; trialSecondsGranted: number; remoteDesktop: false };
const identitySchema=z.object({userId:z.uuid(),sessionId:z.uuid()}).strict();
type SessionIdentity=z.infer<typeof identitySchema>;
export function authFailure(error: { status?: number; code?:string } | null | undefined): AccountError {
  if(error?.status===429||error?.code==='over_request_rate_limit')return new AccountError('RATE_LIMITED',429);
  return error && (!error.status || error.status >= 500)
    ? new AccountError('UNAVAILABLE', 503) : new AccountError('UNAUTHENTICATED', 401);
}

export function assertAccountOrigin(request: Request, origin: string): void {
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AccountError('FORBIDDEN', 403);
  }
}
export async function authorizeCustomer(clients: Clients, token: string, expected?:SessionIdentity): Promise<Account & { sessionId: string }> {
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
  // Compare refreshed identity before an RPC could initialize another account.
  if(expected&&(claims.sub!==expected.userId||claims.session_id!==expected.sessionId))throw new AccountError('UNAUTHENTICATED',401);
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
export function saveSession(cookies: AccountCookies, session: Session, account:SessionIdentity) {
  cookies.set('access', session.access_token, Math.max(1, Math.min(session.expires_in - 30, 3570)));
  cookies.set('refresh', session.refresh_token, 30 * 86400);
  cookies.set('session', {userId:account.userId,sessionId:account.sessionId}, 30 * 86400);
  const recovery=cookies.recoveryState();
  if(recovery?.sessionId===account.sessionId)cookies.set('recovery-lock',recovery,30*86400);
}
export async function activeSession(clients: Clients, cookies: AccountCookies) {
  const access = cookies.get('access'); const refresh = cookies.get('refresh');
  if (typeof refresh !== 'string') throw new AccountError('UNAUTHENTICATED', 401);
  const storedIdentity=cookies.get('session'),parsedIdentity=identitySchema.safeParse(storedIdentity);
  if(storedIdentity!==null&&!parsedIdentity.success)throw new AccountError('UNAUTHENTICATED',401);
  const identity=parsedIdentity.success?parsedIdentity.data:undefined;
  let previous: z.infer<typeof sessionClaims> | undefined;
  if (typeof access === 'string') {
    try {
      const account=await authorizeCustomer(clients,access,identity);
      if(!identity)cookies.set('session',{userId:account.userId,sessionId:account.sessionId},30*86400);
      const recovery=cookies.recoveryState();
      if(recovery?.sessionId===account.sessionId&&!cookies.get('recovery-lock'))cookies.set('recovery-lock',recovery,30*86400);
      return {session:{access_token:access,refresh_token:refresh},account};
    }
    catch (error) {
      // A request can cross the token expiry boundary while its sealed cookie
      // is still present. Only expiry selects a refresh attempt, never access.
      // Network failures, suspension and non-expired revocation stay failures.
      if (!(error instanceof AccountError) || error.status !== 401) throw error;
      try {
        const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
        if (!Number.isSafeInteger(claims.exp) || claims.exp > Math.floor(Date.now()/1000)) throw error;
        previous = sessionClaims.parse(claims);
        if(identity&&(previous.sub!==identity.userId||previous.session_id!==identity.sessionId))throw error;
      } catch { throw error; }
    }
  }
  const { data, error } = await clients.auth.auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) throw authFailure(error);
  // Legacy refresh-only cookies authenticate once with Auth, then gain the anchor.
  const expected=identity??(previous?{userId:previous.sub,sessionId:previous.session_id}:undefined);
  const account = await authorizeCustomer(clients, data.session.access_token,expected);
  if (previous && (previous.sub !== account.userId || previous.session_id !== account.sessionId)) {
    throw new AccountError('UNAUTHENTICATED', 401);
  }
  if (data.session.access_token !== access||data.session.refresh_token!==refresh||!identity) saveSession(cookies, data.session,account);
  return { session: data.session, account };
}
const publicAccount = ({ sessionId: _sessionId, ...account }: Account & { sessionId: string }) => account;

/** Separate BFF auth surface: no customer Auth tokens in JSON, localStorage or React props. */
export async function handleAccount(request: Request, action: string): Promise<Response> {
  if(action==='password-security'||action==='password-mfa'){
    const {handlePasswordSecurity}=await import('./passwordSecurity');
    return handlePasswordSecurity(request,action);
  }
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
      if(url.searchParams.has('error')||url.searchParams.getAll('code').length!==1
        ||url.searchParams.getAll('sb_flow_id').length>1)throw new AccountError('INVALID_INPUT',400);
      const code = z.string().min(1).max(1024).parse(url.searchParams.get('code'));
      const flowId = url.searchParams.get('sb_flow_id');
      const { data, error } = await clients.auth.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
      if (error || !data.session) throw authFailure(error);
      cookies.set('flow', null, 0);
      const account = await authorizeCustomer(clients, data.session.access_token);
      saveSession(cookies, data.session,account);
      cookies.set('recovery', clients.recovery() ? account.sessionId : null, clients.recovery() ? 600 : 0);
      cookies.set('recovery-lock',clients.recovery()?{sessionId:account.sessionId,resetUntil:Date.now()+600_000}:null,clients.recovery()?30*86400:0);
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
      const input=z.object({expectedAccountId:z.uuid().optional()}).strict().parse(request.body===null?{}:await readJsonBody(request,1024));
      let validatedAccess:string|undefined;
      if(input.expectedAccountId){
        const anchor=identitySchema.safeParse(cookies.get('session'));
        if(anchor.success&&anchor.data.userId!==input.expectedAccountId)throw new AccountError('FORBIDDEN',403);
        try{
          const current=await activeSession(clients,cookies);
          if(current.account.userId!==input.expectedAccountId)throw new AccountError('FORBIDDEN',403);
          validatedAccess=current.session.access_token;
        }catch(error){
          // Explicitly leaving a definitively ended session must remain possible.
          // A service outage or a different owner is not a successful logout.
          if(!(error instanceof AccountError)||error.status!==401)throw error;
          cookies.clear();return cookies.apply(json({ok:true}));
        }
      }
      // Local scope revokes this Auth session only, never other devices or Admin's separate session.
      const access = validatedAccess??cookies.get('access');
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
    if (passwordActions.includes(action)) {
      const nonce=z.string().regex(/^[0-9]{6,12}$/).optional();
      const raw=await readJsonBody(request,4096);
      const input=action==='reauthenticate'?z.object({expectedAccountId:z.uuid()}).strict().parse(raw)
        :action==='change-password'?z.object({expectedAccountId:z.uuid(),password:passwordSchema,
          currentPassword:z.string().min(1).max(128).optional(),nonce}).strict().parse(raw)
        :z.object({password:passwordSchema,expectedAccountId:z.uuid().optional(),nonce}).strict().parse(raw);
      const { session, account } = await activeSession(clients, cookies);
      if(input.expectedAccountId!==undefined&&input.expectedAccountId!==account.userId)throw new AccountError('FORBIDDEN',403);
      const recovering=cookies.get('recovery')===account.sessionId;
      if(action==='reset-password'&&!recovering)throw new PasswordChangeError('RECOVERY_SESSION_REQUIRED',403);
      if(action==='reset-password'&&!cookies.recoveryResetAllowed(account.sessionId))throw new PasswordChangeError('RECOVERY_SESSION_REQUIRED',403);
      if(action!=='reset-password'&&recovering)throw new PasswordChangeError('PASSWORD_RECOVERY_ACTIVE',403);
      await rateLimit(request, config, clients, account.email);
      const restored = await clients.auth.auth.setSession(session);
      if(restored.error||!restored.data.session)throw new PasswordChangeError('AUTHENTICATION_REQUIRED',restored.error&&(!restored.error.status||restored.error.status>=500)?503:401);
      let current=restored.data.session;
      const currentAccount=await authorizeCustomer(clients,current.access_token,{userId:account.userId,sessionId:account.sessionId});
      if(current.access_token!==session.access_token||current.refresh_token!==session.refresh_token)saveSession(cookies,current,currentAccount);
      const sessionCookies=cookies;
      const capturePasswordSession=async()=>{
        // These SDK calls may rotate credentials proactively even when their
        // eventual operation fails. Validate capture before sealing it, without
        // replacing a known mutation result with an unrelated capture failure.
        try{
          const captured=await clients.auth.auth.getSession();
          if(captured.error||!passwordSessionSchema.safeParse(captured.data?.session).success)return;
          const latest=captured.data.session!;
          if(latest.access_token!==current.access_token||latest.refresh_token!==current.refresh_token){
            const latestAccount=await authorizeCustomer(clients,latest.access_token,{userId:account.userId,sessionId:account.sessionId});
            saveSession(sessionCookies,latest,latestAccount);current=latest;
          }
        }catch{/* Preserve the actual password/email operation outcome below. */}
      };
      if(action==='reauthenticate'){
        let result;try{result=await clients.auth.auth.reauthenticate();}catch{throw new PasswordChangeError('REAUTHENTICATION_UNAVAILABLE',503);}
        finally{await capturePasswordSession();}
        if(result.error?.status===429)throw new AccountError('RATE_LIMITED',429);
        if(result.error)throw new PasswordChangeError('REAUTHENTICATION_UNAVAILABLE',503);
        return cookies.apply(json({ok:true,message:emailNotice}));
      }
      if(!('password' in input))throw new AccountError('INVALID_INPUT',400);
      let result;
      try{result=await clients.auth.auth.updateUser({password:input.password,...(input.nonce?{nonce:input.nonce}:{}),
        ...('currentPassword' in input&&typeof input.currentPassword==='string'&&input.currentPassword?{current_password:input.currentPassword}:{})});}
      catch{throw new PasswordChangeError('PASSWORD_UPDATE_UNCERTAIN',503);}
      finally{await capturePasswordSession();}
      rejectPasswordFailure(result.error);
      if(result.data?.user?.id!==account.userId)throw new PasswordChangeError('PASSWORD_UPDATE_UNCERTAIN',503);
      // Do not misreport an already successful update when later revocation fails.
      let sessionsRevoked=false;
      try{sessionsRevoked=!(await clients.service.auth.admin.signOut(current.access_token,'global')).error;}catch{/* Explicit incomplete outcome below. */}
      cookies.clear();
      return cookies.apply(json({ok:true,sessionsRevoked,message:sessionsRevoked?'Password updated. Sign in again.'
        :'Password updated and this browser was signed out. Other-device sign-out could not be confirmed. Do not repeat the password update.'}));
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
      saveSession(cookies, data.session,account); cookies.set('recovery', null, 0); cookies.set('recovery-lock',null,0); cookies.set('flow', null, 0);
      return cookies.apply(json({ account: publicAccount(account) }));
    }
    if (action === 'google') {
      const options=await readAuthOptions(config);
      if(options.google!=='enabled')return cookies.apply(json({code:'GOOGLE_UNAVAILABLE',error:'Google sign-in is not available. Use email sign-in.'},503));
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
    rejectMailFailure(result.error);
    // Rejected eligibility must not overwrite a previously valid pending verifier.
    if(result.error){cookies.retainPendingFlow();return cookies.apply(json({message:emailNotice}));}
    // The installed SDK creates a NEW PKCE verifier for resend. Export that
    // request-local slot; the owner must open the latest link in this browser.
    cookies.set('flow', clients.flow(), 3600);
    return cookies.apply(json({ message: emailNotice }));
  } catch (error) {
    if(action==='callback'&&request.method==='GET'&&cookies){
      cookies.set('flow',null,0);
      const cancelled=new URL(request.url).searchParams.get('error')==='access_denied';
      return cookies.apply(new Response(null,{status:303,headers:{Location:`${CLUERA_SITE_ORIGIN}/account?authError=${cancelled?'cancelled':'link_invalid'}#login`}}));
    }
    if(['signup','reset-password','change-password'].includes(action)&&error instanceof z.ZodError
      &&error.issues.some(issue=>issue.path.length===1&&issue.path[0]==='password'&&['too_small','too_big'].includes(issue.code))){
      const response=json({code:'WEAK_PASSWORD',error:weakPasswordNotice},400);
      return cookies?cookies.apply(response):response;
    }
    if(error instanceof AuthMailError)return cookies?cookies.apply(json({code:error.code,error:error.code==='WEAK_PASSWORD'?weakPasswordNotice:emailDeliveryNotice},error.status)):json({code:error.code,error:error.code==='WEAK_PASSWORD'?weakPasswordNotice:emailDeliveryNotice},error.status);
    if(passwordActions.includes(action)&&error instanceof z.ZodError){
      const response=json({code:'INVALID_SECURITY_FIELDS',error:'Check the current password and verification fields.'},400);
      return cookies?cookies.apply(response):response;
    }
    if(error instanceof PasswordChangeError){
      const messages:Record<PasswordCode,string>={REAUTHENTICATION_REQUIRED:'Verify your email code before changing the password.',
        INVALID_REAUTHENTICATION:'That verification code is invalid or expired.',CURRENT_PASSWORD_REQUIRED:'Enter your current password.',
        CURRENT_PASSWORD_MISMATCH:'The current password was not accepted.',SAME_PASSWORD:'Choose a different new password.',
        PASSWORD_UPDATE_REJECTED:'The password update was not accepted. Check the security fields and try again.',
        PASSWORD_UPDATE_UNCERTAIN:'The password-update outcome is unconfirmed. Do not submit again automatically; sign in or use password recovery.',
        AUTHENTICATION_REQUIRED:'Your session must be verified again before changing security settings.',
        RECOVERY_SESSION_REQUIRED:'Open the latest password-reset email in this browser before resetting your password.',
        PASSWORD_RECOVERY_ACTIVE:'Finish the password-reset flow before using ordinary account security settings.',
        REAUTHENTICATION_UNAVAILABLE:'A verification code could not be sent. Try again later.',
        MFA_REQUIRED:'Verify your authenticator code before updating your password.'};
      const response=json({code:error.code,error:messages[error.code]},error.status);
      return cookies?cookies.apply(response):response;
    }
    if (error instanceof AccountError) {
      const messages = { UNAVAILABLE: 'Account service is unavailable.', UNAUTHENTICATED: 'Sign in with a verified email to continue.',
        FORBIDDEN: 'This action is not allowed.', INVALID_INPUT: 'The request could not be accepted.', RATE_LIMITED: 'Too many attempts. Try again later.' };
      if (error.status === 401&&!passwordActions.includes(action)) cookies?.clearSession();
      const response = json({ error: messages[error.code] }, error.status);
      if(error.code==='RATE_LIMITED')response.headers.set('Retry-After','60');
      return cookies ? cookies.apply(response) : response;
    }
    const response = apiError(error);
    return cookies ? cookies.apply(response) : response;
  }
}
