import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, it } from 'vitest';

// Operator-only: prepare a synthetic staging user with two synthetic Auth sessions
// and exactly 30 seconds available. Never point these IDs at a real account.
// No credentials, response payloads, or user identifiers are logged on failure.
describe.skipIf(process.env.SIGMAROUND_RUN_USAGE_ACCEPTANCE !== 'true')('staging shared-usage concurrency', () => {
  it('reserves the last window once across HTTP connections and settles duplicate stops once', async () => {
    const env=process.env;
    const requireSafe=(ok:unknown, message:string):asserts ok=>{if(!ok) throw new Error(message);};
    requireSafe(env.SIGMAROUND_ACCOUNTS_ENABLED==='true'
      && env.SIGMAROUND_ACCOUNT_ORIGIN==='https://cluera-ai-staging.vercel.app'
      && env.NEXT_PUBLIC_SUPABASE_URL==='https://yhnqlfcgrmckhyjdxegg.supabase.co', 'Usage acceptance: wrong target');
    const user=env.SIGMAROUND_USAGE_FIXTURE_USER;
    const sessions=[env.SIGMAROUND_USAGE_FIXTURE_SESSION_A,env.SIGMAROUND_USAGE_FIXTURE_SESSION_B];
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    requireSafe(user && uuid.test(user) && sessions.every(value=>value && uuid.test(value))
      && sessions[0]!==sessions[1] && env.SUPABASE_SERVICE_ROLE_KEY, 'Usage acceptance: fixture/config missing');
    const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    });
    const call=async(name:string,args:Record<string,unknown>)=>{
      const result=await client.rpc(name,args);
      requireSafe(!result.error && result.status===200,'Usage acceptance: RPC rejected');
      return result.data as Record<string,unknown>;
    };
    const balance=()=>call('customer_usage_balance',{p_user_id:user,p_session_id:sessions[0]});
    const before=await balance();
    requireSafe(before.availableMilliseconds===30000 && before.reservedMilliseconds===0
      && before.spentMilliseconds===870000,'Usage acceptance: synthetic fixture not prepared');
    const runs=[randomUUID(),randomUUID()];
    const command=(index:number,sequence:number,action:string,session=sessions[index])=>call('customer_usage_command',{
      p_user_id:user,p_session_id:session,p_run_id:runs[index],p_sequence:sequence,p_action:action,
    });
    // One process dispatches both real HTTP requests without awaiting either first.
    const starts=await Promise.all([command(0,0,'START'),command(1,0,'START')]);
    requireSafe(starts.filter(value=>value.code==='ACTIVE').length===1
      && starts.filter(value=>value.code==='EXHAUSTED').length===1,'Usage acceptance: overspend/race');
    const winner=starts.findIndex(value=>value.code==='ACTIVE');
    const retries=await Promise.all([command(winner,0,'START'),command(winner,0,'START')]);
    requireSafe(retries.every(value=>value.code==='ACTIVE' && value.expiresAt===starts[winner].expiresAt),
      'Usage acceptance: retry extended deadline');
    const reserved=await balance();
    requireSafe(reserved.availableMilliseconds===0 && reserved.reservedMilliseconds===30000
      && reserved.spentMilliseconds===870000,'Usage acceptance: duplicate reservation');
    requireSafe((await command(winner,1,'STOP',sessions[1-winner])).code==='FORBIDDEN',
      'Usage acceptance: cross-session mutation');
    const stops=await Promise.all([command(winner,1,'STOP'),command(winner,1,'STOP')]);
    requireSafe(stops.every(value=>value.code==='CLOSED'),'Usage acceptance: duplicate stop failed');
    const after=await balance();
    requireSafe(after.reservedMilliseconds===0 && Number(after.spentMilliseconds)>870000
      && Number(after.spentMilliseconds)<900000
      && Number(after.availableMilliseconds)+Number(after.spentMilliseconds)===900000,
      'Usage acceptance: settlement invariant');
    requireSafe((await command(winner,1,'STOP')).code==='CLOSED','Usage acceptance: stop retry failed');
    const final=await balance();
    requireSafe(final.spentMilliseconds===after.spentMilliseconds
      && final.availableMilliseconds===after.availableMilliseconds,'Usage acceptance: stop charged twice');
    console.info('Usage acceptance: concurrent HTTP allocation, replay, session isolation and settlement passed');
  },60000);
});
