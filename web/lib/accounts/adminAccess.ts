import {createHmac} from 'node:crypto';
import {accountClients} from './clients';
import {AccountCookies} from './cookies';
import {AccountError} from './config';
import {activeSession,authorizeCustomer} from './handler';
import {stagingAccountConfig} from './workspace';
import {json} from '../http';

/** Role metadata only. Never authorize from an email or browser-supplied role. */
export async function accountAdminAccessRequest(request:Request,refresh=true):Promise<Response>{
 let cookies:AccountCookies|undefined;
 try{
  if(request.method!=='GET'||new URL(request.url).searchParams.size)return json({error:'Not found.'},404);
  const config=stagingAccountConfig();
  if(request.headers.get('sec-fetch-site')==='cross-site'
   ||request.headers.has('origin')&&request.headers.get('origin')!==config.origin)return json({error:'This action is not allowed.'},403);
  cookies=new AccountCookies(request,config);
  const token=cookies.get('access');
  if(!refresh&&typeof token!=='string')return cookies.apply(json({error:'Sign in to continue.'},401));
  const clients=accountClients(config);
  const current=refresh?await activeSession(clients,cookies):{
   account:await authorizeCustomer(clients,token as string),session:{access_token:token as string},
  };
  if(cookies.get('recovery')===current.account.sessionId)throw new AccountError('FORBIDDEN',403);
  const args={p_actor:current.account.userId,p_session:current.account.sessionId};
  const role=await clients.service.rpc('account_admin_check',{...args,p_require_mfa:false});
  if(role.error)throw new AccountError('UNAVAILABLE',503);
  if(role.data!==true)throw new AccountError('FORBIDDEN',403);
  let tokenAal2=false;
  try{tokenAal2=JSON.parse(Buffer.from(current.session.access_token.split('.')[1],'base64url').toString()).aal==='aal2';}catch{/* fail closed */}
  let mfaVerified=false;
  if(tokenAal2){
   const mfa=await clients.service.rpc('account_admin_check',{...args,p_require_mfa:true});
   if(mfa.error)throw new AccountError('UNAVAILABLE',503);
   mfaVerified=mfa.data===true;
  }
  // Memory-only UI retention fence; no API accepts this as authority.
  const navigationSession=createHmac('sha256',config.rateKey).update(['cluera-admin-navigation-v1',
   config.origin,config.url,current.account.userId,current.account.sessionId,mfaVerified?'aal2':'aal1'].join('\n')).digest('hex');
  return cookies.apply(json({admin:true,mfaVerified,navigationSession}));
 }catch(error){
  const status=error instanceof AccountError&&(error.status===401||error.status===403)?error.status:503;
  const response=json({error:status===401?'Sign in to continue.':status===403?'This action is not allowed.':'Access verification is unavailable.'},status);
  return cookies?cookies.apply(response):response;
 }
}
