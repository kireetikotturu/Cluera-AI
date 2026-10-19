// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountError } from '../lib/accounts/config';
import { AccountCookies } from '../lib/accounts/cookies';
import { handleClueraCancellation } from '../lib/payments/cluera/cancellation';
import { GET, POST } from '../app/api/account/payments/cluera/cancellation/route';
import SubscriptionCancellation from '../app/account/checkout/SubscriptionCancellation';
import { merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const hooks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn(),cancel:vi.fn(),status:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:hooks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:hooks.session,rateLimit:hooks.limit}));
vi.mock('../lib/payments/cluera/adapter',()=>({clueraRazorpayAdapter:()=>({cancelFuture:hooks.cancel,cancellationStatus:hooks.status})}));
const site='https://cluera-ai-staging.vercel.app',endpoint=site+'/api/account/payments/cluera/cancellation';
const user=paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS,session='00000000-0000-4000-8000-000000000002',foreign='00000000-0000-4000-8000-000000000003';
const operationId='00000000-0000-4000-8000-000000000004',subscriptionId='sub_accesscancel0001';
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:'true'};
const input={expectedAccountId:user,operationId,subscriptionId};
const record=(state='ACCEPTED',id=operationId)=>({code:'RECORDED',command:{operationId:id,subscriptionId,state}});
const binding={code:'VERIFIED',intentId:'00000000-0000-4000-8000-000000000005',userId:user,orderId:null,subscriptionId,
 revision:{revisionId:'00000000-0000-4000-8000-000000000006',offerCode:'cluera_monthly_40h_v2',name:'Synthetic monthly plan',amountPaise:549900,currency:'INR',
 allowanceSeconds:144000,kind:'RECURRING',interval:'MONTH',razorpayPlanId:'plan_accesscancel0001',enabled:false,version:1,totalCount:120,testPlanValidated:true}};
let rpc:ReturnType<typeof vi.fn>,host:HTMLDivElement,root:Root;
const request=(body:unknown=input,headers:HeadersInit={origin:site})=>new Request(endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
beforeEach(()=>{
 for(const [key,value]of Object.entries(env))vi.stubEnv(key,value);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_synthetic_public_key_00000000000000000');
 vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64',Buffer.alloc(32,3).toString('base64'));vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',Buffer.alloc(32,4).toString('base64'));
 hooks.session.mockResolvedValue({account:{userId:user,sessionId:session,email:'synthetic@example.invalid'},session:{}});hooks.limit.mockResolvedValue(undefined);
 hooks.cancel.mockResolvedValue({subscriptionId,providerState:'active',observedAt:new Date().toISOString()});hooks.status.mockResolvedValue({subscriptionId,providerState:'active',observedAt:new Date().toISOString()});
 rpc=vi.fn(async(name,args)=>({data:name==='cluera_billing_owner'?args.p_account_digest===merchantDigest(env)?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'}
  :name==='cluera_billing_cancel_prepare'?{code:'CLAIMED',claimId:'00000000-0000-4000-8000-000000000007',binding}
    :name==='cluera_billing_cancel_read'?{...record(),binding}:record(),error:null}));hooks.clients.mockReturnValue({service:{rpc}});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network fallback');}));vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
const render=async(enabled=true,accountId=user)=>{await act(async()=>root.render(createElement(SubscriptionCancellation,{accountId,subscriptionId,enabled})));};
const button=(text:string)=>[...host.querySelectorAll('button')].find(element=>element.textContent===text)!;

it('route uses the guarded handler and disabled capability admits no session, SDK, RPC or command',async()=>{
 expect(GET).toBe(handleClueraCancellation);expect(POST).toBe(handleClueraCancellation);
 vi.stubEnv('CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED','false');expect((await handleClueraCancellation(request())).status).toBe(404);
 expect(hooks.clients).not.toHaveBeenCalled();expect(hooks.session).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();expect(hooks.cancel).not.toHaveBeenCalled();
});
it('same-owner POST reaches only owner admission, command lease and finish, returning no capability or provider body',async()=>{
 const response=await handleClueraCancellation(request());expect(response.status).toBe(200);expect(await response.json()).toEqual(record());
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['cluera_billing_owner','cluera_billing_owner','cluera_billing_cancel_prepare','cluera_billing_cancel_finish']);
 expect(hooks.cancel).toHaveBeenCalledOnce();expect(response.headers.get('cache-control')).toBe('no-store');expect(fetch).not.toHaveBeenCalled();
});
it('GET can check only the original same-owner operation and cannot invoke a provider mutation',async()=>{
 const response=await handleClueraCancellation(new Request(`${endpoint}?expectedAccountId=${user}&operationId=${operationId}`));
 expect(response.status).toBe(200);expect(await response.json()).toEqual(record());expect(hooks.cancel).not.toHaveBeenCalled();expect(hooks.status).toHaveBeenCalledOnce();
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_cancel_prepare'||name==='cluera_billing_cancel_finish')).toBe(false);
});
it.each(['foreign-origin','cross-site','foreign-owner','recovery','non-tester','extra-input','amount','wrong-path','query-injection'])('denies %s before any command/provider action',async failure=>{
 let req=request();
 if(failure==='foreign-origin')req=request(input,{origin:'https://foreign.invalid'});
 if(failure==='cross-site')req=request(input,{origin:site,'sec-fetch-site':'cross-site'});
 if(failure==='foreign-owner')req=request({...input,expectedAccountId:foreign});
 if(failure==='recovery')vi.spyOn(AccountCookies.prototype,'get').mockReturnValue(session);
 if(failure==='non-tester')hooks.session.mockResolvedValue({account:{userId:foreign,sessionId:session,email:'foreign@example.invalid'},session:{}});
 if(failure==='extra-input')req=request({...input,action:'REFUND'});
 if(failure==='amount')req=request({...input,amountPaise:1});
 if(failure==='wrong-path')req=new Request(site+'/api/other',{method:'POST',headers:{origin:site},body:'{}'});
 if(failure==='query-injection')req=new Request(endpoint+'?extra=1',{method:'POST',headers:{origin:site},body:'{}'});
 expect([400,403]).toContain((await handleClueraCancellation(req)).status);expect(rpc).not.toHaveBeenCalled();expect(hooks.cancel).not.toHaveBeenCalled();
});
it('unauthenticated and throttled sessions retain401/429 without any RPC',async()=>{
 hooks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));expect((await handleClueraCancellation(request())).status).toBe(401);
 hooks.limit.mockRejectedValueOnce(new AccountError('RATE_LIMITED',429));expect((await handleClueraCancellation(request())).status).toBe(429);expect(rpc).not.toHaveBeenCalled();
});
it('UI is invisible by default and performs no automatic status/provider action',async()=>{
 await render(false);expect(host.querySelector('button')).toBeNull();await render();expect(button('Cancel renewal at term end')).toBeDefined();expect(fetch).not.toHaveBeenCalled();
});
it('customer explicitly confirms one command, then only original-operation GETs are possible',async()=>{
 const request=vi.fn(async()=>Response.json(record()));vi.stubGlobal('fetch',request);await render();
 await act(async()=>button('Cancel renewal at term end').click());expect(request).not.toHaveBeenCalled();
 await act(async()=>{button('Confirm cancellation').click();button('Confirm cancellation').click();});
 expect(request).toHaveBeenCalledOnce();expect(host.textContent).toContain('accepted the request');expect(host.textContent).toContain('paid time is unchanged');
 expect(host.textContent).not.toContain('Renewal is stopped');expect(host.textContent).not.toContain('Confirm cancellation');
 await act(async()=>button('Check original cancellation').click());expect(request.mock.calls[1][1]).toMatchObject({method:'GET'});
 expect(String(request.mock.calls[1][0])).toContain(`operationId=${operationId}`);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('UI preserves an unknown outcome and never resends POST even when verification fails',async()=>{
 const request=vi.fn(async()=>{throw Error('Synthetic private failure');});vi.stubGlobal('fetch',request);await render();
 await act(async()=>button('Cancel renewal at term end').click());await act(async()=>button('Confirm cancellation').click());
 expect(host.textContent).toContain('outcome is unknown');await act(async()=>button('Check original cancellation').click());
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(request.mock.calls[1][1]).toMatchObject({method:'GET'});
 expect(host.textContent).not.toContain('Synthetic private');
});
it('an account switch fences a deferred cancellation result from the previous owner',async()=>{
 let finish:(value:Response)=>void=()=>{};const response=new Promise<Response>(resolve=>{finish=resolve;});vi.stubGlobal('fetch',vi.fn(()=>response));
 await render();await act(async()=>button('Cancel renewal at term end').click());await act(async()=>button('Confirm cancellation').click());
 await render(true,foreign);await act(async()=>finish(Response.json(record('CONFIRMED'))));
 expect(host.textContent).not.toContain('independently confirms');expect(button('Cancel renewal at term end')).toBeDefined();
});
