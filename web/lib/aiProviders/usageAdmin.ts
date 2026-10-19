import {accountClients} from '../accounts/clients';
import {AccountCookies} from '../accounts/cookies';
import {AccountError} from '../accounts/config';
import {activeSession,rateLimit} from '../accounts/handler';
import {stagingAccountConfig} from '../accounts/workspace';
import {json} from '../http';
import {providerUsageReportSchema} from './usageMetadata';
/** Metadata read only. Current Auth, live SQL Admin/AAL2 and non-recovery mode
 * are required even while collection is disabled. No provider/key access. */
export async function providerUsageAdminRequest(request:Request):Promise<Response>{
 let cookies:AccountCookies|undefined;
 try{
  if(request.method!=='GET'||new URL(request.url).searchParams.size)return json({error:'Not found.'},404);
  const config=stagingAccountConfig();
  if(request.headers.get('sec-fetch-site')==='cross-site'||request.headers.has('origin')&&request.headers.get('origin')!==config.origin)throw new AccountError('FORBIDDEN',403);
  const clients=accountClients(config);cookies=new AccountCookies(request,config);
  const {account,session}=await activeSession(clients,cookies);
  if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
  let aal:string|undefined;
  try{aal=JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString()).aal;}catch{/* deny below */}
  if(aal!=='aal2')throw new AccountError('FORBIDDEN',403);
  const args={p_actor:account.userId,p_session:account.sessionId};
  const role=await clients.service.rpc('account_admin_check',{...args,p_require_mfa:true});
  if(role.error)throw new AccountError('UNAVAILABLE',503);
  if(role.data!==true)throw new AccountError('FORBIDDEN',403);
  await rateLimit(request,config,clients,account.email);
  if(process.env.CLUERA_PROVIDER_USAGE_READ_ENABLED!=='true')return cookies.apply(json({error:'USAGE_READ_NOT_ENABLED'},503));
  const result=await clients.service.rpc('cluera_provider_usage_admin_read',args);
  if(result.error)throw new AccountError('UNAVAILABLE',503);
  return cookies.apply(json(providerUsageReportSchema.parse(result.data)));
 }catch(error){
  const status=error instanceof AccountError?error.status:503;
  const response=json({error:status===401?'UNAUTHENTICATED':status===403?'FORBIDDEN':status===429?'RATE_LIMITED':'TELEMETRY_UNAVAILABLE'},status);
  return cookies?cookies.apply(response):response;
 }
}
