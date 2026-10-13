import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {describe,it} from 'vitest';

/** OPT-IN, MUTATING, staging-only. No provider/Paddle calls. Requires migration
 * 20261008100006_account_admin_catalog_controls.sql and an operator-prepared
 * disposable fixture (never an owner/customer account):
 * - allowlisted synthetic admin + live AAL2 Auth session;
 * - distinct verified ACTIVE user named sigmaround-adjustment-*@example.invalid;
 * - live user session, exhausted 900000ms trial, no other grants/plans/checkouts.
 * The test adds/removes ONE audited synthetic manual minute, races real HTTP
 * transactions and preserves all audit/usage history. Cleanup only STOPs its own
 * run. Fixture removal, if desired, is a separately approved operator action.
 * Configure fixture IDs/private credentials in the test environment, never chat.
 */
describe.skipIf(process.env.SIGMAROUND_RUN_ADMIN_ADJUSTMENT_ACCEPTANCE!=='true')('staging account adjustment concurrency',()=>{
 it('serializes duplicate adjustment IDs, competing removals and a usage reservation across connections',async()=>{
  const env=process.env;
  function safe(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(`Adjustment acceptance: ${message}`);}
  safe(env.SIGMAROUND_ACCOUNTS_ENABLED==='true'
   &&env.SIGMAROUND_ACCOUNT_ORIGIN==='https://cluera-ai-staging.vercel.app'
   &&env.NEXT_PUBLIC_SUPABASE_URL==='https://dwqltsqumiwsxtkzdoaa.supabase.co','wrong staging target');
  const actor=env.SIGMAROUND_ADJUSTMENT_FIXTURE_ADMIN,adminSession=env.SIGMAROUND_ADJUSTMENT_FIXTURE_ADMIN_SESSION;
  const user=env.SIGMAROUND_ADJUSTMENT_FIXTURE_USER,userSession=env.SIGMAROUND_ADJUSTMENT_FIXTURE_USER_SESSION;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  safe([actor,adminSession,user,userSession].every(value=>value&&uuid.test(value))&&actor!==user&&adminSession!==userSession
   &&env.SUPABASE_SERVICE_ROLE_KEY,'private synthetic fixture/configuration missing');
  const clients=Array.from({length:4},()=>createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{
   auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
   global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})},
  }));
  const call=async(index:number,name:string,args:Record<string,unknown>):Promise<any>=>{
   try{const result=await clients[index].rpc(name,args);safe(!result.error&&result.status===200,'RPC failed');return result.data;}
   catch{throw new Error('Adjustment acceptance: RPC failed without disclosing private details');}
  };
  const read=()=>call(3,'account_admin_read_v2',{p_actor:actor,p_session:adminSession,p_subject:user});
  const balance=()=>call(3,'customer_usage_balance',{p_user_id:user,p_session_id:userSession});
  const original=await read();safe(original?.code==='ACTIVE'&&original.users?.length===1
   &&original.users[0].userId===user&&original.users[0].state==='ACTIVE'&&original.users[0].emailVerified===true
   &&/^sigmaround-adjustment-[a-z0-9-]+@example\.invalid$/.test(original.users[0].email),'not the verified disposable fixture');
  safe(original.plans?.length===0&&original.billing?.length===0&&original.audit?.length===0
   &&original.grants?.length===1&&original.grants[0].kind==='TRIAL'
   &&original.grants[0].grantedMilliseconds===900000&&original.grants[0].spentMilliseconds===900000
   &&original.grants[0].reservedMilliseconds===0,'fixture has pre-existing state; do not rerun automatically');
  const before=await balance();safe(before.availableMilliseconds===0&&before.reservedMilliseconds===0&&before.spentMilliseconds===900000,'fixture trial is not exhausted');
  const operation=randomUUID(),reason='Disposable concurrent adjustment acceptance';
  const adjust=(index:number,operationId:string,action:string,input:object)=>call(index,'account_admin_adjust',{
   p_actor:actor,p_session:adminSession,p_operation:operationId,p_subject:user,p_action:action,p_reason:reason,p_input:input,
  });
  const adds=await Promise.all([adjust(0,operation,'ADD_MINUTES',{minutes:1}),adjust(1,operation,'ADD_MINUTES',{minutes:1})]);
  safe(adds.every(result=>result.code==='APPLIED'),'duplicate credit was not idempotent');
  const credited=await read(),grants=credited.grants.filter((grant:any)=>grant.adminAdjustment);
  safe(grants.length===1&&grants[0].grantedMilliseconds===60000
   &&credited.audit.filter((entry:any)=>entry.id===operation&&entry.action==='ADD_MINUTES').length===1,'duplicate allowance or audit');
  const run=randomUUID(),removeIds=[randomUUID(),randomUUID()];let active=false;
  const command=(sequence:number,action:string)=>call(2,'customer_usage_command',{
   p_user_id:user,p_session_id:userSession,p_run_id:run,p_sequence:sequence,p_action:action,
  });
  try{
   const [first,second,start]=await Promise.all([
    adjust(0,removeIds[0],'REMOVE_MINUTES',{minutes:1,grantId:grants[0].id}),
    adjust(1,removeIds[1],'REMOVE_MINUTES',{minutes:1,grantId:grants[0].id}),command(0,'START'),
   ]);
   active=start.code==='ACTIVE';
   safe(active||start.code==='EXHAUSTED','unexpected usage result');
   const removals=[first,second],applied=removals.filter(result=>result.code==='APPLIED').length;
   safe(removals.every(result=>['APPLIED','INSUFFICIENT_UNUSED'].includes(result.code))
    &&applied===(active?0:1),'removal consumed a reservation or duplicated credit reduction');
   if(active){
    const reserved=await balance();safe(reserved.reservedMilliseconds===30000&&reserved.availableMilliseconds===30000,'reservation invariant failed');
    const stops=await Promise.all([command(1,'STOP'),command(1,'STOP')]);
    safe(stops.every(result=>result.code==='CLOSED'),'duplicate stop failed');active=false;
   }
   const after=await balance();safe(after.reservedMilliseconds===0&&after.availableMilliseconds>=0&&after.spentMilliseconds>=900000
    &&after.availableMilliseconds+after.spentMilliseconds===900000+(applied===0?60000:0),'negative balance or double spend');
   const final=await read();
   safe(final.audit.filter((entry:any)=>removeIds.includes(entry.id)).length===applied,'audit count differs from applied removals');
   if(start.code==='ACTIVE'){
    safe((await command(1,'STOP')).code==='CLOSED','stop replay failed');
    const replay=await balance();safe(replay.availableMilliseconds===after.availableMilliseconds&&replay.spentMilliseconds===after.spentMilliseconds,'stop replay charged again');
   }
  }finally{
   if(active)await command(1,'STOP').catch(()=>{/* RPC failure recovers through bounded reservation expiry. */});
  }
  console.info('Adjustment acceptance: duplicate UUID, competing removals, reservation and immutable audit invariants passed');
 },60000);
});
