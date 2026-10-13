import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {describe,it} from 'vitest';
describe.skipIf(process.env.SIGMAROUND_RUN_CHECKOUT_DB_ACCEPTANCE!=='true')('staging checkout intent concurrent HTTP acceptance',()=>{
  it('claims one create, binds once and blocks unknown-outcome retries without paid writes',async()=>{
    const env=process.env;
    function check(value:unknown,message:string):asserts value{if(!value)throw new Error(`Checkout DB acceptance: ${message}`);}
    check(env.NEXT_PUBLIC_SUPABASE_URL==='https://dwqltsqumiwsxtkzdoaa.supabase.co'
      &&env.SIGMAROUND_ACCOUNT_ORIGIN==='https://cluera-ai-staging.vercel.app'&&env.SUPABASE_SERVICE_ROLE_KEY,'wrong target');
    const user=env.SIGMAROUND_CHECKOUT_FIXTURE_USER,session=env.SIGMAROUND_CHECKOUT_FIXTURE_SESSION;
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    check(user&&session&&uuid.test(user)&&uuid.test(session),'synthetic fixture missing');
    const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.rpc(name,args);check(!r.error,'RPC failed; details withheld');return r.data;};
    const requests=[randomUUID(),randomUUID()];
    const prepare=(request:string)=>call('customer_checkout_prepare',{p_user_id:user,p_session_id:session,p_request_id:request,p_offer_code:'pro_3_hours'});
    const starts=await Promise.all(requests.map(prepare));
    check(starts.filter(v=>v.code==='CLAIMED').length===1&&starts.filter(v=>v.code==='PENDING').length===1,'duplicate create claim');
    const winner=starts.findIndex(v=>v.code==='CLAIMED'),claim=starts[winner];
    check((await prepare(requests[winner])).code==='PENDING','replayed capability');
    const transaction=`txn_${randomUUID().replaceAll('-','').slice(0,26)}`; // Synthetic, no Paddle call.
    const args={p_intent_id:claim.intentId,p_attempt_id:claim.attemptId,p_transaction_id:transaction,p_state:'BOUND'};
    const bound=await Promise.all([call('customer_checkout_complete',args),call('customer_checkout_complete',args)]);
    check(bound.every(v=>v==='BOUND'),'duplicate binding');
    const retries=await Promise.all([prepare(requests[winner]),prepare(requests[winner])]);
    check(retries.every(v=>v.code==='BOUND'&&v.transactionId===transaction&&!v.attemptId),'retry changed binding');
    check(await call('customer_checkout_complete',{...args,p_attempt_id:randomUUID()})==='FORBIDDEN','forged capability');
    const next=await prepare(randomUUID());check(next.code==='CLAIMED','second purchase unavailable');
    check(await call('customer_checkout_complete',{p_intent_id:next.intentId,p_attempt_id:next.attemptId,p_transaction_id:null,p_state:'UNCERTAIN'})==='UNCERTAIN','unknown outcome');
    check((await prepare(randomUUID())).code==='PENDING','uncertain retry created another claim');
    console.info('Checkout DB acceptance: concurrent claim/binding, replay, capability and unknown-outcome checks passed');
  },60000);
});
