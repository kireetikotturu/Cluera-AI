import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clueraBillingAdminRequest } from '../lib/payments/cluera/admin';
import { handleClueraCatalog, handleClueraCheckout } from '../lib/payments/cluera/handler';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import * as planSync from '../lib/payments/cluera/planSync';
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
it('billing throttling retains HTTP429 and safe guidance before any financial operation',async()=>{
  mocks.limit.mockRejectedValue(new (await import('../lib/accounts/config')).AccountError('RATE_LIMITED',429));
  const response=await handleClueraCheckout(request(`checkout?expectedAccountId=${actor}`));
  expect(response.status).toBe(429);expect(await response.json()).toEqual({error:'Too many billing requests. Please wait before checking again. Do not retry a payment.'});
  expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});

it('an authenticated non-tester gets an eligibility code without clearing the session or reading another owner',async()=>{
  mocks.session.mockResolvedValue({account:{userId:factor,sessionId:sid,email:'customer@example.invalid'},session:{}});
  const clear=vi.spyOn((await import('../lib/accounts/cookies')).AccountCookies.prototype,'clear');
  try {
    const response=await handleClueraCheckout(request(`checkout?expectedAccountId=${factor}`));
    expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'TEST_PURCHASER_REQUIRED'});
    expect(clear).not.toHaveBeenCalled();expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  } finally {clear.mockRestore();}
});
it('a different account and a password-recovery session have distinct denial codes',async()=>{
  const response=await handleClueraCheckout(request(`checkout?expectedAccountId=${factor}`));
  expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'ACCOUNT_MISMATCH'});
  const get=vi.spyOn((await import('../lib/accounts/cookies')).AccountCookies.prototype,'get').mockReturnValue(sid);
  try {const recovery=await handleClueraCheckout(request(`checkout?expectedAccountId=${actor}`));
    expect(recovery.status).toBe(403);expect(await recovery.json()).toMatchObject({code:'RECOVERY_SESSION'});
  } finally {get.mockRestore();}
  expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it.each(['GET','POST'])('account switching to an unapproved purchaser reports mismatch before eligibility for %s',async method=>{
  mocks.session.mockResolvedValue({account:{userId:factor,sessionId:sid,email:'customer@example.invalid'},session:{}});
  const response=await handleClueraCheckout(method==='GET'?request(`checkout?expectedAccountId=${actor}`)
    :request('checkout',{expectedAccountId:actor,requestId:crypto.randomUUID(),revisionId}));
  expect(response.status).toBe(403);expect(await response.json()).toMatchObject({code:'ACCOUNT_MISMATCH'});
  expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});

const monthly={...pack,offerCode:'cluera_monthly_40h_v2',kind:'RECURRING',interval:'MONTH',amountPaise:549900,allowanceSeconds:144000,totalCount:120};
const planBody=()=>({...body(),action:'CREATE_TEST_PLAN',offerCode:monthly.offerCode,input:{name:monthly.name,amountPaise:549900,allowanceSeconds:144000,totalCount:120}});
function monthlyAdmin(){rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:name==='cluera_billing_admin_read'?{code:'ACTIVE',catalog:[monthly]}:null,error:null}));}
it.each(['aal1','non-admin','foreign-origin','cross-site','step-up-denied','changed-owner','changed-session','unverified-factor','old-revision','live-setting'])('plan sync refuses %s before durable claim/provider creation',async failure=>{
 monthlyAdmin();let req=request('admin',planBody());
 if(failure==='aal1')mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1',session_id:sid})).toString('base64url')}.synthetic`}});
 if(failure==='non-admin')rpc.mockResolvedValue({data:false,error:null});
 if(failure==='foreign-origin')req=request('admin',planBody(),{origin:'https://attacker.invalid'});
 if(failure==='cross-site')req=request('admin',planBody(),{'sec-fetch-site':'cross-site'});
 if(failure==='step-up-denied')mfa.challengeAndVerify.mockResolvedValue({data:null,error:{message:'private'}});
 if(failure==='changed-owner')getUser.mockResolvedValue({data:{user:{id:factor,email_confirmed_at:'x'}},error:null});
 if(failure==='changed-session')mfa.challengeAndVerify.mockResolvedValue({data:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:factor})).toString('base64url')}.synthetic`},error:null});
 if(failure==='unverified-factor')mfa.listFactors.mockResolvedValue({data:{all:[]},error:null});
 if(failure==='old-revision')req=request('admin',{...planBody(),expectedRevisionId:factor});
 if(failure==='live-setting')vi.stubEnv('RAZORPAY_ENVIRONMENT','live');
 const sync=vi.spyOn(planSync,'syncTestPlan');try{
  expect((await clueraBillingAdminRequest(req)).status).toBeGreaterThanOrEqual(400);expect(sync).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 }finally{sync.mockRestore();}
});
it.each(['CREATE_TEST_PLAN','RECONCILE_TEST_PLAN'])('fresh MFA precedes %s and unknown post-claim validation is 503 with secure cookies',async action=>{
 monthlyAdmin();const sync=vi.spyOn(planSync,'syncTestPlan').mockImplementation(async()=>{expect(mfa.challengeAndVerify).toHaveBeenCalledTimes(1);throw Error('private provider details');});
 try{const input=action==='CREATE_TEST_PLAN'?planBody():{action,operationId:crypto.randomUUID(),factorId:factor,code:'123456',input:{razorpayPlanId:null}};
 const response=await clueraBillingAdminRequest(request('admin',input));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'PLAN_SYNC_PENDING_REVIEW'});
 expect(response.headers.get('set-cookie')).toContain('HttpOnly');expect(response.headers.get('cache-control')).toContain('no-store');expect(sync).toHaveBeenCalledTimes(1);
 }finally{sync.mockRestore();}
});
it('Admin Test plan read exposes only validated plan mappings and own pending operations, with no provider call',async()=>{
 rpc.mockImplementation(async(name:string)=>({data:name==='account_admin_check'?true:name==='cluera_billing_plan_sync_read'?{code:'ACTIVE',catalog:[monthly],operations:[]}:null,error:null}));
 const response=await clueraBillingAdminRequest(request('admin?plans=1'));expect(response.status).toBe(200);
 expect(await response.json()).toEqual({code:'ACTIVE',catalog:[monthly],operations:[]});expect(fetch).not.toHaveBeenCalled();expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
});
