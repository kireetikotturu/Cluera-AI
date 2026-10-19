import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resumeClueraCheckout, handleClueraCheckoutResume } from '../lib/payments/cluera/checkoutResume';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { merchantDigest } from '../lib/payments/cluera/config';
import { GET } from '../app/api/account/payments/cluera/resume/route';
import { AccountError } from '../lib/accounts/config';
import { AccountCookies } from '../lib/accounts/cookies';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const hooks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:hooks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:hooks.session,rateLimit:hooks.limit}));
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'},site=env.SIGMAROUND_ACCOUNT_ORIGIN;
const account={userId:env.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:'00000000-0000-4000-8000-000000000002'};
const foreign='00000000-0000-4000-8000-000000000003',intentId='00000000-0000-4000-8000-000000000004',revisionId='00000000-0000-4000-8000-000000000005';
const orderId='order_resumecluera0001',notes={cluera_intent:intentId,cluera_revision:revisionId,cluera_environment:'test'};
const revision={revisionId,offerCode:'cluera_pack_3h_v2',name:'Cluera original pack',amountPaise:54900,currency:'INR',allowanceSeconds:10800,
 kind:'PACK',interval:null,razorpayPlanId:null,totalCount:null,version:1,testPlanValidated:true,enabled:true};
const pending={legacy:false,intentId,state:'BOUND',kind:'PACK',revisionId,offerCode:revision.offerCode,orderId,subscriptionId:null};
const status=()=>({userId:account.userId,code:'PENDING',pending,resolvedOrderIds:[],resolvedSubscriptionIds:[]});
const binding=()=>({legacy:false,code:'BOUND',intentId,userId:account.userId,orderId,subscriptionId:null,revision});
const order={id:orderId,entity:'order',amount:54900,currency:'INR',status:'created',amount_paid:0,amount_due:54900,attempts:0,receipt:intentId,notes,offer_id:null,partial_payment:false};
let rpc:ReturnType<typeof vi.fn>;
function provider(patch:Record<string,unknown>={},collection:unknown={entity:'collection',count:0,items:[]}) {
 return vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  expect(init?.method).toBe('GET');expect(init?.body).toBeUndefined();expect(init?.redirect).toBe('error');
  expect(String(url)).toMatch(/^https:\/\/api\.razorpay\.com\/v1\/orders\/order_resumecluera0001(?:\/payments)?$/);
  return Response.json(String(url).endsWith('/payments')?collection:{...order,...patch});
 });
}
const request=(query=`expectedAccountId=${account.userId}`,headers:HeadersInit={},method='GET')=>new Request(`${site}/api/account/payments/cluera/resume${query?'?'+query:''}`,{method,headers});
beforeEach(()=>{
 for(const [key,value]of Object.entries(env))vi.stubEnv(key,value);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_synthetic_public_key_00000000000000000');
 vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64',Buffer.alloc(32,3).toString('base64'));vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',Buffer.alloc(32,4).toString('base64'));
 hooks.session.mockResolvedValue({account:{...account,email:'synthetic@example.invalid'},session:{}});hooks.limit.mockResolvedValue(undefined);
 rpc=vi.fn(async(name,args)=>({data:name==='cluera_billing_owner'?args.p_account_digest===merchantDigest(env)?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'}
  :name==='cluera_billing_status'?status():name==='cluera_billing_binding'?binding():null,error:null}));hooks.clients.mockReturnValue({service:{rpc}});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network fallback');}));
});
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});

it('returns only the untouched original owned pack for explicit SDK continuation using canonical GETs, never a new order or mutation',async()=>{
 const request=provider(),value=await resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request));
 expect(value).toEqual({code:'BOUND',kind:'PACK',orderId,subscriptionId:null,keyId:env.RAZORPAY_TEST_KEY_ID,amountPaise:54900,currency:'INR',revisionId,offerCode:revision.offerCode});
 expect(request).toHaveBeenCalledTimes(2);expect(rpc.mock.calls.map(([name])=>name)).toEqual(['cluera_billing_owner','cluera_billing_owner','cluera_billing_status','cluera_billing_binding','cluera_billing_owner','cluera_billing_owner','cluera_billing_status','cluera_billing_binding']);
 expect(JSON.stringify(value)).not.toMatch(/intentId|claimId|notes|keySecret|razorpayPlanId/);expect(fetch).not.toHaveBeenCalled();
});
it('does not require a nonexistent recurring-plan verification for a one-time pack binding',async()=>{
 rpc.mockImplementation(async(name,args)=>({data:name==='cluera_billing_owner'?args.p_account_digest===merchantDigest(env)?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'}
  :name==='cluera_billing_status'?status():{...binding(),revision:{...revision,testPlanValidated:false}},error:null}));
 const request=provider();expect((await resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).orderId).toBe(orderId);
 expect(request).toHaveBeenCalledTimes(2);
});
it.each([{status:'attempted'},{status:'paid',amount_paid:54900,amount_due:0},{attempts:1},{amount_paid:'0'},{amount_paid:null},{amount_due:54899},{amount:1},
 {receipt:foreign},{notes:{...notes,cluera_intent:foreign}},{notes:{...notes,cluera_revision:foreign}},{notes:{...notes,cluera_environment:'live'}},{id:'order_foreign0001'}])('strict original-order proof refuses%j with no normalization or mutation',async patch=>{
 const request=provider(patch);await expect(resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).rejects.toThrow();expect(request.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
it.each(['authorized','failed','captured','unknown'])('any associated%s payment blocks continuation even if the order claims zero attempts',async state=>{
 const request=provider({}, {entity:'collection',count:1,items:[{id:'pay_resumeexisting0001',status:state}]});
 await expect(resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).rejects.toThrow();expect(request).toHaveBeenCalledTimes(2);
});
it.each([{legacy:true},{state:'UNCERTAIN'},{state:'CREATING'},{kind:'RECURRING',orderId:null,subscriptionId:'sub_resumeexisting0001'}])('legacy/unknown/attempted mandate state%j cannot contact the provider',async patch=>{
 rpc.mockImplementation(async(name,args)=>({data:name==='cluera_billing_owner'?args.p_account_digest===merchantDigest(env)?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'}:{...status(),pending:{...pending,...patch}},error:null}));
 const request=provider();await expect(resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
it.each(['disabled-revision','foreign-owner','foreign-intent','resolved-after-provider','changed-owner-epoch'])('server%scannot return an SDK binding after provider reads',async failure=>{
 let statusReads=0,ownerReads=0;
 rpc.mockImplementation(async(name,args)=>{
  let data:unknown=null;
  if(name==='cluera_billing_owner')data=args.p_account_digest===merchantDigest(env)?{code:'ACTIVE',owner:'cluera',epoch:failure==='changed-owner-epoch'&&++ownerReads>1?2:1}:{code:'CONFLICT'};
  if(name==='cluera_billing_status')data=failure==='resolved-after-provider'&&++statusReads>1?{...status(),code:'AVAILABLE',pending:null}:status();
  if(name==='cluera_billing_binding')data=failure==='disabled-revision'?{...binding(),revision:{...revision,enabled:false}}:failure==='foreign-owner'?{...binding(),userId:foreign}:failure==='foreign-intent'?{...binding(),intentId:foreign}:binding();
  return {data,error:null};
 });
 const request=provider();await expect(resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).rejects.toThrow();expect(request.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
it('guarded GET route independently authorizes the current owner and returns no-store, with zero writes',async()=>{
 expect(GET).toBe(handleClueraCheckoutResume);const network=provider();vi.stubGlobal('fetch',network);
 const response=await handleClueraCheckoutResume(request());expect(response.status).toBe(200);expect((await response.json()).payment.orderId).toBe(orderId);expect(response.headers.get('cache-control')).toBe('no-store');
 expect(network.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
it('disabled checkout, foreign origins/owners, recovery, non-testers and injected resource/query cannot reach financial/provider reads',async()=>{
 vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','false');expect((await handleClueraCheckoutResume(request())).status).toBe(404);expect(hooks.clients).not.toHaveBeenCalled();
 vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','true');
 for(const value of [request(undefined,{origin:'https://foreign.invalid'}),request(undefined,{'sec-fetch-site':'cross-site'}),request(`expectedAccountId=${foreign}`),request(`expectedAccountId=${account.userId}&orderId=${orderId}`),request(`expectedAccountId=${account.userId}&expectedAccountId=${account.userId}`)])
  expect([400,403]).toContain((await handleClueraCheckoutResume(value)).status);
 vi.spyOn(AccountCookies.prototype,'get').mockReturnValue(account.sessionId);expect((await handleClueraCheckoutResume(request())).status).toBe(403);
 expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('resume keeps401/429, masks private provider failures and never authorizes a replacement attempt',async()=>{
 hooks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));expect((await handleClueraCheckoutResume(request())).status).toBe(401);
 hooks.limit.mockRejectedValueOnce(new AccountError('RATE_LIMITED',429));expect((await handleClueraCheckoutResume(request())).status).toBe(429);
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...order,amount_paid:'0',private:'SYNTHETIC_PRIVATE_RECORD'})));
 const response=await handleClueraCheckoutResume(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_RECORD');
});
