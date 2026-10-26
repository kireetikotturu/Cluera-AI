import {z} from 'zod';
import {accountClients} from '../accounts/clients';
import {AccountCookies} from '../accounts/cookies';
import {AccountError} from '../accounts/config';
import {activeSession,assertAccountOrigin,rateLimit} from '../accounts/handler';
import {stagingAccountConfig} from '../accounts/workspace';
import {json} from '../http';
import {apiKey,providerId,vaultKeyring} from './vault';
import {discoverModels,modelId} from './discovery';
import {listMetadata,metadataSchema,readSealed} from './repository';
import {operationContextSchema} from './publicMetadata';
import {verifyProviderOperation} from './operationStatus';
import {runProviderSetup} from './quickSetup';

const common={operationId:z.uuid(),provider:providerId,revision:z.number().int().min(0),factorId:z.uuid(),code:z.string().regex(/^\d{6}$/)};
const inputSchema=z.discriminatedUnion('action',[
 z.object({...common,action:z.literal('REPLACE'),apiKey}).strict(),
 z.object({...common,action:z.literal('TEST'),retry:z.literal(true).optional()}).strict(),
 z.object({...common,action:z.literal('CONFIGURE'),enabled:z.boolean(),defaultModel:modelId.nullable(),fallback:z.literal('NONE'),retry:z.literal(true).optional()}).strict(),
 z.object({...common,provider:z.enum(['gemini','deepgram']),action:z.literal('SETUP'),apiKey}).strict(),
]);
async function readBody(request:Request){
 const declared=Number(request.headers.get('content-length'));if(declared>8192||!request.body)throw new AccountError('INVALID_INPUT',400);
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0,timedOut=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;
  reject(new AccountError('INVALID_INPUT',400));void reader.cancel().catch(()=>{});
 },2000);});
 try{for(;;){const chunk=await Promise.race([reader.read(),expired]);if(timedOut)throw new AccountError('INVALID_INPUT',400);if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192)throw new AccountError('INVALID_INPUT',400);parts.push(chunk.value);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AccountError('INVALID_INPUT',400);}
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});
  try{reader.releaseLock();}catch{/* A non-settling cancel cannot extend the request deadline. */}}
}
/** Dedicated write-only endpoint. Every sensitive operation requires a NEW
 * authenticator challenge, Auth-verified same user/session and live SQL AAL2.
 * No role grant, enrollment, plaintext retrieval or provider generation. */
export async function providerAdminRequest(request:Request):Promise<Response>{
 let cookies:AccountCookies|undefined,mutationSubmitted=false,verificationRequested=false;
 try{
  const config=stagingAccountConfig();
  if(request.method!=='GET')assertAccountOrigin(request,config.origin);
  else if(request.headers.get('sec-fetch-site')==='cross-site'||(request.headers.has('origin')&&request.headers.get('origin')!==config.origin))throw new AccountError('FORBIDDEN',403);
  const clients=accountClients(config);cookies=new AccountCookies(request,config);
  const {account,session}=await activeSession(clients,cookies);
  if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
  const rpc=async(name:string,args:Record<string,unknown>):Promise<any>=>{const {data,error}=await clients.service.rpc(name,args);if(error)throw Error();return data;};
  const claims=()=>{try{return JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString('utf8'));}catch{return {};}};
  if(claims().aal!=='aal2'||await rpc('account_admin_check',{p_actor:account.userId,p_session:account.sessionId,p_require_mfa:true})!==true)throw new AccountError('FORBIDDEN',403);
  await rateLimit(request,config,clients,account.email);
  if(process.env.CLUERA_PROVIDER_VAULT_ENABLED!=='true')return cookies.apply(json({error:'VAULT_BOOTSTRAP_REQUIRED'},503));
  const vault=vaultKeyring();
  if(request.method==='GET'){
   const params=new URL(request.url).searchParams;
   if([...params.keys()].some(k=>!['operation','factors','provider','revision'].includes(k)||params.getAll(k).length!==1))throw new AccountError('INVALID_INPUT',400);
   if(params.has('factors')&&(params.size!==1||params.get('factors')!=='1'))throw new AccountError('INVALID_INPUT',400);
   if((params.has('provider')||params.has('revision'))&&(!params.has('operation')||!params.has('provider')||!params.has('revision')))throw new AccountError('INVALID_INPUT',400);
   if(params.get('factors')==='1'){
    const restored=await clients.auth.auth.setSession(session);if(restored.error)throw new AccountError('UNAVAILABLE',503);
    const factors=await clients.auth.auth.mfa.listFactors();if(factors.error)throw new AccountError('UNAVAILABLE',503);
    return cookies.apply(json({factors:factors.data.all.filter(f=>f.factor_type==='totp'&&f.status==='verified').map(f=>({id:f.id,status:'verified'}))}));
   }
   if(params.has('operation')){
    const op=z.uuid().parse(params.get('operation'));
    const revision=params.get('revision');
    if(revision!==null&&!/^(0|[1-9][0-9]{0,9})$/.test(revision))throw new AccountError('INVALID_INPUT',400);
    const context=params.has('provider')?operationContextSchema.parse({provider:params.get('provider'),revision:Number(revision)}):undefined;
    verificationRequested=true;
    return cookies.apply(json(await verifyProviderOperation(rpc,account.userId,account.sessionId,op,context)));
   }
   return cookies.apply(json(await listMetadata(rpc,account.userId,account.sessionId)));
  }
  if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'INVALID_INPUT'},400);
  const input=inputSchema.parse(await readBody(request));
  const restored=await clients.auth.auth.setSession(session);if(restored.error)throw new AccountError('UNAVAILABLE',503);
  const factors=await clients.auth.auth.mfa.listFactors();
  if(factors.error||!factors.data.all.some(f=>f.id===input.factorId&&f.factor_type==='totp'&&f.status==='verified'))throw new AccountError('FORBIDDEN',403);
  const step=await clients.auth.auth.mfa.challengeAndVerify({factorId:input.factorId,code:input.code});
  if(step.error)throw new AccountError('FORBIDDEN',403);
  const checked=await clients.auth.auth.getUser(step.data.access_token);
  let elevated:any;try{elevated=JSON.parse(Buffer.from(step.data.access_token.split('.')[1],'base64url').toString('utf8'));}catch{throw new AccountError('FORBIDDEN',403);}
  if(checked.error||checked.data.user?.id!==account.userId||!checked.data.user.email_confirmed_at||checked.data.user.is_anonymous||elevated.aal!=='aal2'||elevated.session_id!==account.sessionId)throw new AccountError('FORBIDDEN',403);
  const reauthenticatedAt=new Date().toISOString();
  cookies.set('access',step.data.access_token,Math.max(1,Math.min(step.data.expires_in-30,3570)));
  cookies.set('refresh',step.data.refresh_token,30*86400);
  if(input.action==='SETUP'){
   mutationSubmitted=true;
   const result=await runProviderSetup({provider:input.provider,revision:input.revision,apiKey:input.apiKey,operationId:input.operationId},
    {rpc,actor:account.userId,session:account.sessionId,reauthenticatedAt,digest:value=>vault.digest(value),seal:(key,binding)=>vault.seal(key,binding),
     discover:(provider,key)=>discoverModels(provider,key)});
   return cookies.apply(json(result));
  }
  const {code:_code,factorId:_factor,...operation}=input;
  // Recovery must have the same original digest. The retry marker grants no
  // authority and is excluded; every attempt above still requires fresh MFA.
  if('retry' in operation)delete operation.retry;
  const digest=vault.digest(JSON.stringify({actor:account.userId,session:account.sessionId,...operation}));
  const recovering=input.action!=='REPLACE'&&input.retry===true;
  if(recovering){
   verificationRequested=true;
   const status=await verifyProviderOperation(rpc,account.userId,account.sessionId,input.operationId,input);
   if(status.code!=='NOT_RECORDED')return cookies.apply(json(status));
  }
  let value:unknown;
  if(input.action==='REPLACE')value={credentialId:input.operationId,sealed:vault.seal(input.apiKey,{provider:input.provider,credentialId:input.operationId})};
  else if(input.action==='TEST'){
   const stored=await readSealed(rpc,input.provider);if(stored.revision!==input.revision)return cookies.apply(json({error:'CONFLICT'},409));
   const probe=await discoverModels(input.provider,vault.open(stored.sealed,{provider:input.provider,credentialId:stored.credential_id}));
   value=probe;
  }else value={enabled:input.enabled,defaultModel:input.defaultModel};
  mutationSubmitted=true;
  const result=await rpc('cluera_provider_mutate',{p_actor:account.userId,p_session:account.sessionId,p_operation:input.operationId,
   p_provider:input.provider,p_action:input.action,p_revision:input.revision,p_digest:digest,p_reauthenticated_at:reauthenticatedAt,p_input:value});
  if(recovering&&['APPLIED','CONFLICT','INVALID'].includes(result?.code)){
   const status=await verifyProviderOperation(rpc,account.userId,account.sessionId,input.operationId,input);
   if(status.code!=='NOT_RECORDED')return cookies.apply(json(status));
   // This retry was rejected. Do not assert that a delayed original could never
   // commit: a transaction may have started before probe expiry. The UI retains
   // the pending operation until audit/revision proof or a separately approved
   // metadata check advances the revision and fences the original settings.
   if(input.action==='CONFIGURE'&&result.code==='INVALID'&&status.metadata&&status.metadata.revision===input.revision)return cookies.apply(json({code:'REJECTED',operationId:input.operationId,metadata:status.metadata}));
   // A conflict with no same-actor audit/revision advancement proves neither
   // original completion nor permission to create a different operation.
   throw Error();
  }
  if(result?.code==='CONFLICT')return cookies.apply(json({error:'CONFLICT'},409));
  if(result?.code==='INVALID')return cookies.apply(json({error:'CHANGE_REJECTED'},409));
  if(result?.code==='FORBIDDEN')return cookies.apply(json({error:'FORBIDDEN'},403));
  if(result?.code!=='APPLIED')throw Error();
  return cookies.apply(json({code:'APPLIED',metadata:metadataSchema.parse(result.metadata)}));
 }catch(error){
  // A result/parser failure after submission cannot prove that SQL did not apply.
  // Preserve the operation lock so the browser verifies the immutable audit.
  const response=mutationSubmitted||(verificationRequested&&!(error instanceof AccountError))?json({error:'PROVIDER_SERVICE_UNAVAILABLE'},503):json({error:error instanceof AccountError?error.code:error instanceof z.ZodError?'INVALID_INPUT':'PROVIDER_SERVICE_UNAVAILABLE'},error instanceof AccountError?error.status:error instanceof z.ZodError?400:503);
  return cookies?cookies.apply(response):response;
 }
}
