import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {accountClients} from '../../accounts/clients';
import {AccountCookies} from '../../accounts/cookies';
import {AccountError} from '../../accounts/config';
import {activeSession,rateLimit} from '../../accounts/handler';
import {stagingAccountConfig} from '../../accounts/workspace';
import {json} from '../../http';
import {assertPaymentStaging} from '../core/config';
import {billingOwner,billingRpc,clueraBillingV2Enabled} from './config';
import {financialReportSqlSchema,reportBoundary,reportTimestamp} from './adminReportContracts';

const endpoint='/api/account/admin/billing/cluera/report',day=86_400_000;
export function clueraAdminReportsEnabled(env=process.env){
 if(env.CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED!=='true'||!clueraBillingV2Enabled(env))return false;
 try{assertPaymentStaging(env);}catch{return false;}
 return(!env.VERCEL_ENV||env.VERCEL_ENV==='production')&&(!env.VERCEL_TARGET_ENV||env.VERCEL_TARGET_ENV==='production')
  &&(!env.VERCEL_PROJECT_ID||env.VERCEL_PROJECT_ID==='prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B')
  &&(!env.VERCEL_ORG_ID||env.VERCEL_ORG_ID==='team_AksnPXhi2VBXI5UsY2xBIakc');
}
const cursorSchema=z.object({version:z.literal(1),viewer:z.string().regex(/^[a-f0-9]{64}$/),
 from:reportTimestamp,to:reportTimestamp,subject:z.uuid().nullable(),issuedAt:z.number().int().nonnegative(),before:reportBoundary}).strict();
function mac(value:string,key:Buffer){return createHmac('sha256',key).update('cluera-financial-report-v1\n').update(value).digest('base64url');}
function sign(value:z.infer<typeof cursorSchema>,key:Buffer){const text=Buffer.from(JSON.stringify(value)).toString('base64url');return `${text}.${mac(text,key)}`;}
function cursor(value:string,key:Buffer){
 if(value.length>2048||!value.match(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/))throw new AccountError('INVALID_INPUT',400);
 const [text,signature]=value.split('.'),expected=mac(text,key),actual=Buffer.from(signature),wanted=Buffer.from(expected);
 if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))throw new AccountError('INVALID_INPUT',400);
 const result=cursorSchema.parse(JSON.parse(Buffer.from(text,'base64url').toString('utf8')));
 if(result.issuedAt>Date.now()+5000||result.issuedAt<Date.now()-15*60_000)throw new AccountError('INVALID_INPUT',400);
 return result;
}
/** GET-only reports. An opaque viewer/cursor fences the same verified Admin
 * session; neither is authorization. SQL independently requires live Admin+AAL2.
 * This route never restores MFA, calls a provider or changes financial rows. */
export async function clueraAdminFinancialReportRequest(request:Request):Promise<Response>{
 let cookies:AccountCookies|undefined;
 if(request.method!=='GET'||!clueraAdminReportsEnabled())return json({error:'Financial reports are unavailable.'},404);
 try{
  const config=stagingAccountConfig(),url=new URL(request.url),params=url.searchParams;
  if(url.origin!==config.origin||url.pathname!==endpoint||request.headers.get('sec-fetch-site')==='cross-site'
   ||request.headers.has('origin')&&request.headers.get('origin')!==config.origin)throw new AccountError('FORBIDDEN',403);
  const keys=['viewer','from','to','subject','cursor'];
  if([...params.keys()].some(key=>!keys.includes(key)||params.getAll(key).length!==1))throw new AccountError('INVALID_INPUT',400);
  const clients=accountClients(config);cookies=new AccountCookies(request,config);
  const {account,session}=await activeSession(clients,cookies);
  if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
  let aal2=false;try{aal2=JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url').toString()).aal==='aal2';}catch{/* fail closed */}
  const rpc=(name:string,args:Record<string,unknown>)=>clients.service.rpc(name,args),admin={p_actor:account.userId,p_session:account.sessionId};
  if(!aal2||await billingRpc(rpc,'account_admin_check',{...admin,p_require_mfa:true})!==true)throw new AccountError('FORBIDDEN',403);
  await rateLimit(request,config,clients,account.email);
  const viewer=createHmac('sha256',config.rateKey).update(['cluera-financial-viewer-v1',config.origin,config.url,account.userId,account.sessionId,'aal2'].join('\n')).digest('hex');
  if(params.size===0)return cookies.apply(json({code:'ACTIVE',viewer}));
  if(params.get('viewer')!==viewer)throw new AccountError('FORBIDDEN',403);
  const from=reportTimestamp.parse(params.get('from')),to=reportTimestamp.parse(params.get('to'));
  const start=Date.parse(from),end=Date.parse(to),subject=params.has('subject')?z.uuid().parse(params.get('subject')):null;
  if(start<Date.UTC(2000,0,1)||end<=start||end-start>31*day||end>Date.now()+5000)throw new AccountError('INVALID_INPUT',400);
  const old=params.has('cursor')?cursor(params.get('cursor')!,config.rateKey):null;
  if(old&&(old.viewer!==viewer||old.from!==from||old.to!==to||old.subject!==subject))throw new AccountError('FORBIDDEN',403);
  const owner=await billingOwner(rpc),before=old?.before;
  const parsed=financialReportSqlSchema.safeParse(await billingRpc(rpc,'cluera_billing_admin_report',{...admin,
   p_account_digest:owner.accountDigest,p_epoch:owner.epoch,p_from:from,p_to:to,p_subject:subject,
   p_before_created:before?.createdAt??null,p_before_intent:before?.intentId??null,p_before_payment:before?.paymentId??null}));
  if(!parsed.success)throw new AccountError('UNAVAILABLE',503);
  const report=parsed.data;
  if(Date.parse(report.from)!==start||Date.parse(report.to)!==end||report.subject!==subject)throw new AccountError('UNAVAILABLE',503);
  const {hasMore:_hasMore,before:next,...publicReport}=report;
  const nextCursor=next?sign({version:1,viewer,from,to,subject,issuedAt:old?.issuedAt??Date.now(),before:next},config.rateKey):null;
  return cookies.apply(json({...publicReport,from,to,viewer,nextCursor}));
 }catch(error){
  const status=error instanceof AccountError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:503;
  if(status===401)cookies?.clear();
  const response=json({error:status===401?'Sign in to view financial reports.':status===403?'Financial report access was denied.'
   :status===400?'The financial report request is invalid.':status===429?'Please wait before refreshing financial reports.':'Financial reports are unavailable.'},status);
  return cookies?cookies.apply(response):response;
 }
}
