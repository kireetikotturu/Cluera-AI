import { z } from 'zod';
import { AccountError } from '../../accounts/config';
import { SupabaseOperationError } from '../../supabase/diagnostics';
import { verifySandboxOffer, type SandboxOffer } from '../sandboxCatalog';
import { createSandboxCheckout, type CheckoutBinding } from './transport';
import { checkoutFailureDetails, logCheckoutFailure } from './diagnostics';

type Rpc=(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown;status?:number}>;
const inputSchema=z.object({requestId:z.uuid(),offerCode:z.enum(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly'])}).strict();
const identitySchema=z.object({userId:z.uuid(),sessionId:z.uuid()});
const claimSchema=z.object({code:z.literal('CLAIMED'),intentId:z.uuid(),attemptId:z.uuid()});
const boundSchema=z.object({code:z.literal('BOUND'),intentId:z.uuid(),transactionId:z.string().regex(/^txn_[a-z0-9]{26}$/)});

export function assertCheckoutStaging(env:NodeJS.ProcessEnv) {
  if(env.SIGMAROUND_ACCOUNTS_ENABLED!=='true' || env.PADDLE_ENVIRONMENT!=='sandbox'
    || env.SIGMAROUND_ACCOUNT_ORIGIN!=='https://cluera-ai-staging.vercel.app'
    || env.NEXT_PUBLIC_SUPABASE_URL!=='https://yhnqlfcgrmckhyjdxegg.supabase.co'
    || env.SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF!=='yhnqlfcgrmckhyjdxegg') throw new AccountError('UNAVAILABLE',503);
}

/** Server-only, guarded staging checkout. Neither CLAIMED nor BOUND is paid access. */
export function checkoutService(rpc:Rpc,env=process.env,deps:{
  offer?:(code:string)=>Promise<SandboxOffer>;
  create?:(offer:SandboxOffer,intentId:string)=>Promise<CheckoutBinding>;
}={}) {
  assertCheckoutStaging(env);
  const call=async(name:string,args:Record<string,unknown>)=>{
    const {data,error,status}=await rpc(name,args);
    if(error) throw new SupabaseOperationError('billing.checkout',error,status);
    return data;
  };
  return {async prepare(verifiedIdentity:z.infer<typeof identitySchema>,input:z.infer<typeof inputSchema>) {
    const who=identitySchema.parse(verifiedIdentity),value=inputSchema.parse(input);
    // Read-only catalog preflight before claiming. An outage cannot strand an intent.
    const offer=await (deps.offer??(code=>verifySandboxOffer(code,env)))(value.offerCode);
    const result=await call('customer_checkout_prepare',{p_user_id:who.userId,p_session_id:who.sessionId,
      p_request_id:value.requestId,p_offer_code:value.offerCode});
    const claim=claimSchema.safeParse(result);
    if(!claim.success) {
      const bound=boundSchema.safeParse(result);
      if(bound.success) return bound.data; // No provider create on retry.
      const state=z.object({code:z.enum(['PENDING','REJECTED','CONFLICT','RATE_LIMITED','INVALID','UNAUTHENTICATED','SUSPENDED','UNAVAILABLE'])}).safeParse(result);
      if(!state.success) throw new AccountError('UNAVAILABLE',503);
      return state.data;
    }
    const args={p_intent_id:claim.data.intentId,p_attempt_id:claim.data.attemptId};
    let binding:CheckoutBinding;
    try {
      binding=await (deps.create??((o,id)=>createSandboxCheckout(o,id,env)))(offer,claim.data.intentId);
    } catch(error) {
      logCheckoutFailure(error);
      // No automatic provider retry, including after a crash or network timeout.
      // A failed persistence attempt leaves CREATING, which is equally fail-closed.
      await call('customer_checkout_complete',{...args,p_transaction_id:null,p_state:'UNCERTAIN'});
      // Preserve bounded support categories in this response as well as logs.
      // This never authorizes a retry or turns an unknown outcome into rejection.
      return {code:'PENDING' as const,failure:checkoutFailureDetails(error)};
    }
    const saved=await call('customer_checkout_complete',{...args,p_transaction_id:binding.transactionId,p_state:'BOUND'});
    if(saved!=='BOUND') throw new AccountError('UNAVAILABLE',503);
    return {code:'BOUND' as const,intentId:claim.data.intentId,transactionId:binding.transactionId};
  }};
}
