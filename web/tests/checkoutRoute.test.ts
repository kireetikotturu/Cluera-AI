import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {handleAccount} from '../lib/accounts/handler';
import {accountConfig} from '../lib/accounts/config';
import {seal} from '../lib/accounts/cookies';
const mocks=vi.hoisted(()=>({clients:vi.fn(),prepare:vi.fn(),resume:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/billing/checkout/service',async original=>({...await original<object>(),checkoutService:()=>({prepare:mocks.prepare})}));
vi.mock('../lib/billing/checkout/resume',()=>({resumeSandboxCheckout:mocks.resume}));
const origin='https://cluera-ai-staging.vercel.app';
const uid='00000000-0000-4000-8000-000000000991',sid='00000000-0000-4000-8000-000000000992';
const access=`header.${Buffer.from(JSON.stringify({sub:uid,session_id:sid,iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic`;
let rpc:ReturnType<typeof vi.fn>,getUser:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  for(const [k,v] of Object.entries({CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,
    NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',
    PADDLE_ENVIRONMENT:'sandbox',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-private-service-key',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(k,v);
  rpc=vi.fn(async(name:string)=>({data:name==='customer_auth_rate_limit'?true:{code:'ACTIVE',userId:uid,trialSecondsGranted:900,remoteDesktop:false},error:null}));
  getUser=vi.fn(async()=>({data:{user:{id:uid,email:'synthetic@example.invalid',email_confirmed_at:'2026-10-04',is_anonymous:false}},error:null}));
  mocks.clients.mockReturnValue({auth:{auth:{getUser}},service:{rpc},flow:()=>({})});
  mocks.prepare.mockResolvedValue({code:'BOUND',intentId:uid,transactionId:'txn_'+'a'.repeat(26)});
  mocks.resume.mockResolvedValue({code:'RESUMABLE',offerCode:'pro_3_hours',transactionId:'txn_'+'a'.repeat(26)});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
function request(body:object={requestId:uid,offerCode:'pro_3_hours'},signed=true,from=origin,recovery=false){
  const config=accountConfig();
  const cookie=signed?`__Host-sr-account-access=${seal(access,'access',config,3600)}; __Host-sr-account-refresh=${seal('synthetic-refresh','refresh',config,3600)}`
    +(recovery?`; __Host-sr-account-recovery=${seal(sid,'recovery',config,600)}`:''):'';
  return new Request(`${origin}/api/account/checkout`,{method:'POST',headers:{origin:from,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
}
describe('staging-only account-bound checkout route',()=>{
  function resume(expected=uid,headers:Record<string,string>={origin}) {
    const signed=request();return new Request(`${origin}/api/account/checkout-resume?expectedAccountId=${expected}`,{headers:{cookie:signed.headers.get('cookie')!,...headers}});
  }
  it('resume is an owned no-store GET, with no create and no buyer-selected transaction',async()=>{
    const response=await handleAccount(resume(),'checkout-resume');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.resume).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({userId:uid,sessionId:sid}));expect(mocks.prepare).not.toHaveBeenCalled();
    expect((await handleAccount(resume(uid,{'sec-fetch-site':'same-origin',referer:origin+'/account/checkout'}),'checkout-resume')).status).toBe(200);
    for(const invalid of [resume(sid),resume(uid,{origin:'https://attacker.invalid'}),resume(uid,{}),resume(uid,{'sec-fetch-site':'cross-site',referer:origin}),
      new Request(resume().url+'&transactionId=txn_'+'a'.repeat(26),{headers:resume().headers}),new Request(resume().url,{method:'POST',headers:resume().headers})]){
      expect((await handleAccount(invalid,'checkout-resume')).status).not.toBe(200);
    }
    expect(mocks.resume).toHaveBeenCalledTimes(2);
  });
  it('resume preserves pending and gates paused/non-tester/recovery/no-session without provider read',async()=>{
    mocks.resume.mockResolvedValueOnce({code:'PENDING'});expect((await handleAccount(resume(),'checkout-resume')).status).toBe(409);
    mocks.resume.mockClear();vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS',sid);expect((await handleAccount(resume(),'checkout-resume')).status).toBe(403);
    vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS',uid);
    const recovery=request(undefined,true,origin,true);expect((await handleAccount(new Request(resume().url,{headers:{origin,cookie:recovery.headers.get('cookie')!}}),'checkout-resume')).status).toBe(403);
    expect((await handleAccount(new Request(resume().url,{headers:{origin}}),'checkout-resume')).status).toBe(401);
    vi.stubEnv('SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','true');expect((await handleAccount(resume(),'checkout-resume')).status).toBe(404);
    expect(mocks.resume).not.toHaveBeenCalled();expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('denies a verified but non-designated buyer before catalog, intent or provider creation',async()=>{
    vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS',sid);
    expect((await handleAccount(request(),'checkout')).status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('does not contact Paddle while payments are paused or pause configuration is missing',async()=>{
    for(const value of ['true','']){vi.stubEnv('SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED',value);expect((await handleAccount(request(),'checkout')).status).toBe(404);}
    expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.clients).not.toHaveBeenCalled();
  });
  it('rejects a changed browser account without creating a checkout',async()=>{
    expect((await handleAccount(request({requestId:uid,offerCode:'pro_3_hours',expectedAccountId:sid}),'checkout')).status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect((await handleAccount(request({requestId:uid,offerCode:'pro_3_hours',expectedAccountId:uid}),'checkout')).status).toBe(200);
  });
  it('does nothing while private enablement gate is absent, even with client token',async()=>{
    vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','false');
    expect((await handleAccount(request(),'checkout')).status).toBe(404);expect(mocks.clients).not.toHaveBeenCalled();
  });
  it('rejects production project/live mode before any network call',async()=>{
    const validRequest=request();
    for(const [key,value] of [['NEXT_PUBLIC_SUPABASE_URL','https://bzccuqforilpifhiysjk.supabase.co'],['PADDLE_ENVIRONMENT','live']]){
      const prior=process.env[key];vi.stubEnv(key,value);expect((await handleAccount(validRequest.clone(),'checkout')).status).toBe(404);vi.stubEnv(key,prior!);
    }
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('requires signed-in verified account and same origin; blocks recovery session',async()=>{
    expect((await handleAccount(request(undefined,false),'checkout')).status).toBe(401);
    expect((await handleAccount(request(undefined,true,'https://attacker.invalid'),'checkout')).status).toBe(403);
    expect((await handleAccount(request(undefined,true,origin,true),'checkout')).status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('rejects client user/price/amount/success fields and maps only verified identity',async()=>{
    const input={requestId:uid,offerCode:'pro_3_hours'};
    expect((await handleAccount(request({...input,userId:sid,paid:true}),'checkout')).status).toBe(400);
    const response=await handleAccount(request(input),'checkout');expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({userId:uid,sessionId:sid}),input);
    expect(rpc.mock.calls.some(([name])=>name.startsWith('account_admin_'))).toBe(false);
    for(const forged of [{priceId:'pri_'+'a'.repeat(26)},{amount:'1'},{customerId:uid},{subjectId:uid}]){
      expect((await handleAccount(request({...input,...forged}),'checkout')).status).toBe(400);
    }
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(await response.text()).not.toMatch(/synthetic-private|synthetic-refresh|access_token/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rate-limit and account suspension stop checkout creation',async()=>{
    rpc.mockResolvedValueOnce({data:{code:'SUSPENDED'},error:null});expect((await handleAccount(request(),'checkout')).status).toBe(403);
    rpc.mockImplementation(async name=>({data:name==='customer_auth_rate_limit'?false:{code:'ACTIVE',userId:uid,trialSecondsGranted:900,remoteDesktop:false},error:null}));
    expect((await handleAccount(request(),'checkout')).status).toBe(429);expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
