import { z } from 'zod';
import { AccountError } from '../../accounts/config';
import { SupabaseOperationError } from '../../supabase/diagnostics';
import { readSandboxResource } from '../paddle';
import { verifySandboxPrice } from '../sandboxCatalog';
import { assertCheckoutStaging } from './service';

type Rpc=(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown;status?:number}>;
const identity=z.object({userId:z.uuid(),sessionId:z.uuid()});
const offerCode=z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly']);
const bound=z.object({code:z.literal('BOUND'),intentId:z.uuid(),offerCode,transactionId:z.string().regex(/^txn_[a-z0-9]{26}$/)}).strict();
const denial=z.object({code:z.enum(['NOT_FOUND','PENDING','UNAUTHENTICATED','SUSPENDED'])}).strict();
const unpaid=z.object({id:z.string(),status:z.enum(['draft','ready']),collection_mode:z.literal('automatic'),currency_code:z.literal('INR'),
  custom_data:z.object({sigma_checkout_intent:z.uuid()}),subscription_id:z.null(),billed_at:z.null(),discount_id:z.null(),
  payments:z.array(z.unknown()).max(0),checkout:z.object({url:z.string().max(2048)}),
  items:z.array(z.object({quantity:z.literal(1),price:z.object({id:z.string(),product_id:z.string(),
    unit_price:z.object({amount:z.string(),currency_code:z.literal('INR')})})})).length(1),
});

/** Read an existing owned unpaid transaction, never create/recover/reconcile one.
 * The browser receives no provider URL, payer data or capability to pick a txn.
 * A second canonical read fences settlement/account changes during provider GETs.
 */
export async function resumeSandboxCheckout(rpc:Rpc,verifiedIdentity:z.infer<typeof identity>,env=process.env,deps:{
  price?:typeof verifySandboxPrice;read?:typeof readSandboxResource;
}={}) {
  assertCheckoutStaging(env);
  const who=identity.parse(verifiedIdentity),args={p_user_id:who.userId,p_session_id:who.sessionId};
  const canonical=async()=>{
    const {data,error,status}=await rpc('customer_checkout_resume_read',args);
    if(error)throw new SupabaseOperationError('billing.checkout',error,status);
    const match=bound.safeParse(data);if(match.success)return match.data;
    const other=denial.safeParse(data);if(!other.success)throw new AccountError('UNAVAILABLE',503);
    if(other.data.code==='UNAUTHENTICATED')throw new AccountError('UNAUTHENTICATED',401);
    if(other.data.code==='SUSPENDED')throw new AccountError('FORBIDDEN',403);
    return other.data;
  };
  const first=await canonical();if(first.code!=='BOUND')return first;
  let verified:boolean;
  try {
    const [catalog,raw]=await Promise.all([(deps.price??verifySandboxPrice)(first.offerCode,env),
      (deps.read??readSandboxResource)('transactions',first.transactionId,env)]);
    const {offer,productId}=catalog,data=unpaid.parse(raw);
    const url=new URL(data.checkout.url),item=data.items[0];
    verified=data.id===first.transactionId&&data.custom_data.sigma_checkout_intent===first.intentId
      &&item.price.id===offer.priceId&&item.price.product_id===productId&&item.price.unit_price.amount===offer.amount
      &&url.origin===env.SIGMAROUND_ACCOUNT_ORIGIN&&url.pathname==='/account/checkout'&&!url.username&&!url.password&&!url.hash
      &&Array.from(url.searchParams.keys()).every(key=>key==='_ptxn')&&url.searchParams.getAll('_ptxn').length<=1
      &&(!url.searchParams.has('_ptxn')||url.searchParams.get('_ptxn')===first.transactionId);
  } catch {verified=false;}
  if(!verified)return {code:'PENDING' as const}; // Never infer rejection/payment from an unavailable read.
  const last=await canonical();
  if(last.code!=='BOUND'||last.intentId!==first.intentId||last.transactionId!==first.transactionId||last.offerCode!==first.offerCode)
    return {code:'PENDING' as const};
  return {code:'RESUMABLE' as const,offerCode:first.offerCode,transactionId:first.transactionId};
}
