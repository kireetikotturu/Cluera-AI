import {z} from 'zod';
import type {AccountCredits} from '../../../desktop/src/shared/accountCredits';
import {AccountError} from './config';
import {SupabaseOperationError} from '../supabase/diagnostics';
import {sandboxCheckoutAllowed} from '../billing/checkout/gate';
import {stagingAccountConfig} from './workspace';
import {accountClients} from './clients';
import {AccountCookies} from './cookies';
import {activeSession,rateLimit} from './handler';
import {json,apiError} from '../http';
import {razorpayCheckoutAllowed} from '../payments/core/config';
import {paymentStatus} from '../payments/checkout/service';
import {clueraBillingStatus} from '../payments/cluera/checkout';
import {clueraCheckoutAllowed} from '../payments/cluera/config';
import {billingUiEnvironment} from '../payments/cluera/billingUi';
import {liveBillingProfile,liveBillingRpc} from '../payments/cluera/modeProfile';
const ms=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema=z.object({userId:z.uuid(),serverTime:z.iso.datetime({offset:true}),displayName:z.string().max(80),
 availableMilliseconds:ms,reservedMilliseconds:ms,spentMilliseconds:ms,
 buckets:z.array(z.object({kind:z.enum(['TRIAL','RECURRING','PACK','TEST','MANUAL']),grantedMilliseconds:ms,spentMilliseconds:ms,reservedMilliseconds:ms,availableMilliseconds:ms}).strict()).max(5),
 plans:z.array(z.object({tier:z.enum(['PRO','ENTERPRISE']),state:z.enum(['ACTIVE','QUEUED','PAUSED','ENDED','REFUNDED']),
  paymentState:z.enum(['ACTIVE','PAST_DUE','CANCELED','PAUSED']),endsAt:z.iso.datetime({offset:true}).nullable(),cancelFuture:z.boolean()}).strict()).max(30),
 payments:z.array(z.object({offerCode:z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly',
  'cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2']),
  state:z.enum(['CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED']),createdAt:z.iso.datetime({offset:true})}).strict()).max(10),
}).strict();
// Internal read capability only; identifiers and transaction IDs never enter
// the existing renderer-safe credit DTO or grant access to paid operations.
const lockSchema=z.union([
 z.object({code:z.enum(['NOT_FOUND','PENDING'])}).strict(),
 z.object({code:z.literal('BOUND'),intentId:z.uuid(),offerCode:z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly']),
  transactionId:z.string().regex(/^txn_[a-z0-9]{26}$/)}).strict(),
]);
type Rpc=(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown;status?:number}>;
export async function readCredits(rpc:Rpc,account:{userId:string;sessionId:string}):Promise<AccountCredits>{
 const clueraV2=process.env.CLUERA_BILLING_V2_ENABLED==='true';
 const env=clueraV2?billingUiEnvironment():process.env,live=clueraV2?liveBillingProfile(env):undefined;
 const {data,error,status}=await rpc(live?'cluera_billing_credits_for_mode':clueraV2?'cluera_credits_read':'customer_credits_read',
  {p_user:account.userId,p_session:account.sessionId,...(live?{p_mode:'live'}:{})});
 if(error)throw new SupabaseOperationError('account.usage',error,status);
 const code=(data as {code?:string}|null)?.code;
 if(code==='UNAUTHENTICATED')throw new AccountError('UNAUTHENTICATED',401);
 if(code==='SUSPENDED'||code==='FORBIDDEN')throw new AccountError('FORBIDDEN',403);
 const parsed=schema.safeParse(data);
 if(!parsed.success||parsed.data.userId!==account.userId)throw new AccountError('UNAVAILABLE',503);
 if(clueraV2){
  const eligible=clueraCheckoutAllowed(account.userId,env);
  const payment=eligible?await clueraBillingStatus(live?liveBillingRpc(rpc):rpc,account):null;
  return {...parsed.data,checkoutAvailable:eligible&&payment?.code==='AVAILABLE'};
 }
 if(process.env.SIGMAROUND_PAYMENT_PROVIDER==='razorpay'){
  const eligible=razorpayCheckoutAllowed(account.userId);
  // Legacy Paddle history is preserved, but its disabled adapter cannot be
  // used to bypass or create a new Razorpay operation. Only the NEW service's
  // authoritative full-history read controls its own checkout eligibility.
  const status=eligible?await paymentStatus(rpc,account):null;
  return {...parsed.data,checkoutAvailable:eligible&&status?.code==='AVAILABLE'};
 }
 // A reload or another device must not offer a new purchase while an existing
 // attempt is unresolved. SQL still owns the final concurrent transaction lock.
 const pending=parsed.data.payments.some(payment=>['CREATING','BOUND','UNCERTAIN'].includes(payment.state));
 const eligible=sandboxCheckoutAllowed(account.userId);
 let fullHistoryPending=false;
 if(eligible){
  // The ten displayed history rows are not an eligibility query. An older
  // unresolved attempt must still block even when newer failed history fills
  // that display window. This account-locked read does not create or settle AI
  // usage, resolve checkout, contact Paddle or change paid attribution.
  const result=await rpc('customer_checkout_resume_read',{p_user_id:account.userId,p_session_id:account.sessionId});
  if(result.error)throw new SupabaseOperationError('account.usage',result.error,result.status);
  const lockCode=(result.data as {code?:string}|null)?.code;
  if(lockCode==='UNAUTHENTICATED')throw new AccountError('UNAUTHENTICATED',401);
  if(lockCode==='SUSPENDED'||lockCode==='FORBIDDEN')throw new AccountError('FORBIDDEN',403);
  const lock=lockSchema.safeParse(result.data);
  if(!lock.success)throw new AccountError('UNAVAILABLE',503);
  fullHistoryPending=lock.data.code!=='NOT_FOUND';
 }
 return {...parsed.data,checkoutAvailable:eligible&&!pending&&!fullHistoryPending};
}
export async function creditsRequest(request:Request):Promise<Response>{
 try{
  const config=stagingAccountConfig(),clients=accountClients(config),cookies=new AccountCookies(request,config);
  const {account}=await activeSession(clients,cookies);
  if(cookies.get('recovery')===account.sessionId)return cookies.apply(json({error:'FORBIDDEN',code:'RECOVERY_SESSION'},403));
  const expected=new URL(request.url).searchParams.get('desktopAccount');
  if(expected!==null&&expected!==account.userId)return cookies.apply(json({error:'FORBIDDEN',code:'ACCOUNT_MISMATCH'},403));
  await rateLimit(request,config,clients);
  return cookies.apply(json(await readCredits((name,args)=>clients.service.rpc(name,args),account)));
 }catch(error){return error instanceof AccountError?json({error:error.code},error.status):apiError(error);}
}
