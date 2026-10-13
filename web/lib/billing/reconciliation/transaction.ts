import {z} from 'zod';
import {assertCheckoutStaging} from '../checkout/service';
import {PaddleBoundaryError,readSandboxResource} from '../paddle';
import {sandboxOffer,verifySandboxPrice} from '../sandboxCatalog';

const id=(prefix:string)=>z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{26}$`));
const period=z.object({starts_at:z.iso.datetime({offset:true}),ends_at:z.iso.datetime({offset:true})});
const price=z.object({id:id('pri'),product_id:id('pro'),unit_price:z.object({amount:z.string().regex(/^\d+$/),currency_code:z.literal('INR')}),
  tax_mode:z.enum(['internal','external','account_setting']),
  billing_cycle:z.object({interval:z.enum(['week','month']),frequency:z.literal(1)}).nullable(),trial_period:z.null()});
const transaction=z.object({id:id('txn'),status:z.literal('completed'),customer_id:id('ctm'),subscription_id:id('sub').nullable(),
  collection_mode:z.literal('automatic'),currency_code:z.literal('INR'),discount_id:z.null(),
  custom_data:z.object({sigma_checkout_intent:z.uuid().optional()}).nullable(),
  billing_period:period.nullable(),updated_at:z.iso.datetime({offset:true}),
  items:z.array(z.object({quantity:z.literal(1),price,proration:z.null()})).length(1),
  details:z.object({totals:z.object({balance:z.literal('0'),discount:z.literal('0'),credit:z.literal('0'),
    credit_to_balance:z.literal('0'),currency_code:z.literal('INR'),
    subtotal:z.string().regex(/^\d{1,14}$/),tax:z.string().regex(/^\d{1,14}$/),
    grand_total:z.string().regex(/^[1-9]\d{0,13}$/),total:z.string().regex(/^[1-9]\d{0,13}$/)}),
    line_items:z.array(z.object({price_id:id('pri'),quantity:z.literal(1)})).length(1)}),
});
const customer=z.object({id:id('ctm'),status:z.enum(['active','archived'])});
const subscription=z.object({id:id('sub'),customer_id:id('ctm'),status:z.enum(['active','past_due','paused','canceled']),
  collection_mode:z.literal('automatic'),currency_code:z.literal('INR'),
  scheduled_change:z.object({action:z.enum(['cancel','pause','resume']),effective_at:z.iso.datetime({offset:true})}).nullable(),
  next_billed_at:z.iso.datetime({offset:true}).nullable(),
  items:z.array(z.object({quantity:z.literal(1),price})).length(1),updated_at:z.iso.datetime({offset:true}),
});
const binding=z.object({intentId:z.uuid(),userId:z.uuid(),transactionId:id('txn'),offerCode:z.string()}).strict();
export const subscriptionBindingSchema=z.object({userId:z.uuid(),subscriptionId:id('sub'),customerId:id('ctm'),offerCode:z.string()});
export type SubscriptionBinding=z.infer<typeof subscriptionBindingSchema>;

export async function inspectSandboxSubscription(bound:SubscriptionBinding,env=process.env,request:typeof fetch=fetch){
  assertCheckoutStaging(env);
  try{
    const owner=subscriptionBindingSchema.parse(bound),offer=sandboxOffer(owner.offerCode,env.PADDLE_ENVIRONMENT);
    const sub=subscription.parse(await readSandboxResource('subscriptions',owner.subscriptionId,env,request));
    if(!offer.interval||sub.id!==owner.subscriptionId||sub.customer_id!==owner.customerId||sub.items[0].price.id!==offer.priceId
      ||sub.items[0].price.unit_price.amount!==offer.amount||sub.items[0].price.billing_cycle?.interval!==offer.interval)throw new PaddleBoundaryError();
    return {subscriptionId:sub.id,customerId:sub.customer_id,offerCode:offer.code,state:sub.status.toUpperCase(),
      observedAt:sub.updated_at,cancelFuture:sub.status==='canceled'||sub.scheduled_change?.action==='cancel',
      scheduledChange:sub.scheduled_change,nextBilledAt:sub.next_billed_at,productId:sub.items[0].price.product_id};
  }catch{throw new PaddleBoundaryError();}
}

/** Internal evidence reader only. boundIntent MUST come from the durable server
 * BOUND intent lookup, never browser custom_data or a webhook's customer fields.
 * No financial RPC calls or allowance grants occur here. Refund/lifecycle
 * reconciliation must complete before any future writer uses this evidence. */
export async function inspectBoundSandboxTransaction(boundIntent:z.infer<typeof binding>,env=process.env,request:typeof fetch=fetch){
  return inspectTransaction(binding.parse(boundIntent),null,undefined,env,request);
}

/** Renewal ownership comes from the already bound subscription, never custom_data. */
export async function inspectRenewalSandboxTransaction(bound:SubscriptionBinding,transactionId:string,rawTransaction:unknown,
  env=process.env,request:typeof fetch=fetch){
  const owner=subscriptionBindingSchema.parse(bound);id('txn').parse(transactionId);
  return inspectTransaction({userId:owner.userId,transactionId,offerCode:owner.offerCode},owner,rawTransaction,env,request);
}
async function inspectTransaction(bound:{intentId?:string;userId:string;transactionId:string;offerCode:string},renewal:SubscriptionBinding|null,
  rawTransaction:unknown,env:NodeJS.ProcessEnv,request:typeof fetch){
  assertCheckoutStaging(env);
  try {
    const offer=sandboxOffer(bound.offerCode,env.PADDLE_ENVIRONMENT);
    const tx=transaction.parse(rawTransaction??await readSandboxResource('transactions',bound.transactionId,env,request));
    if(tx.id!==bound.transactionId||(!renewal&&tx.custom_data?.sigma_checkout_intent!==bound.intentId)
      ||(renewal&&(tx.subscription_id!==renewal.subscriptionId||tx.customer_id!==renewal.customerId))
      ||tx.items[0].price.id!==offer.priceId||tx.details.line_items[0].price_id!==offer.priceId
      ||tx.items[0].price.unit_price.amount!==offer.amount
      ||(tx.items[0].price.billing_cycle?.interval??null)!==offer.interval)throw new PaddleBoundaryError();
    const totals=tx.details.totals,amount=BigInt(offer.amount),subtotal=BigInt(totals.subtotal),total=BigInt(totals.total);
    if(total!==subtotal+BigInt(totals.tax)||totals.total!==totals.grand_total
      ||(tx.items[0].price.tax_mode==='external'?subtotal!==amount:
        tx.items[0].price.tax_mode==='internal'?total!==amount:subtotal!==amount&&total!==amount))throw new PaddleBoundaryError();
    const catalog=await verifySandboxPrice(offer.code,env,request);
    if(tx.items[0].price.product_id!==catalog.productId)throw new PaddleBoundaryError();
    const owner=customer.parse(await readSandboxResource('customers',tx.customer_id,env,request));
    if(owner.id!==tx.customer_id)throw new PaddleBoundaryError();
    let recurring:null|{subscriptionId:string;status:string;observedAt:string;startsAt:string;endsAt:string;cancelFuture:boolean}=null;
    if(offer.interval){
      if(!tx.subscription_id||!tx.billing_period)throw new PaddleBoundaryError();
      const duration=Date.parse(tx.billing_period.ends_at)-Date.parse(tx.billing_period.starts_at);
      // Reject malformed/prorated periods until the lifecycle reconciler explicitly
      // handles them. Initial weekly/monthly catalog terms have bounded full periods.
      const minimumDays=offer.interval==='week'?7:28,maximumDays=offer.interval==='week'?7:31;
      if(duration<minimumDays*86400000-1000||duration>maximumDays*86400000+1000)throw new PaddleBoundaryError();
      const sub=await inspectSandboxSubscription({userId:bound.userId,subscriptionId:tx.subscription_id,customerId:tx.customer_id,offerCode:offer.code},env,request);
      if(sub.productId!==catalog.productId)throw new PaddleBoundaryError();
      recurring={subscriptionId:sub.subscriptionId,status:sub.state,observedAt:sub.observedAt,startsAt:tx.billing_period.starts_at,
        endsAt:tx.billing_period.ends_at,cancelFuture:sub.cancelFuture};
    }else if(tx.subscription_id!==null||tx.billing_period!==null)throw new PaddleBoundaryError();
    return {intentId:bound.intentId,userId:bound.userId,transactionId:tx.id,customerId:owner.id,
      customerState:owner.status,offerCode:offer.code,allowanceMilliseconds:offer.seconds*1000,
      observedAt:tx.updated_at,recurring,financiallyReconciled:false as const};
  }catch{throw new PaddleBoundaryError();}
}

/** Attribution for a future refund writer; a pending/rejected refund removes
 * nothing. Reversal/credit/partial policies need their own explicit handling. */
export async function inspectSandboxFullRefund(adjustmentId:string,expected:{transactionId:string;customerId:string},env=process.env,request:typeof fetch=fetch){
  assertCheckoutStaging(env);
  try {
    const value=z.object({id:id('adj'),action:z.literal('refund'),type:z.literal('full'),status:z.enum(['approved','pending_approval','rejected','reversed']),
      transaction_id:id('txn'),customer_id:id('ctm'),currency_code:z.literal('INR'),updated_at:z.iso.datetime({offset:true})})
      .parse(await readSandboxResource('adjustments',adjustmentId,env,request));
    if(value.id!==adjustmentId||value.transaction_id!==expected.transactionId||value.customer_id!==expected.customerId)throw new PaddleBoundaryError();
    return {adjustmentId:value.id,transactionId:value.transaction_id,status:value.status,observedAt:value.updated_at};
  }catch{throw new PaddleBoundaryError();}
}
