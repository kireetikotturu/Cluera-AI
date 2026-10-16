import {describe,it,expect,vi} from 'vitest';
import {handleBillingTick} from '../lib/billing/reconciliation/runner';
const secret='synthetic-worker-secret-for-tests-only';
const env={CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
  SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_RECONCILIATION_ENABLED:'true',
  SIGMAROUND_BILLING_WORKER_SECRET:secret,SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-service'};
const request=(auth=`Bearer ${secret}`,method='POST',query='')=>new Request(`https://cluera-ai-staging.vercel.app/api/internal/billing/tick${query}`,{method,headers:{authorization:auth}});
function deps(){return {rpc:vi.fn(),reconcile:vi.fn(async()=> 'EMPTY'),action:vi.fn(async()=> 'EMPTY')};}
describe('private bounded staging billing runner',()=>{
  it('fails closed before any database/provider access when disabled or target differs',async()=>{
    const d=deps();
    for(const override of [{SIGMAROUND_PADDLE_SANDBOX_RECONCILIATION_ENABLED:'false'},{PADDLE_ENVIRONMENT:'live'},
      {NEXT_PUBLIC_SUPABASE_URL:'https://bzccuqforilpifhiysjk.supabase.co'}]){
      expect((await handleBillingTick(request(),{...env,...override},d)).status).toBe(404);
    }
    expect(d.reconcile).not.toHaveBeenCalled();expect(d.rpc).not.toHaveBeenCalled();
  });
  it('requires a private strong secret and authenticated POST without selectors',async()=>{
    const d=deps();
    expect((await handleBillingTick(request(),{...env,SIGMAROUND_BILLING_WORKER_SECRET:''},d)).status).toBe(503);
    for(const auth of ['', 'Bearer invalid', 'x'.repeat(1000)])expect((await handleBillingTick(request(auth),env,d)).status).toBe(401);
    expect((await handleBillingTick(request(undefined,'GET'),env,d)).status).toBe(400);
    expect((await handleBillingTick(request(undefined,'POST','?account=other'),env,d)).status).toBe(400);
    expect(d.reconcile).not.toHaveBeenCalled();
  });
  it('runs exactly one job and no Paddle mutation when action gate is off',async()=>{
    const d=deps(),r=await handleBillingTick(request(),env,d);
    expect(await r.json()).toEqual({processed:true});expect(r.headers.get('cache-control')).toBe('no-store');
    expect(d.reconcile).toHaveBeenCalledTimes(1);expect(d.action).not.toHaveBeenCalled();
  });
  it('runs one outbox action only under its separate gate',async()=>{
    const d=deps();expect((await handleBillingTick(request(),{...env,SIGMAROUND_PADDLE_SANDBOX_BILLING_ACTIONS_ENABLED:'true'},d)).status).toBe(200);
    expect(d.action).toHaveBeenCalledTimes(1);
  });
  it('returns bounded errors without sensitive exceptions',async()=>{
    const d=deps();d.reconcile.mockRejectedValue(new Error('private provider body'));
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{const r=await handleBillingTick(request(),env,d);expect(r.status).toBe(503);
      expect(await r.text()).not.toContain('private');expect(JSON.stringify(log.mock.calls)).not.toContain('private provider body');
    }finally{log.mockRestore();}
  });
});
