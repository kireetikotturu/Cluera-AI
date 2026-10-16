import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {handleNativeAccount} from '../lib/accounts/native';
import {creditsRequest,readCredits} from '../lib/accounts/credits';
import {accountConfig} from '../lib/accounts/config';
import {seal} from '../lib/accounts/cookies';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
const mocks=vi.hoisted(()=>({clients:vi.fn()}));vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const origin='https://cluera-ai-staging.vercel.app',uid='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002';
const token=`header.${Buffer.from(JSON.stringify({sub:uid,session_id:sid,iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic`;
let rpc:ReturnType<typeof vi.fn>;
const value={userId:uid,serverTime:'2026-10-09T00:00:00Z',displayName:'Synthetic',availableMilliseconds:900000,reservedMilliseconds:0,spentMilliseconds:0,buckets:[],plans:[],payments:[]};
beforeEach(()=>{
 for(const [k,v] of Object.entries({CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
 NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-service-key-placeholder',
 SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(k,v);
 rpc=vi.fn(async(name:string)=>({data:name==='customer_auth_rate_limit'?true:name==='customer_credits_read'?value:name==='customer_checkout_resume_read'?{code:'NOT_FOUND'}:{code:'ACTIVE',userId:uid,trialSecondsGranted:900,remoteDesktop:false},error:null}));
 mocks.clients.mockReturnValue({auth:{auth:{getUser:vi.fn(async()=>({data:{user:{id:uid,email:'synthetic@example.invalid',email_confirmed_at:'2026-10-09'}},error:null}))}},service:{rpc}});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
const native=(headers:Record<string,string>={})=>new Request(`${origin}/api/account/native/credits`,{headers});
const browser=(query='')=>{const config=accountConfig();return new Request(`${origin}/api/account/credits${query}`,{headers:{cookie:`__Host-sr-account-access=${seal(token,'access',config,3600)}; __Host-sr-account-refresh=${seal('synthetic-refresh','refresh',config,3600)}`}});};
it('native requires live auth, binds owned identity and forbids browser credential paths',async()=>{
 expect((await handleNativeAccount(native(),'credits')).status).toBe(401);
 for(const headers of [{origin},{cookie:'synthetic'},{'sec-fetch-site':'same-origin'}])expect((await handleNativeAccount(native(headers),'credits')).status).toBe(403);
 const r=await handleNativeAccount(native({authorization:`Bearer ${token}`}), 'credits');expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
 expect(await r.json()).toEqual({...value,checkoutAvailable:false});
 expect(rpc).toHaveBeenCalledWith('customer_credits_read',{p_user:uid,p_session:sid});expect(rpc.mock.calls.some(c=>c[0]==='customer_usage_command')).toBe(false);
});
it('browser handoff requires independent cookie auth and exact desktop owner match',async()=>{
 expect((await creditsRequest(native())).status).toBe(401);
 expect((await creditsRequest(browser(`?desktopAccount=${sid}`))).status).toBe(403);
 expect((await creditsRequest(browser(`?desktopAccount=${uid}`))).status).toBe(200);
});
it('reports checkout availability only for the verified, explicitly designated tester',async()=>{
 for(const [key,setting] of Object.entries({PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 const enabled=await handleNativeAccount(native({authorization:`Bearer ${token}`}), 'credits');
 expect(enabled.status).toBe(200);expect((await enabled.json()).checkoutAvailable).toBe(true);
 vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS',sid);
 const denied=await creditsRequest(browser(`?desktopAccount=${uid}`));
 expect(denied.status).toBe(200);expect((await denied.json()).checkoutAvailable).toBe(false);
 expect(rpc.mock.calls.some(c=>c[0]==='customer_usage_command'||c[0]==='customer_checkout_prepare')).toBe(false);
});
it('rejects malformed snapshots, account mismatch and raw fields without leaking them',async()=>{
 for(const data of [{...value,userId:sid},{...value,rawToken:'synthetic-private-field'},{...value,spentMilliseconds:-1}]){
  rpc.mockImplementationOnce(async()=>({data:true,error:null}));rpc.mockImplementationOnce(async()=>({data:{code:'ACTIVE',userId:uid,trialSecondsGranted:900,remoteDesktop:false},error:null}));rpc.mockImplementationOnce(async()=>({data,error:null}));
  const r=await handleNativeAccount(native({authorization:`Bearer ${token}`}), 'credits');expect(r.status).toBe(503);expect(await r.text()).not.toContain('synthetic-private-field');
 }
});
it.each(['CREATING','BOUND','UNCERTAIN'])('withholds new checkout for a server %s attempt without provider/usage writes',async state=>{
 for(const [key,setting] of Object.entries({PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 const read=vi.fn(async(name:string)=>({data:name==='customer_credits_read'?{...value,payments:[{offerCode:'pro_3_hours',state,createdAt:value.serverTime}]}:{code:'PENDING'},error:null}));
 expect((await readCredits(read,{userId:uid,sessionId:sid})).checkoutAvailable).toBe(false);
 expect(read).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledWith('customer_credits_read',{p_user:uid,p_session:sid});
});
it('allows the designated tester after multiple authoritative REJECTED recoveries while preserving failed history',async()=>{
 for(const [key,setting] of Object.entries({PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 const payments=[{offerCode:'pro_3_hours',state:'REJECTED',createdAt:'2026-10-10T04:56:10.219780Z'},
  {offerCode:'pro_3_hours',state:'REJECTED',createdAt:'2026-10-04T09:45:11.323192Z'}];
 const read=vi.fn(async(name:string)=>({data:name==='customer_credits_read'?{...value,payments}:{code:'NOT_FOUND'},error:null}));
 const result=await readCredits(read,{userId:uid,sessionId:sid});
 expect(result.checkoutAvailable).toBe(true);expect(result.payments).toEqual(payments);
 expect(read).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledWith('customer_credits_read',{p_user:uid,p_session:sid});
});
it('a new real UNCERTAIN attempt still blocks after multiple authoritative REJECTED recoveries',async()=>{
 for(const [key,setting] of Object.entries({PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 const payments=[{offerCode:'pro_3_hours',state:'UNCERTAIN',createdAt:value.serverTime},
  {offerCode:'pro_3_hours',state:'REJECTED',createdAt:'2026-10-10T04:56:10.219780Z'},
  {offerCode:'pro_3_hours',state:'REJECTED',createdAt:'2026-10-04T09:45:11.323192Z'}];
 const read=vi.fn(async(name:string)=>({data:name==='customer_credits_read'?{...value,payments}:{code:'PENDING'},error:null}));
 const result=await readCredits(read,{userId:uid,sessionId:sid});
 expect(result.checkoutAvailable).toBe(false);expect(result.payments).toEqual(payments);
 expect(read).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledWith('customer_credits_read',{p_user:uid,p_session:sid});
});
it('a full-history read blocks an older unresolved attempt outside the ten displayed rows without exposing private binding fields',async()=>{
 for(const [key,setting] of Object.entries({PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 const payments=Array.from({length:10},()=>({offerCode:'pro_3_hours',state:'REJECTED',createdAt:value.serverTime}));
 const transactionId='txn_'+'a'.repeat(26);
 const read=vi.fn(async(name:string)=>({data:name==='customer_credits_read'?{...value,payments}:{code:'BOUND',intentId:sid,offerCode:'pro_3_hours',transactionId},error:null}));
 const result=await readCredits(read,{userId:uid,sessionId:sid});expect(result.checkoutAvailable).toBe(false);
 expect(JSON.stringify(result)).not.toContain(transactionId);expect(result).not.toHaveProperty('intentId');
 expect(read).toHaveBeenCalledWith('customer_checkout_resume_read',{p_user_id:uid,p_session_id:sid});
});
it('full-history denial, malformed data and raw credential fields fail closed',async()=>{
 for(const [key,setting] of Object.entries({PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 for(const [data,status] of [[{code:'UNAUTHENTICATED'},401],[{code:'SUSPENDED'},403],[{code:'NOT_FOUND',accessToken:'synthetic-private-field'},503],[{code:'BOUND',intentId:sid,offerCode:'pro_3_hours',transactionId:'bad'},503]] as const){
  const read=vi.fn(async(name:string)=>({data:name==='customer_credits_read'?value:data,error:null}));
  await expect(readCredits(read,{userId:uid,sessionId:sid})).rejects.toMatchObject({status});
 }
});
it('Cluera v2 credits preserve the strict desktop DTO and historical rows without a financial writer',async()=>{
 vi.stubEnv('CLUERA_BILLING_V2_ENABLED','true');
 const payments=[{offerCode:'cluera_pack_3h_v2',state:'VERIFIED',createdAt:value.serverTime},
  {offerCode:'enterprise_weekly',state:'REJECTED',createdAt:value.serverTime}];
 const read=vi.fn(async()=>({data:{...value,availableMilliseconds:11700000,payments},error:null}));
 const result=await readCredits(read,{userId:uid,sessionId:sid});
 expect(result).toEqual({...value,availableMilliseconds:11700000,payments,checkoutAvailable:false});
 expect(read).toHaveBeenCalledExactlyOnceWith('cluera_credits_read',{p_user:uid,p_session:sid});
 expect(result).not.toHaveProperty('intentId');expect(result).not.toHaveProperty('providerKey');
});
it('Cluera v2 checkout availability uses full canonical pending status, never ten displayed rows',async()=>{
 for(const [key,setting] of Object.entries({...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',SIGMAROUND_PAYMENT_TESTER_IDS:uid}))vi.stubEnv(key,setting);
 for(const pending of [null,{intentId:sid,state:'BOUND',kind:'PACK',revisionId:null,offerCode:'pro_3_hours',orderId:'order_syntheticold01',subscriptionId:null,legacy:true}]){
  const read=vi.fn(async(name:string)=>({data:name==='cluera_credits_read'?value:{userId:uid,code:pending?'PENDING':'AVAILABLE',pending,resolvedOrderIds:[],resolvedSubscriptionIds:[]},error:null}));
  expect((await readCredits(read,{userId:uid,sessionId:sid})).checkoutAvailable).toBe(pending===null);
  expect(read.mock.calls.map(c=>c[0])).toEqual(['cluera_credits_read','cluera_billing_status']);
 }
});
