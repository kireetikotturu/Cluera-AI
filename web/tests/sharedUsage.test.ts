import { describe,it,expect,vi } from 'vitest';
import { usageService } from '../lib/usage/service';
const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
  NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co'};
const who={userId:'00000000-0000-4000-8000-000000000701',sessionId:'00000000-0000-4000-8000-000000000702'};
const input={runId:'00000000-0000-4000-8000-000000000703',sequence:0,action:'START' as const};
const active={code:'ACTIVE',...input,serverTime:'2026-10-04T00:00:00Z',expiresAt:'2026-10-04T00:00:30Z',
  reservedMilliseconds:30000,allocation:'TRIAL'};
describe('staging server usage adapter',()=>{
  it('fails closed outside the dedicated staging targets',()=>{
    for(const change of [{SIGMAROUND_ACCOUNTS_ENABLED:'false'},{NEXT_PUBLIC_SUPABASE_URL:'https://bzccuqforilpifhiysjk.supabase.co'},
      {SIGMAROUND_ACCOUNT_ORIGIN:'https://sigma-round-ai-01-eight.vercel.app'}]) {
      const rpc=vi.fn(); expect(()=>usageService(rpc,{...env,...change})).toThrow('UNAVAILABLE'); expect(rpc).not.toHaveBeenCalled();
    }
  });
  it('uses only verified identity and fixed RPC parameters, never client elapsed time',async()=>{
    const rpc=vi.fn(async()=>({data:active,error:null})); let time=100;
    const service=usageService(rpc,env,()=>{time+=200;return time;});
    expect(await service.command(who,input)).toMatchObject({code:'ACTIVE',validForMilliseconds:29800});
    expect(rpc).toHaveBeenCalledWith('customer_usage_command',{p_user_id:who.userId,p_session_id:who.sessionId,p_run_id:input.runId,p_sequence:0,p_action:'START'});
    await expect(service.command(who,{...input,elapsedSeconds:0} as never)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledOnce();
  });
  it('cannot extend an expired, delayed, malformed or mismatched authorization',async()=>{
    let time=0; const service=usageService(async()=>({data:active,error:null}),env,()=>{time+=31000;return time;});
    expect(await service.command(who,input)).toEqual({code:'EXPIRED'});
    for(const data of [{...active,runId:who.userId},{...active,sequence:9},{...active,expiresAt:'2026-10-04T00:01:00Z'}]) {
      await expect(usageService(async()=>({data,error:null}),env).command(who,input)).rejects.toThrow('UNAVAILABLE');
    }
  });
  it('does not grant fallback access on RPC failure or account denial',async()=>{
    const secret='synthetic-sensitive-error';
    await expect(usageService(async()=>({data:null,error:{message:secret},status:503}),env).command(who,input))
      .rejects.toThrow('Supabase operation failed.');
    for(const code of ['UNAUTHENTICATED','SUSPENDED','FORBIDDEN']) {
      await expect(usageService(async()=>({data:{code},error:null}),env).command(who,input)).rejects.toThrow();
    }
    expect(await usageService(async()=>({data:{code:'EXHAUSTED'},error:null}),env).command(who,input)).toEqual({code:'EXHAUSTED'});
  });
  it('returns only safe balance fields and never invokes a spending command for reads',async()=>{
    const rpc=vi.fn(async()=>({data:{code:'ACTIVE',availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0,secret:'do-not-forward'},error:null}));
    const result=await usageService(rpc,env).balance(who);
    expect(result).not.toHaveProperty('secret');
    expect(rpc).toHaveBeenCalledWith('customer_usage_balance',{p_user_id:who.userId,p_session_id:who.sessionId});
  });
});
