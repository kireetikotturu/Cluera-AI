import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clueraBillingAdminRequest } from '../lib/payments/cluera/admin';
import { handleClueraCatalog, handleClueraCheckout } from '../lib/payments/cluera/handler';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,rateLimit:mocks.limit}));
const origin='https://cluera-ai-staging.vercel.app',actor=paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS,sid='00000000-0000-4000-8000-000000000002',factor='00000000-0000-4000-8000-000000000003',revisionId='00000000-0000-4000-8000-000000000004';
const pack={revisionId,offerCode:'cluera_pack_3h_v2',name:'Cluera 3 Hours',amountPaise:54900,currency:'INR',allowanceSeconds:10800,
  kind:'PACK',interval:null,razorpayPlanId:null,enabled:false,version:1,totalCount:null,testPlanValidated:true};
let rpc:any,mfa:any,getUser:any,token:string;
const body=()=>({action:'CREATE_REVISION',operationId:crypto.randomUUID(),offerCode:pack.offerCode,expectedRevisionId:revisionId,
  reason:'Owner-approved future price policy',factorId:factor,code:'123456',input:{name:'Cluera 4 Hours',amountPaise:60000,allowanceSeconds:14400,razorpayPlanId:null,totalCount:null}});
const request=(path:string,input?:object,headers:Record<string,string>={})=>new Request(`${origin}/api/account/payments/cluera/${path}`,input?{method:'POST',headers:{origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)}:{headers});
beforeEach(()=>{
  for(const [key,value] of Object.entries({...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
  token=`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:sid})).toString('base64url')}.synthetic`;
  mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:token,refresh_token:'synthetic-refresh'}});
  mocks.limit.mockResolvedValue(undefined);
  mfa={listFactors:vi.fn(async()=>({data:{all:[{id:factor,status:'verified',factor_type:'totp'}]},error:null})),challengeAndVerify:vi.fn(async()=>({data:{access_token:token,refresh_token:'synthetic-new-refresh',expires_in:3600},error:null}))};
  getUser=vi.fn(async()=>({data:{user:{id:actor,email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}},error:null}));
  rpc=vi.fn(async(name:string)=>({data:name==='account_admin_check'?true:name==='cluera_billing_admin_read'?{code:'ACTIVE',catalog:[pack]}:name==='cluera_billing_admin_mutate'?{code:'APPLIED',revision:{...pack,version:2}}:name==='cluera_billing_catalog'?[pack]:null,error:null}));
  mocks.clients.mockReturnValue({service:{rpc},auth:{auth:{setSession:vi.fn(async()=>({error:null})),getUser,mfa}}});
  vi.stubGlobal('fetch',vi.fn());
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
it('default false V2 gate blocks checkout before auth or new financial schema',async()=>{
  vi.stubEnv('CLUERA_BILLING_V2_ENABLED','false');expect((await handleClueraCheckout(request('checkout',{expectedAccountId:actor,requestId:crypto.randomUUID(),revisionId}))).status).toBe(404);
  expect((await handleClueraCatalog(request('catalog'))).status).toBe(503);expect(mocks.clients).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
it('Admin schema-required state still enforces current Admin Auth but invokes no new schema or provider',async()=>{
  vi.stubEnv('CLUERA_BILLING_V2_ENABLED','false');const response=await clueraBillingAdminRequest(request('admin'));
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'BILLING_SCHEMA_APPROVAL_REQUIRED'});
  expect(rpc.mock.calls.map(([name]:any)=>name)).toEqual(['account_admin_check']);expect(fetch).not.toHaveBeenCalled();
});
it.each(['aal1','non-admin','foreign-origin','cross-site','step-up-denied','changed-owner','changed-session','unverified-factor','old-revision'])('Admin rejects %s before catalog mutation/provider work',async failure=>{
  let req=request('admin',body());
  if(failure==='aal1')mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1',session_id:sid})).toString('base64url')}.synthetic`}});
  if(failure==='non-admin')rpc.mockResolvedValue({data:false,error:null});
  if(failure==='foreign-origin')req=request('admin',body(),{origin:'https://attacker.invalid'});
  if(failure==='cross-site')req=request('admin',body(),{'sec-fetch-site':'cross-site'});
  if(failure==='step-up-denied')mfa.challengeAndVerify.mockResolvedValue({data:null,error:{message:'never-reflect-raw'}});
  if(failure==='changed-owner')getUser.mockResolvedValue({data:{user:{id:factor,email_confirmed_at:'x'}},error:null});
  if(failure==='changed-session')mfa.challengeAndVerify.mockResolvedValue({data:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:factor})).toString('base64url')}.synthetic`},error:null});
  if(failure==='unverified-factor')mfa.listFactors.mockResolvedValue({data:{all:[{id:factor,factor_type:'totp',status:'unverified'}]},error:null});
  if(failure==='old-revision')req=request('admin',{...body(),expectedRevisionId:factor});
  const response=await clueraBillingAdminRequest(req);expect(response.status).toBe(failure==='old-revision'?409:403);
  expect(JSON.stringify(await response.json())).not.toContain('never-reflect');expect(rpc.mock.calls.some(([name]:any)=>name==='cluera_billing_admin_mutate')).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
it('future revision price/time edits require fresh MFA and immutable CAS, never tokens/code or historical mutation',async()=>{
  const input=body(),response=await clueraBillingAdminRequest(request('admin',input));expect(response.status).toBe(200);
  const call=rpc.mock.calls.find(([name]:any)=>name==='cluera_billing_admin_mutate')[1];
  expect(call).toMatchObject({p_actor:actor,p_session:sid,p_operation:input.operationId,p_expected_revision:revisionId,p_reason:input.reason,p_input:input.input});
  expect(JSON.stringify(call)).not.toContain('123456');expect(call).not.toHaveProperty('factorId');expect(call).not.toHaveProperty('code');
  expect(mfa.challengeAndVerify).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();expect(rpc.mock.calls.some(([name]:any)=>/apply|grant|prepare|bind/.test(name))).toBe(false);
  const result=await response.json();expect(result.revision).not.toHaveProperty('razorpayPlanId');expect(response.headers.get('cache-control')).toBe('no-store');
});
it('Admin and public catalog return only strict browser-safe revision metadata',async()=>{
  const admin=await clueraBillingAdminRequest(request('admin'));expect(admin.status).toBe(200);expect(await admin.json()).toEqual({code:'ACTIVE',catalog:[Object.fromEntries(Object.entries(pack).filter(([key])=>key!=='razorpayPlanId'))]});
  const catalog=await handleClueraCatalog(request('catalog'));expect(catalog.status).toBe(200);expect((await catalog.json()).catalog[0]).not.toHaveProperty('razorpayPlanId');expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
});
it('Admin operation lookup is read-only and never restarts a lost mutation',async()=>{
  rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:{code:'NOT_FOUND'},error:null}));
  const response=await clueraBillingAdminRequest(request(`admin?operation=${crypto.randomUUID()}`));expect(response.status).toBe(200);expect(await response.json()).toEqual({code:'PENDING'});
  expect(mfa.challengeAndVerify).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(rpc.mock.calls.some(([name]:any)=>name==='cluera_billing_admin_mutate')).toBe(false);
});
it.each([{offerCode:'enterprise_weekly'},{input:{name:'Cluera bad',amountPaise:0,allowanceSeconds:900,razorpayPlanId:null,totalCount:null}},
  {input:{name:'Cluera bad',amountPaise:100,allowanceSeconds:900,razorpayPlanId:'plan_synthetic0001',totalCount:120}},{endpoint:'https://attacker.invalid'},{reason:'short'}])('rejects unapproved policy/legacy alias/provider host %j',async patch=>{
  const response=await clueraBillingAdminRequest(request('admin',{...body(),...patch}));expect(response.status).toBe(400);expect(mfa.challengeAndVerify).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it('customer cannot inject owner, amount, plan or grant into create; recovery and non-tester remain denied',async()=>{
  const normal={expectedAccountId:actor,requestId:crypto.randomUUID(),revisionId};
  expect((await handleClueraCheckout(request('checkout',{...normal,amountPaise:1}))).status).toBe(400);
  expect((await handleClueraCheckout(request('checkout',{...normal,expectedAccountId:factor}))).status).toBe(403);
  mocks.session.mockResolvedValue({account:{userId:factor,sessionId:sid,email:'user@example.invalid'},session:{access_token:token,refresh_token:'x'}});
  expect((await handleClueraCheckout(request('checkout',{...normal,expectedAccountId:factor}))).status).toBe(403);expect(fetch).not.toHaveBeenCalled();
});
it('unauthenticated/cross-origin rejects before any financial RPC, without reflecting tokens',async()=>{
  mocks.session.mockRejectedValue(new (await import('../lib/accounts/config')).AccountError('UNAUTHENTICATED',401));
  const denied=await handleClueraCheckout(request(`checkout?expectedAccountId=${actor}`));expect(denied.status).toBe(401);expect(await denied.json()).toEqual({error:'Sign in with a verified email.'});
  expect((await handleClueraCheckout(request('checkout',{expectedAccountId:actor,requestId:crypto.randomUUID(),revisionId},{origin:'https://foreign.invalid'}))).status).toBe(403);expect(rpc).not.toHaveBeenCalled();
});
