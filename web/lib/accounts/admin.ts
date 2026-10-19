import {z} from 'zod';
import {accountClients} from './clients';
import {AccountCookies} from './cookies';
import {AccountError} from './config';
import {activeSession,assertAccountOrigin,rateLimit,authFailure,authorizeCustomer,saveSession} from './handler';
import {stagingAccountConfig} from './workspace';
import {apiError,json,readJsonBody} from '../http';
import {SupabaseOperationError} from '../supabase/diagnostics';
import {sandboxOffers} from '../billing/sandboxCatalog';
import {accountModelPolicy} from './modelPolicy';
import {readProviderStatus} from './providerStatus';
import {accountReleaseInput,accountReleasePublish,accountReleaseSigningKey} from './releases';
import {assertTrustedInstallerUrl} from '../releases/policy';
import {ReleaseInputError,releaseValidationCode,logReleaseDiagnostic} from './releaseDiagnostics';
import {adminReadFailure} from './adminReadDiagnostics';

const model=accountModelPolicy;
const mutation=z.object({action:z.enum(['SUSPEND','REACTIVATE','GRANT_TEST','REVOKE_TEST','MODEL','ADD_MINUTES','REMOVE_MINUTES','CATALOG','RELEASE_DRAFT','RELEASE_PUBLISH','RELEASE_WITHDRAW']),operationId:z.uuid(),
 subjectId:z.uuid().nullable(),reason:z.string().trim().min(10).max(500),input:z.unknown()}).strict();
/** Staging BFF administration. Live session + explicit allowlist + AAL2 are
 * independently checked by SQL; customer metadata never defines authority. */
export async function accountAdminRequest(request:Request):Promise<Response>{
 let releaseAction:string|undefined,stage='authorization',cookies:AccountCookies|undefined;
 try{
  const config=stagingAccountConfig();if(request.method!=='GET')assertAccountOrigin(request,config.origin);
  const clients=accountClients(config);cookies=new AccountCookies(request,config);
  const {account,session}=await activeSession(clients,cookies);
  if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
  const rpc=async(name:string,args:Record<string,unknown>)=>{
   const {data,error,status}=await clients.service.rpc(name,args);if(error)throw new SupabaseOperationError('account.admin',error,status);return data;
  };
  const adminArgs={p_actor:account.userId,p_session:account.sessionId};
  stage='admin_check';if(await rpc('account_admin_check',{...adminArgs,p_require_mfa:false})!==true)throw new AccountError('FORBIDDEN',403);
  stage='session_restore';const restored=await clients.auth.auth.setSession(session);
  if(restored.error||!restored.data?.session)throw authFailure(restored.error);
  // setSession may refresh across the expiry boundary. Persist that rotation
  // only after validating the original owner/session, before any MFA action.
  const current=restored.data.session;
  if(current.access_token!==session.access_token||current.refresh_token!==session.refresh_token){
   const restoredAccount=await authorizeCustomer(clients,current.access_token,{userId:account.userId,sessionId:account.sessionId});
   saveSession(cookies,current,restoredAccount);
  }
  // activeSession already validates the token with Auth. Require this token's
  // AAL2 claim as well as the live database session: an older AAL1 token must
  // not gain admin access merely because the same session completed MFA later.
  let tokenAal2=false;
  try{tokenAal2=JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString()).aal==='aal2';}catch{/* fail closed */}
  stage='mfa_check';const allowed=tokenAal2&&await rpc('account_admin_check',{...adminArgs,p_require_mfa:true})===true;
  if(request.method==='GET'){
   if(!allowed){
    const factors=await clients.auth.auth.mfa.listFactors();if(factors.error)throw new AccountError('UNAVAILABLE',503);
    return cookies.apply(json({needsMfa:true,factors:factors.data.all.filter(f=>f.factor_type==='totp').map(f=>({id:f.id,status:f.status}))}));
   }
   const params=new URL(request.url).searchParams;
   if(params.get('releases')==='1'){
    stage='releases';
    const data=await rpc('cluera_release_admin',{...adminArgs,p_action:'LIST'});
    if(data?.code!=='ACTIVE')throw new AccountError('FORBIDDEN',403);
    return cookies.apply(json(data));
   }
   if(params.get('providers')==='1'){
    stage='providers';
    await rateLimit(request,config,clients,account.email);
    return cookies.apply(json({providerStatus:await readProviderStatus(config)}));
   }
   stage='read_query';const subject=z.uuid().nullable().parse(params.get('subject'));
   const query=z.string().trim().max(254).parse(params.get('query')??'');
   const before=z.iso.datetime({offset:true}).nullable().parse(params.get('before'));
   const beforeId=z.uuid().nullable().parse(params.get('beforeId'));
   if(Boolean(before)!==Boolean(beforeId))throw new AccountError('FORBIDDEN',403);
   stage='read_rpc';const data=await rpc('account_admin_read_v2',{...adminArgs,p_subject:subject,p_query:query,p_before:before,p_before_id:beforeId});
   if(data?.code!=='ACTIVE')throw new AccountError('FORBIDDEN',403);
   stage='catalog';const catalog=(data.catalog??[]).map((policy:{code:string;name:string;enabled:boolean;priority:number})=>{
    const offer=sandboxOffers.find(o=>o.code===policy.code);if(!offer)throw new AccountError('UNAVAILABLE',503);
    return {...policy,tier:offer.tier,priceId:offer.priceId,amount:offer.amount,currency:offer.currency,seconds:offer.seconds,interval:offer.interval};
   });
   return cookies.apply(json({...data,catalog,providers:[{provider:'gemini',state:'EXTERNAL_MANAGED',rotationAvailable:false},{provider:'deepgram',state:'EXTERNAL_MANAGED',rotationAvailable:false}],
    testEntitlementsEnabled:process.env.SIGMAROUND_ACCOUNT_TEST_ENTITLEMENTS_ENABLED==='true'}));
  }
  if(request.method!=='POST')return cookies.apply(json({error:'Not found.'},404));
  await rateLimit(request,config,clients,account.email);
  stage='read_body';const raw=await readJsonBody(request,8192);
  const action=z.object({action:z.string()}).parse(raw).action;
  if(['RELEASE_DRAFT','RELEASE_PUBLISH','RELEASE_WITHDRAW'].includes(action))releaseAction=action;
  if(['MFA_ENROLL','MFA_VERIFY','MFA_CANCEL'].includes(action)){
   const factors=await clients.auth.auth.mfa.listFactors();if(factors.error)throw new AccountError('UNAVAILABLE',503);
   const totp=factors.data.all.filter(f=>f.factor_type==='totp');
   if(action==='MFA_ENROLL'){
    z.object({action:z.literal('MFA_ENROLL')}).strict().parse(raw);
    if(totp.length)throw new AccountError('FORBIDDEN',403); // explicit recovery, never render-driven duplicate enrollment
    const enrolled=await clients.auth.auth.mfa.enroll({factorType:'totp'});if(enrolled.error)throw new AccountError('UNAVAILABLE',503);
    return cookies.apply(json({enrollment:{id:enrolled.data.id,qr:enrolled.data.totp.qr_code,secret:enrolled.data.totp.secret}}));
   }
   const input=z.object({action:z.enum(['MFA_VERIFY','MFA_CANCEL']),factorId:z.uuid(),code:z.string().regex(/^\d{6}$/).optional()}).strict().parse(raw);
   const factor=totp.find(f=>f.id===input.factorId);if(!factor)throw new AccountError('FORBIDDEN',403);
   if(action==='MFA_CANCEL'){
    if(factor.status!=='unverified')throw new AccountError('FORBIDDEN',403);
    const removed=await clients.auth.auth.mfa.unenroll({factorId:factor.id});if(removed.error)throw new AccountError('UNAVAILABLE',503);
    return cookies.apply(json({ok:true}));
   }
   if(!input.code)throw new AccountError('FORBIDDEN',403);
   const verified=await clients.auth.auth.mfa.challengeAndVerify({factorId:factor.id,code:input.code});
   if(verified.error||!verified.data)throw new AccountError('FORBIDDEN',403);
   const verifiedAccount=await authorizeCustomer(clients,verified.data.access_token,{userId:account.userId,sessionId:account.sessionId});
   let verifiedAal2=false;
   try{verifiedAal2=JSON.parse(Buffer.from(verified.data.access_token.split('.')[1],'base64url').toString()).aal==='aal2';}catch{/* fail closed */}
   if(!verifiedAal2)throw new AccountError('FORBIDDEN',403);
   saveSession(cookies,verified.data,verifiedAccount);
   // The following GET revalidates both JWT/session and SQL AAL2 before exposing admin data.
   return cookies.apply(json({ok:true}));
  }
  if(!allowed){if(releaseAction){logReleaseDiagnostic('authorization',releaseAction,'FORBIDDEN');return cookies.apply(json({error:'RELEASE_MFA_REQUIRED'},403));}throw new AccountError('FORBIDDEN',403);}
  stage='validation';
  const input=mutation.parse(raw);let values:object;
  if(input.action.startsWith('RELEASE_')){
   if(input.subjectId!==null)throw new AccountError('FORBIDDEN',403);
   const action=input.action.slice(8);
   if(action==='DRAFT'){
    values=accountReleaseInput.parse(input.input);
    try{assertTrustedInstallerUrl((values as {downloadUrl:string}).downloadUrl);}catch{throw new ReleaseInputError('RELEASE_ORIGIN_DENIED');}
   }
   else if(action==='PUBLISH'){values=accountReleasePublish.parse(input.input);stage='signing';accountReleaseSigningKey();}
   else values=z.object({id:z.uuid()}).strict().parse(input.input);
   stage='release_rpc';
   const result=await rpc('cluera_release_admin',{...adminArgs,p_action:action,p_operation:input.operationId,p_reason:input.reason,p_input:values});
   if(result?.code==='APPLIED')return cookies.apply(json(result));
   logReleaseDiagnostic(stage,releaseAction,result?.code);
   const errors:Record<string,string>={INVALID:'RELEASE_DATABASE_INVALID',CONFLICT:'RELEASE_CONFLICT',NOT_FOUND:'RELEASE_NOT_FOUND',FORBIDDEN:'RELEASE_MFA_REQUIRED'};
   const error=errors[result?.code];
   return cookies.apply(json({error:error??'RELEASE_SERVICE_UNAVAILABLE'},error?(result.code==='FORBIDDEN'?403:409):503));
  }
  if(input.action==='MODEL'){
   if(input.subjectId!==null)throw new AccountError('FORBIDDEN',403);values=model.parse(input.input);
  }else if(input.action==='CATALOG'){
   if(input.subjectId!==null)throw new AccountError('FORBIDDEN',403);
   values=z.object({code:z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly']),name:z.string().trim().min(2).max(80),enabled:z.boolean(),priority:z.number().int().min(0).max(1000)}).strict().parse(input.input);
  }else{
   if(!input.subjectId)throw new AccountError('FORBIDDEN',403);
   if(input.action==='GRANT_TEST'){
    if(process.env.SIGMAROUND_ACCOUNT_TEST_ENTITLEMENTS_ENABLED!=='true')throw new AccountError('FORBIDDEN',403);
    values={...z.object({minutes:z.number().int().min(1).max(6000)}).strict().parse(input.input),environment:'account-staging'};
   }else if(input.action==='ADD_MINUTES')values=z.object({minutes:z.number().int().min(1).max(60000)}).strict().parse(input.input);
   else if(input.action==='REMOVE_MINUTES')values=z.object({minutes:z.number().int().min(1).max(60000),grantId:z.uuid()}).strict().parse(input.input);
   else if(input.action==='REVOKE_TEST')values=z.object({grantId:z.uuid()}).strict().parse(input.input);
   else values=z.object({}).strict().parse(input.input);
  }
  const result=await rpc(['ADD_MINUTES','REMOVE_MINUTES','CATALOG'].includes(input.action)?'account_admin_adjust':'account_admin_mutate',{...adminArgs,p_operation:input.operationId,p_subject:input.subjectId,
   p_action:input.action,p_reason:input.reason,p_input:values});
  return cookies.apply(json(result,result?.code==='APPLIED'?200:409));
 }catch(error){
  if(request.method==='GET'){
   const failure=adminReadFailure(error,stage);
   if(failure.status===401)cookies?.clear();
   const response=json({error:failure.error},failure.status);
   return cookies?cookies.apply(response):response;
  }
  if(request.method==='POST')logReleaseDiagnostic(stage,releaseAction,undefined,error);
  if(releaseAction){
   const response=error instanceof z.ZodError?json({error:releaseValidationCode(error)},400)
    :error instanceof ReleaseInputError?json({error:error.code},400)
    :error instanceof AccountError?json({error:error.code==='UNAVAILABLE'?'RELEASE_SERVICE_UNAVAILABLE':error.code},error.status)
    :json({error:'RELEASE_SERVICE_UNAVAILABLE'},503);
   return cookies?cookies.apply(response):response;
  }
  const response=error instanceof AccountError?json({error:error.code},error.status):apiError(error);
  return cookies?cookies.apply(response):response;
 }
}
