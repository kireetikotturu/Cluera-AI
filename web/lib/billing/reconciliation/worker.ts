import {z} from 'zod';
import {assertCheckoutStaging} from '../checkout/service';
import {SupabaseOperationError} from '../../supabase/diagnostics';
import {readSandboxResource} from '../paddle';
import {inspectBoundSandboxTransaction,inspectRenewalSandboxTransaction,inspectSandboxSubscription,subscriptionBindingSchema} from './transaction';
import {inspectTransactionAdjustments} from './adjustments';

export type BillingRpc=(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown;status?:number}>;
const claimSchema=z.object({code:z.literal('CLAIMED'),eventId:z.string().regex(/^evt_[a-z0-9]{26}$/),
  eventType:z.string(),resourceId:z.string(),eventDigest:z.string().regex(/^[a-f0-9]{64}$/),claimId:z.uuid()});
const boundSchema=z.object({intentId:z.uuid(),userId:z.uuid(),transactionId:z.string().regex(/^txn_[a-z0-9]{26}$/),offerCode:z.string()});

/** One bounded job, not an in-process polling loop. Called only by the gated,
 * authenticated staging worker. Simulations cannot match the schema.
 * Errors expose fixed result categories only, never upstream bodies or identities. */
export async function reconcileNextSandboxEvent(rpc:BillingRpc,env=process.env,request:typeof fetch=fetch){
  assertCheckoutStaging(env);
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const r=await rpc(name,args);if(r.error)throw new SupabaseOperationError('billing.reconcile',r.error,r.status);return r.data;
  };
  const raw=await call('customer_billing_claim');
  const idle=z.object({code:z.enum(['EMPTY','REVIEW'])}).safeParse(raw);if(idle.success)return idle.data.code;
  const job=claimSchema.parse(raw);
  const finish=async(result:'IGNORED'|'RETRY'|'UNBOUND'|'UNSUPPORTED'|'CONFLICT')=>{
    const state=await call('customer_billing_finish',{p_event_id:job.eventId,p_claim_id:job.claimId,p_result:result});
    if(state!=='SAVED'&&state!=='STALE')throw new Error('Invalid billing job result.');return result;
  };
  try{
    if(job.eventType.startsWith('subscription.')){
      const value=await call('customer_billing_subscription',{p_subscription_id:job.resourceId});
      if(value===null)return await finish('UNBOUND');
      const bound=subscriptionBindingSchema.parse(value),evidence=await inspectSandboxSubscription(bound,env,request);
      const result=z.object({code:z.string()}).parse(await call('customer_billing_apply_recurring',{
        p_event_id:job.eventId,p_claim_id:job.claimId,p_event_digest:job.eventDigest,p_evidence:{...evidence,action:'STATUS'}}));
      if(['APPLIED','DUPLICATE','STALE'].includes(result.code))return result.code;
      return await finish(result.code==='UNBOUND'?'UNBOUND':result.code==='RETRY'?'RETRY':'CONFLICT');
    }
    let transactionId=job.resourceId,action:'GRANT'|'REFUND'='GRANT',adjustmentId:string|null=null;
    if(job.eventType==='adjustment.created'||job.eventType==='adjustment.updated'){
      const adjustment=z.object({id:z.string(),transaction_id:z.string().regex(/^txn_[a-z0-9]{26}$/)})
        .parse(await readSandboxResource('adjustments',job.resourceId,env,request));
      if(adjustment.id!==job.resourceId)return await finish('CONFLICT');
      transactionId=adjustment.transaction_id;action='REFUND';adjustmentId=adjustment.id;
    }else if(job.eventType!=='transaction.completed'){
      // Never mark an unimplemented lifecycle event as financially applied.
      return await finish('UNSUPPORTED');
    }
    const rawBound=await call('customer_billing_bound_intent',{p_transaction_id:transactionId});
    let evidence:Awaited<ReturnType<typeof inspectBoundSandboxTransaction>>;
    if(rawBound===null){
      // A recurring renewal has no new checkout intent. Resolve ONLY through an
      // already bound subscription, then revalidate every related resource.
      const tx=await readSandboxResource('transactions',transactionId,env,request);
      const ref=z.object({id:z.literal(transactionId),subscription_id:z.string().regex(/^sub_[a-z0-9]{26}$/)}).safeParse(tx);
      if(!ref.success)return await finish('UNBOUND');
      const sb=await call('customer_billing_subscription',{p_subscription_id:ref.data.subscription_id});
      if(sb===null)return await finish('UNBOUND');
      evidence=await inspectRenewalSandboxTransaction(subscriptionBindingSchema.parse(sb),transactionId,tx,env,request);
    }else{
      const bound=boundSchema.parse(rawBound);
      if(bound.transactionId!==transactionId)return await finish('CONFLICT');
      evidence=await inspectBoundSandboxTransaction(bound,env,request);
    }
    const adjustments=await inspectTransactionAdjustments(transactionId,evidence.customerId,env,request);
    if(evidence.customerState!=='active')return await finish('UNSUPPORTED');
    if(action==='GRANT'){
      // A delayed completion must never restore refunded/credited/disputed value.
      // Refund event owns the tombstone, not a fabricated adjustment event.
      if(adjustments.some(a=>a.status!=='rejected'))return await finish('UNSUPPORTED');
    }else{
      const a=adjustments.find(a=>a.id===adjustmentId);
      if(!a)return await finish('RETRY');
      if(a.status==='pending_approval')return await finish('RETRY');
      if(a.status==='rejected')return await finish('IGNORED');
      if(a.action!=='refund'||a.type!=='full'||a.status!=='approved')return await finish('UNSUPPORTED');
    }
    const result=z.object({code:z.string()}).parse(evidence.recurring?await call('customer_billing_apply_recurring',{
      p_event_id:job.eventId,p_claim_id:job.claimId,p_event_digest:job.eventDigest,p_evidence:{action,adjustmentId,
        transactionId,subscriptionId:evidence.recurring.subscriptionId,customerId:evidence.customerId,offerCode:evidence.offerCode,
        periodStart:evidence.recurring.startsAt,periodEnd:evidence.recurring.endsAt,observedAt:evidence.recurring.observedAt,
        state:evidence.recurring.status,cancelFuture:evidence.recurring.cancelFuture}}):await call('customer_billing_apply_pack',{
      p_event_id:job.eventId,p_claim_id:job.claimId,p_event_digest:job.eventDigest,
      p_intent_id:evidence.intentId,p_transaction_id:transactionId,p_customer_id:evidence.customerId,p_action:action,p_adjustment_id:adjustmentId}));
    if(['ACTIVE','REFUNDED','DUPLICATE','APPLIED'].includes(result.code))return 'APPLIED';
    if(result.code==='STALE')return 'STALE';
    return await finish(result.code==='UNBOUND'?'UNBOUND':result.code==='RETRY'?'RETRY':'CONFLICT');
  }catch{
    // If the process dies before this call, the expiring lease still recovers it.
    // If apply committed but its response was lost, finish returns STALE/DONE;
    // the transaction's unique grant remains authoritative.
    return await finish('RETRY');
  }
}
