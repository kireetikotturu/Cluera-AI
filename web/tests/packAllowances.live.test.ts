import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {describe,it} from 'vitest';

describe.skipIf(process.env.SIGMAROUND_RUN_PACK_DB_ACCEPTANCE!=='true')('isolated staging pack financial concurrency',()=>{
  it('deduplicates grants/refunds and serializes refund against usage without any Paddle call',async()=>{
    const env=process.env;
    function check(value:unknown,message:string):asserts value{if(!value)throw new Error(`Pack DB acceptance: ${message}`);}
    check(env.NEXT_PUBLIC_SUPABASE_URL==='https://yhnqlfcgrmckhyjdxegg.supabase.co'
      &&env.SIGMAROUND_ACCOUNT_ORIGIN==='https://cluera-ai-staging.vercel.app'&&env.SUPABASE_SERVICE_ROLE_KEY,'wrong target');
    const user=env.SIGMAROUND_PACK_FIXTURE_USER,session=env.SIGMAROUND_PACK_FIXTURE_SESSION;
    check(user&&session&&/^[a-f0-9-]{36}$/.test(user)&&/^[a-f0-9-]{36}$/.test(session),'synthetic fixture missing');
    const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.rpc(name,args);check(!r.error,'RPC failed; details withheld');return r.data;};
    const synthetic=(prefix:string,n:number)=>`${prefix}_${user.replaceAll('-','').slice(0,24)}${String(n).padStart(2,'0')}`;
    const customer=synthetic('ctm',0);
    const event=async(n:number,transaction:number,refund=false)=>call('paddle_sandbox_receive',{
      p_event_id:synthetic('evt',n),p_event_type:refund?'adjustment.updated':'transaction.completed',
      p_occurred_at:new Date().toISOString(),p_resource_id:refund?synthetic('adj',n):synthetic('txn',transaction),p_event_digest:'b'.repeat(64)});
    const intent=async(n:number)=>{
      const c=await call('customer_checkout_prepare',{p_user_id:user,p_session_id:session,p_request_id:randomUUID(),p_offer_code:'pro_3_hours'});
      check(c.code==='CLAIMED','claim');
      check(await call('customer_checkout_complete',{p_intent_id:c.intentId,p_attempt_id:c.attemptId,p_transaction_id:synthetic('txn',n),p_state:'BOUND'})==='BOUND','binding');
      return c.intentId;
    };
    const claims=new Map<number,any>();
    const claim=async(e:number)=>{const j=await call('customer_billing_claim',{p_event_id:synthetic('evt',e)});check(j.code==='CLAIMED','event lease');claims.set(e,j);};
    const apply=(i:string,n:number,e=n,refund=false)=>call('customer_billing_apply_pack',{
      p_claim_id:claims.get(e).claimId,p_event_digest:claims.get(e).eventDigest,
      p_event_id:synthetic('evt',e),p_intent_id:i,p_transaction_id:synthetic('txn',n),p_customer_id:customer,
      p_action:refund?'REFUND':'GRANT',p_adjustment_id:refund?synthetic('adj',e):null});
    const balance=()=>call('customer_usage_balance',{p_user_id:user,p_session_id:session});
    const a=await intent(1);await event(1,1);await claim(1);
    const grants=await Promise.all([apply(a,1),apply(a,1)]);
    check(grants.filter(v=>v.code==='ACTIVE').length===1&&grants.filter(v=>v.code==='STALE').length===1,'duplicate grant');
    check((await balance()).availableMilliseconds===11700000,'single pack balance');
    const b=await intent(2);await event(2,2);await claim(2);await apply(b,2);
    check((await balance()).availableMilliseconds===22500000,'stacked balance');
    await event(4,1,true);await claim(4);const run=randomUUID();
    const racing=await Promise.all([
      call('customer_usage_command',{p_user_id:user,p_session_id:session,p_run_id:run,p_sequence:0,p_action:'START'}),
      apply(a,1,4,true),apply(a,1,4,true),
    ]);
    check(racing[0].code==='ACTIVE','usage start');
    check(racing.slice(1).filter(v=>v.code==='REFUNDED').length===1&&racing.slice(1).filter(v=>v.code==='STALE').length===1,'refund replay');
    const stopped=await call('customer_usage_command',{p_user_id:user,p_session_id:session,p_run_id:run,p_sequence:1,p_action:'STOP'});
    check(['DENIED','CLOSED'].includes(stopped.code),'refund/stop race');
    const c=await intent(3);await event(3,3);await event(5,3,true);await claim(3);await claim(5);
    const late=await Promise.all([apply(c,3,5,true),apply(c,3)]);
    check(late.every(v=>['REFUNDED','ACTIVE'].includes(v.code)),'completion/refund race');
    const final=await balance();
    check(final.reservedMilliseconds===0&&final.availableMilliseconds>=11670000&&final.availableMilliseconds<=11700000,'balance invariant');
    console.info('Pack DB acceptance: concurrent grants, stacking, refund/usage and refund/completion races passed; zero reserved balance');
  },60000);
});
