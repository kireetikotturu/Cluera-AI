import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {accountClients} from '../../accounts/clients';
import {AccountCookies} from '../../accounts/cookies';
import {AccountError} from '../../accounts/config';
import {activeSession,rateLimit} from '../../accounts/handler';
import {stagingAccountConfig} from '../../accounts/workspace';
import {json} from '../../http';
import {billingOwner,billingRpc} from './config';
import {clueraAdminReportsEnabled} from './adminReports';
import {nativeCommandBoundary,nativeCommandsSqlSchema} from './adminNativeCommandContracts';

const endpoint='/api/account/admin/billing/cluera/native-commands';
const cursorSchema=z.object({viewer:z.string().regex(/^[a-f0-9]{64}$/),subject:z.uuid().nullable(),issuedAt:z.number().int().nonnegative(),before:nativeCommandBoundary}).strict();
function mac(value:string,key:Buffer){return createHmac('sha256',key).update('cluera-admin-native-command-cursor-v1\n').update(value).digest('base64url');}
export const adminNativeCommandsEnabled=(env=process.env)=>env.CLUERA_ADMIN_NATIVE_COMMANDS_READ_ENABLED==='true'&&clueraAdminReportsEnabled(env);
/** Retained native command observations only. Never claims, resolves, retries,
 * executes, changes evidence or calls a provider, even after lease expiry. */
export async function adminNativeCommandsRequest(request:Request):Promise<Response>{
 let cookies:AccountCookies|undefined;
 if(request.method!=='GET'||!adminNativeCommandsEnabled())return json({error:'Native command review is unavailable.'},404);
 try{
  const config=stagingAccountConfig(),url=new URL(request.url),query=url.searchParams;
  if(url.origin!==config.origin||url.pathname!==endpoint||request.headers.get('sec-fetch-site')==='cross-site'
   ||request.headers.has('origin')&&request.headers.get('origin')!==config.origin)throw new AccountError('FORBIDDEN',403);
  if([...query.keys()].some(key=>!['viewer','subject','cursor'].includes(key)||query.getAll(key).length!==1))throw new AccountError('INVALID_INPUT',400);
  const clients=accountClients(config);cookies=new AccountCookies(request,config);
  const {account,session}=await activeSession(clients,cookies);
  if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
  let aal2=false;try{aal2=JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString()).aal==='aal2';}catch{/* fail closed */}
  const rpc=(name:string,args:Record<string,unknown>)=>clients.service.rpc(name,args),admin={p_actor:account.userId,p_session:account.sessionId};
  if(!aal2||await billingRpc(rpc,'account_admin_check',{...admin,p_require_mfa:true})!==true)throw new AccountError('FORBIDDEN',403);
  await rateLimit(request,config,clients,account.email);
  const viewer=createHmac('sha256',config.rateKey).update(['cluera-admin-native-command-viewer-v1',config.origin,config.url,account.userId,account.sessionId,'aal2'].join('\n')).digest('hex');
  if(query.size===0)return cookies.apply(json({code:'ACTIVE',viewer}));
  if(query.get('viewer')!==viewer)throw new AccountError('FORBIDDEN',403);
  const subject=query.has('subject')?z.uuid().parse(query.get('subject')):null;
  let old:z.infer<typeof cursorSchema>|null=null;
  if(query.has('cursor')){
   const value=query.get('cursor')!;if(value.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))throw new AccountError('INVALID_INPUT',400);
   const [text,signature]=value.split('.'),actual=Buffer.from(signature),expected=Buffer.from(mac(text,config.rateKey));
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new AccountError('INVALID_INPUT',400);
   old=cursorSchema.parse(JSON.parse(Buffer.from(text,'base64url').toString('utf8')));
   if(old.issuedAt>Date.now()+5000||old.issuedAt<Date.now()-900000)throw new AccountError('INVALID_INPUT',400);
   if(old.viewer!==viewer||old.subject!==subject)throw new AccountError('FORBIDDEN',403);
  }
  const owner=await billingOwner(rpc),raw=await billingRpc(rpc,'cluera_billing_admin_native_commands',{...admin,p_account_digest:owner.accountDigest,p_epoch:owner.epoch,
   p_subject:subject,p_after_created:old?.before.createdAt??null,p_after_id:old?.before.id??null});
  const parsed=nativeCommandsSqlSchema.safeParse(raw);if(!parsed.success||parsed.data.subject!==subject)throw new AccountError('UNAVAILABLE',503);
  const {hasMore:_more,before,...report}=parsed.data;
  let nextCursor:string|null=null;if(before){const text=Buffer.from(JSON.stringify({viewer,subject,issuedAt:old?.issuedAt??Date.now(),before})).toString('base64url');nextCursor=`${text}.${mac(text,config.rateKey)}`;}
  return cookies.apply(json({...report,viewer,nextCursor}));
 }catch(error){
  const status=error instanceof AccountError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:503;
  if(status===401)cookies?.clear();const response=json({error:status===401||status===403?'Current Admin access and MFA are required.'
   :status===400?'The native command review request is invalid.':status===429?'Please wait before refreshing native command review.':'Native command review is unavailable.'},status);
  return cookies?cookies.apply(response):response;
 }
}
