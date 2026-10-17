import {createHash,timingSafeEqual} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {assertCheckoutStaging} from '../checkout/service';
import {reconcileNextSandboxEvent,type BillingRpc} from './worker';
import {executeNextSandboxBillingAction} from './outbox';
import {apiError,json} from '../../http';
import {reconcilePayment} from '../../payments/reconciliation/worker';
import {razorpayConfig} from '../../payments/core/config';

/** Scheduler wake-up, not a browser endpoint. One job and one ordered action per
 * invocation; durable database leases handle overlap/crash/retry. Never accept
 * caller-supplied account, event, subscription or financial instructions. */
export async function handleBillingTick(request:Request,env=process.env,deps:{
  rpc?:BillingRpc;reconcile?:typeof reconcileNextSandboxEvent;action?:typeof executeNextSandboxBillingAction;payment?:typeof reconcilePayment;
}={}){
  // The V2 owner uses only its separately admitted external/HMAC worker.
  if(env.CLUERA_BILLING_V2_ENABLED==='true')return json({error:'Not found.'},404);
  if(env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED!=='true')return json({error:'Not found.'},404);
  let paddleEnabled=false,razorpayEnabled=false;
  // Each provider validates its own exact Test/staging boundary. Retaining the
  // old scheduler must not make new Razorpay work depend on Paddle settings.
  if(env.SIGMAROUND_PADDLE_SANDBOX_RECONCILIATION_ENABLED==='true'){
    try{assertCheckoutStaging(env);paddleEnabled=true;}catch{/* This provider stays disabled. */}
  }
  if(env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED==='true'){
    try{razorpayConfig(env);razorpayEnabled=true;}catch{/* This provider stays disabled. */}
  }
  if(!paddleEnabled&&!razorpayEnabled)return json({error:'Not found.'},404);
  const secret=env.SIGMAROUND_BILLING_WORKER_SECRET;
  if(!secret||secret.length<32||secret.length>256)return json({error:'Worker unavailable.'},503);
  const supplied=request.headers.get('authorization')??'';
  const digest=(s:string)=>createHash('sha256').update(s).digest();
  if(supplied.length>512||!timingSafeEqual(digest(supplied),digest(`Bearer ${secret}`)))return json({error:'Unauthorized.'},401);
  if(request.method!=='POST'||new URL(request.url).search)return json({error:'Invalid request.'},400);
  try{
    if(!env.SUPABASE_SERVICE_ROLE_KEY)return json({error:'Worker unavailable.'},503);
    const boundedFetch:typeof fetch=(input,init)=>fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000)});
    const client=deps.rpc?null:createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY,{global:{fetch:boundedFetch},
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const rpc=deps.rpc??((name,args)=>client!.rpc(name,args));
    // Reuse the existing sealed staging scheduler; one separately leased
    // gateway event, no extra timer, credential transfer or financial fixture.
    if(razorpayEnabled)await (deps.payment??reconcilePayment)(rpc,env);
    if(paddleEnabled){
      await (deps.reconcile??reconcileNextSandboxEvent)(rpc,env);
      if(env.SIGMAROUND_PADDLE_SANDBOX_BILLING_ACTIONS_ENABLED==='true')await (deps.action??executeNextSandboxBillingAction)(rpc,env);
    }
    return json({processed:true}); // No identities, amounts or resource payloads.
  }catch(error){apiError(error);return json({error:'Worker unavailable.'},503);}
}
