import {z} from 'zod';
import {accountClients} from './clients';
import {accountConfig,AccountError} from './config';
import {AccountCookies} from './cookies';
import {activeSession,assertAccountOrigin,authorizeCustomer,rateLimit,saveSession} from './handler';
import {InvalidInputError,json,readJsonBody} from '../http';

type SecurityCode='MFA_REQUIRED'|'MFA_CODE_INVALID'|'MFA_UNAVAILABLE'|'AUTHENTICATION_REQUIRED'
 |'RECOVERY_SESSION_REQUIRED'|'FORBIDDEN'|'RATE_LIMITED';
const failures:Record<SecurityCode,{status:number;error:string}>={
 MFA_REQUIRED:{status:403,error:'Verify your authenticator before changing your password.'},
 MFA_CODE_INVALID:{status:400,error:'Check your authenticator code and try again.'},
 MFA_UNAVAILABLE:{status:503,error:'Account security verification is unavailable. Try again later.'},
 AUTHENTICATION_REQUIRED:{status:401,error:'Verify your session again before changing account security settings.'},
 RECOVERY_SESSION_REQUIRED:{status:403,error:'Open the latest password-reset email in this browser before resetting your password.'},
 FORBIDDEN:{status:403,error:'This security request is not allowed.'},
 RATE_LIMITED:{status:429,error:'Too many attempts. Try again later.'},
};
class SecurityError extends Error {constructor(readonly code:SecurityCode){super(code);}}
const factorList=z.array(z.object({id:z.uuid(),status:z.enum(['verified','unverified']),
 factor_type:z.string().min(1).max(64)}).passthrough()).max(128);
const sessionData=z.object({access_token:z.string().min(1).max(16000),refresh_token:z.string().min(1).max(16000),
 expires_in:z.number().finite().positive()}).passthrough();
function aal2(token:string):boolean{
 // Call only after authorizeCustomer has validated this exact token with Auth.
 try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).aal==='aal2';}catch{return false;}
}
function upstreamFailure(error:{status?:number;code?:string;name?:string}|null|undefined,verification=false):never{
 if(error?.status===429||error?.code==='over_request_rate_limit')throw new SecurityError('RATE_LIMITED');
 if(error?.code==='insufficient_aal')throw new SecurityError('MFA_REQUIRED');
 if(verification&&['mfa_verification_failed','mfa_verification_rejected','mfa_challenge_expired'].includes(error?.code??''))throw new SecurityError('MFA_CODE_INVALID');
 if(['mfa_factor_not_found','mfa_phone_verify_not_enabled','mfa_totp_verify_not_enabled','mfa_webauthn_verify_not_enabled',
  'mfa_web_authn_verify_not_enabled','mfa_recovery_codes_verify_not_enabled','provider_disabled'].includes(error?.code??''))throw new SecurityError('MFA_UNAVAILABLE');
 if(error?.name==='AuthSessionMissingError'||error?.status===401||error?.status===403)throw new SecurityError('AUTHENTICATION_REQUIRED');
 throw new SecurityError('MFA_UNAVAILABLE');
}

/** Existing verified TOTP factors only: never enroll, remove or bypass MFA.
 * Auth tokens stay in sealed cookies. A step-up retains the original recovery
 * deadline and is bound to the same live customer and Auth session. */
export async function handlePasswordSecurity(request:Request,action:'password-security'|'password-mfa'):Promise<Response>{
 let cookies:AccountCookies|undefined;
 try{
  const verify=action==='password-mfa',query=new URL(request.url).searchParams;
  if(request.method!==(verify?'POST':'GET'))throw new SecurityError('FORBIDDEN');
  if(verify?query.size!==0:query.size!==1||query.getAll('expectedAccountId').length!==1)throw new SecurityError('FORBIDDEN');
  const config=accountConfig();
  if(verify)assertAccountOrigin(request,config.origin);
  const input=verify?z.object({expectedAccountId:z.uuid(),factorId:z.uuid(),code:z.string().regex(/^\d{6}$/)}).strict()
   .parse(await readJsonBody(request,1024)):z.object({expectedAccountId:z.uuid()}).strict().parse(Object.fromEntries(query));
  cookies=new AccountCookies(request,config);
  const clients=accountClients(config),{session,account}=await activeSession(clients,cookies);
  if(input.expectedAccountId!==account.userId)throw new SecurityError('FORBIDDEN');
  const recovering=cookies.get('recovery')===account.sessionId;
  const recoveryExpired=recovering&&!cookies.recoveryResetAllowed(account.sessionId);
  if(verify&&recoveryExpired)throw new SecurityError('RECOVERY_SESSION_REQUIRED');
  await rateLimit(request,config,clients,verify?account.email:undefined);
  const restored=await clients.auth.auth.setSession(session);
  if(restored.error){
   const status=restored.error.status;
   if(typeof status==='number'&&status>=400&&status<500&&status!==429&&restored.error.code!=='insufficient_aal')throw new SecurityError('AUTHENTICATION_REQUIRED');
   upstreamFailure(restored.error);
  }
  const parsedSession=sessionData.safeParse(restored.data?.session);
  if(!parsedSession.success)throw new SecurityError('AUTHENTICATION_REQUIRED');
  const current=restored.data.session!;
  const currentAccount=await authorizeCustomer(clients,current.access_token,{userId:account.userId,sessionId:account.sessionId});
  if(current.access_token!==session.access_token||current.refresh_token!==session.refresh_token)saveSession(cookies,current,currentAccount);
  const listed=await clients.auth.auth.mfa.listFactors();
  if(listed.error)upstreamFailure(listed.error);
  const parsedFactors=factorList.safeParse(listed.data?.all);
  if(!parsedFactors.success||new Set(parsedFactors.data.map(factor=>factor.id)).size!==parsedFactors.data.length)throw new SecurityError('MFA_UNAVAILABLE');
  const verified=parsedFactors.data.filter(factor=>factor.status==='verified');
  const factors=verified.filter(factor=>factor.factor_type==='totp').map(factor=>({id:factor.id,type:'totp' as const}));
  if(!verify)return cookies.apply(json({accountId:account.userId,passwordRecovery:recovering,recoveryExpired,
   needsMfa:verified.length>0&&!aal2(current.access_token),factors}));
  if(!('factorId' in input)||typeof input.factorId!=='string'||!('code' in input)||typeof input.code!=='string'
   ||!factors.some(factor=>factor.id===input.factorId))throw new SecurityError('FORBIDDEN');
  const checked=await clients.auth.auth.mfa.challengeAndVerify({factorId:input.factorId,code:input.code});
  if(checked.error)upstreamFailure(checked.error,true);
  const parsedVerified=sessionData.safeParse(checked.data);
  if(!parsedVerified.success)throw new SecurityError('MFA_UNAVAILABLE');
  const next=checked.data!;
  const nextAccount=await authorizeCustomer(clients,next.access_token,{userId:account.userId,sessionId:account.sessionId});
  if(!aal2(next.access_token))throw new SecurityError('MFA_REQUIRED');
  saveSession(cookies,next,nextAccount);
  return cookies.apply(json({ok:true}));
 }catch(error){
  let code:SecurityCode='MFA_UNAVAILABLE';
  if(error instanceof SecurityError)code=error.code;
  else if(error instanceof AccountError)code=error.code==='UNAUTHENTICATED'?'AUTHENTICATION_REQUIRED'
   :error.code==='RATE_LIMITED'?'RATE_LIMITED':error.code==='FORBIDDEN'?'FORBIDDEN':'MFA_UNAVAILABLE';
  else if(error instanceof z.ZodError||error instanceof InvalidInputError||error instanceof SyntaxError)code=action==='password-mfa'?'MFA_CODE_INVALID':'FORBIDDEN';
  const failure=failures[code],response=json({code,error:failure.error},failure.status);
  if(code==='RATE_LIMITED')response.headers.set('Retry-After','60');
  return cookies?cookies.apply(response):response;
 }
}
