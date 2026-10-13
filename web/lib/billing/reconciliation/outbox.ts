import {z} from 'zod';
import {AccountError} from '../../accounts/config';
import {SupabaseOperationError} from '../../supabase/diagnostics';
import {assertCheckoutStaging} from '../checkout/service';
import {inspectSandboxSubscription,subscriptionBindingSchema} from './transaction';
import type {BillingRpc} from './worker';

const actionSchema=z.object({code:z.literal('CLAIMED'),actionId:z.uuid(),claimId:z.uuid(),userId:z.uuid(),
  subscriptionId:z.string().regex(/^sub_[a-z0-9]{26}$/),action:z.enum(['CANCEL_FUTURE','RESCHEDULE']),
  effectiveAt:z.iso.datetime({offset:true}).nullable()});

/** Staging-only, explicit opt-in, one durable action. Read before AND after write.
 * If an HTTP outcome is unknown, the next attempt reads authoritative Paddle
 * state before deciding whether a mutation is still necessary. No payment API,
 * arbitrary path/body, provider automatic retry, or in-process polling loop. */
export async function executeNextSandboxBillingAction(rpc:BillingRpc,env=process.env,request:typeof fetch=fetch){
  assertCheckoutStaging(env);
  if(env.SIGMAROUND_PADDLE_SANDBOX_BILLING_ACTIONS_ENABLED!=='true')throw new AccountError('UNAVAILABLE',503);
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const r=await rpc(name,args);if(r.error)throw new SupabaseOperationError('billing.outbox',r.error,r.status);return r.data;
  };
  const raw=await call('customer_billing_action_claim');
  const idle=z.object({code:z.enum(['EMPTY','REVIEW'])}).safeParse(raw);if(idle.success)return idle.data.code;
  const job=actionSchema.parse(raw);
  const finish=async(result:'CONFIRMED'|'RETRY'|'CONFLICT')=>{
    const state=await call('customer_billing_action_finish',{p_id:job.actionId,p_claim_id:job.claimId,p_result:result});
    if(state!=='SAVED'&&state!=='STALE')throw new Error('Invalid billing action result.');return result;
  };
  try{
    const bound=subscriptionBindingSchema.parse(await call('customer_billing_subscription',{p_subscription_id:job.subscriptionId}));
    if(bound.userId!==job.userId||bound.subscriptionId!==job.subscriptionId)return await finish('CONFLICT');
    const sub=await inspectSandboxSubscription(bound,env,request);
    const achieved=(s:typeof sub)=>job.action==='CANCEL_FUTURE'?s.cancelFuture:
      s.state==='ACTIVE'&&!s.scheduledChange&&s.nextBilledAt!==null&&Date.parse(s.nextBilledAt)===Date.parse(job.effectiveAt!);
    if(achieved(sub))return await finish('CONFIRMED');
    if(job.action==='RESCHEDULE'&&(!job.effectiveAt||Date.parse(job.effectiveAt)<=Date.now()+30*60_000
      ||sub.state!=='ACTIVE'||sub.scheduledChange||!sub.nextBilledAt||Date.parse(sub.nextBilledAt)<=Date.now()+30*60_000))
      return await finish('CONFLICT');
    if(job.action==='CANCEL_FUTURE'&&sub.state==='PAUSED')return await finish('CONFLICT');
    if(await call('customer_billing_action_authorize',{p_id:job.actionId,p_claim_id:job.claimId})!==true)return 'STALE';
    const cancel=job.action==='CANCEL_FUTURE';
    const response=await request(`https://sandbox-api.paddle.com/subscriptions/${job.subscriptionId}${cancel?'/cancel':''}`,{
      method:cancel?'POST':'PATCH',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10_000),
      headers:{Authorization:`Bearer ${env.PADDLE_API_KEY}`,'Paddle-Version':'1','Content-Type':'application/json'},
      body:JSON.stringify(cancel?{effective_from:'next_billing_period'}:
        {next_billed_at:job.effectiveAt,proration_billing_mode:'do_not_bill'})});
    // Do not retain upstream error/result bodies. Success is established by a
    // fresh read, not by assuming 2xx means the intended state was applied.
    await response.body?.cancel();
    if(!response.ok)return await finish('RETRY');
    return await finish(achieved(await inspectSandboxSubscription(bound,env,request))?'CONFIRMED':'RETRY');
  }catch{return await finish('RETRY');}
}
