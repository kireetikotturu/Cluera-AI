// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountError} from '../lib/accounts/config';
import {AccountCookies} from '../lib/accounts/cookies';
import {clueraBillingHistoryEnabled,handleClueraBillingHistory} from '../lib/payments/cluera/history';
import ClueraBillingHistory from '../app/account/checkout/ClueraBillingHistory';
import {GET as historyGet} from '../app/api/account/payments/cluera/history/route';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
import {merchantDigest}from'../lib/payments/cluera/config';

const hooks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:hooks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:hooks.session,rateLimit:hooks.limit}));
const site='https://cluera-ai-staging.vercel.app',user='00000000-0000-4000-8000-000000000801',foreign='00000000-0000-4000-8000-000000000802',session='00000000-0000-4000-8000-000000000803';
const endpoint=site+'/api/account/payments/cluera/history';
const empty=(userId=user)=>({code:'ACTIVE',userId,payments:[],subscriptions:[],hasMorePayments:false,hasMoreSubscriptions:false});
const populated=()=>({...empty(),payments:[{paymentId:'pay_synthetichistory01',invoiceId:null,subscriptionId:null,state:'VERIFIED',
 revision:{revisionId:'00000000-0000-4000-8000-000000000804',offerCode:'cluera_pack_3h_v2',version:1,name:'Synthetic verified pack',kind:'PACK',amountPaise:54900,currency:'INR',allowanceSeconds:10800},
 intentCreatedAt:'2026-10-17T12:00:00.000Z',paidAt:null,periodStart:null,periodEnd:null}]});
const savedHistory=()=>{const now=Date.now(),revision={...populated().payments[0].revision,offerCode:'cluera_monthly_40h_v2',kind:'RECURRING',amountPaise:549900,allowanceSeconds:144000,name:'Saved Pro 40 Hours'};
 const saved={invoiceId:'inv_savedhistory0001',subscriptionId:'sub_savedhistory0001',revision,state:'PRESERVED',startsAt:null,endsAt:null,savedWallMilliseconds:20*86400000,allowanceMilliseconds:144000000,spentMilliseconds:3600000,reservedMilliseconds:0,remainingAllowanceMilliseconds:140400000,spendableMilliseconds:0};
 const queued={...saved,invoiceId:'inv_queuedhistory0001',subscriptionId:'sub_queuedhistory0001',state:'QUEUED',savedWallMilliseconds:30*86400000,spentMilliseconds:0,remainingAllowanceMilliseconds:144000000};
 const active={...saved,invoiceId:'inv_activehistory0001',subscriptionId:'sub_activehistory0001',revision:{...revision,offerCode:'cluera_monthly_200h_v2',name:'Current Enterprise 200 Hours',amountPaise:1954900,allowanceSeconds:720000},state:'ACTIVE',startsAt:new Date(now-86400000).toISOString(),endsAt:new Date(now+29*86400000).toISOString(),savedWallMilliseconds:null,allowanceMilliseconds:720000000,spentMilliseconds:0,remainingAllowanceMilliseconds:720000000,spendableMilliseconds:720000000};
 return{...empty(),nativeSchedule:{observedAt:new Date(now).toISOString(),terms:[saved,queued,active],hasMoreTerms:false}};};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
let rpc:ReturnType<typeof vi.fn>,host:HTMLDivElement,root:Root;
beforeEach(()=>{
 for(const [key,value]of Object.entries(paymentTestEnvironment))vi.stubEnv(key,value);
 vi.stubEnv('CLUERA_BILLING_V2_ENABLED','true');vi.stubEnv('CLUERA_BILLING_HISTORY_ENABLED','true');
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_synthetic_public_key_00000000000000000');
 vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64',Buffer.alloc(32,3).toString('base64'));
 vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',Buffer.alloc(32,4).toString('base64'));
 vi.stubEnv('VERCEL_ENV','production');vi.stubEnv('VERCEL_TARGET_ENV','production');
 vi.stubEnv('VERCEL_PROJECT_ID','prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B');vi.stubEnv('VERCEL_ORG_ID','team_AksnPXhi2VBXI5UsY2xBIakc');
 rpc=vi.fn(async()=>({data:empty(),error:null}));hooks.clients.mockReturnValue({service:{rpc}});
 hooks.session.mockResolvedValue({account:{userId:user,sessionId:session,email:'synthetic@example.invalid'},session:{}});hooks.limit.mockResolvedValue(undefined);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
const request=(query='expectedAccountId='+user,headers:HeadersInit={},method='GET')=>new Request(endpoint+(query?'?'+query:''),{method,headers});
const button=()=>host.querySelector<HTMLButtonElement>('button')!;
const render=async(accountId:string|null=user,enabled=true,disabled=false)=>{await act(async()=>root.render(createElement(ClueraBillingHistory,{accountId,enabled,disabled})));};

it.each([undefined,'false','TRUE','1'])('history gate %s returns404 before any client, session, limiter or RPC',async flag=>{
 if(flag===undefined)delete process.env.CLUERA_BILLING_HISTORY_ENABLED;else vi.stubEnv('CLUERA_BILLING_HISTORY_ENABLED',flag);
 expect(clueraBillingHistoryEnabled()).toBe(false);expect((await handleClueraBillingHistory(request())).status).toBe(404);
 expect(hooks.clients).not.toHaveBeenCalled();expect(hooks.session).not.toHaveBeenCalled();expect(hooks.limit).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
});
it.each([{CLUERA_BILLING_V2_ENABLED:'false'},{NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},{RAZORPAY_ENVIRONMENT:'live'},
 {VERCEL_ENV:'preview'},{VERCEL_PROJECT_ID:'wrong'},{VERCEL_ORG_ID:'wrong'}])('wrong target cannot reach an SDK %j',async patch=>{
 for(const [key,value]of Object.entries(patch))vi.stubEnv(key,value);expect((await handleClueraBillingHistory(request())).status).toBe(404);expect(hooks.clients).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
it('same-owner GET calls exactly one SELECT-only history RPC even when checkout/intake are paused',async()=>{
 vi.stubEnv('SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','true');vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','false');vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','false');
 const response=await (historyGet as (r:Request,c?:unknown)=>Promise<Response>)(request(),{params:Promise.resolve({})});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({history:empty()});expect(response.headers.get('cache-control')).toBe('no-store');
 expect(rpc).toHaveBeenCalledExactlyOnceWith('cluera_billing_history',{p_user:user,p_session:session});expect(hooks.limit).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
});
it('native presentation uses only the separately enabled pinned SELECT RPC while every financial/native execution gate is disabled',async()=>{
 vi.stubEnv('CLUERA_NATIVE_RECURRING_HISTORY_ENABLED','true');vi.stubEnv('CLUERA_RECURRING_SCHEDULE_ENABLED','false');vi.stubEnv('SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','true');vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','false');
 const digest=merchantDigest(),history=savedHistory();rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>({data:name==='cluera_billing_owner'?(args.p_account_digest===digest?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'}):name==='cluera_billing_native_history'?history:null,error:null}));
 const response=await handleClueraBillingHistory(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({history});expect(rpc.mock.calls.map(([name])=>name)).toEqual(['cluera_billing_owner','cluera_billing_owner','cluera_billing_native_history']);expect(rpc.mock.calls[2][1]).toEqual({p_user:user,p_session:session,p_account_digest:digest,p_epoch:1});expect(fetch).not.toHaveBeenCalled();
});
it.each(['','expectedAccountId=bad','expectedAccountId='+user+'&expectedAccountId='+user,'expectedAccountId='+user+'&extra=1'])('malformed query never reaches a client %s',async query=>{
 expect((await handleClueraBillingHistory(request(query))).status).toBe(400);expect(hooks.clients).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
it('cross-origin, cross-site, foreign-owner and recovery requests never reach history',async()=>{
 for(const headers of [{origin:'https://untrusted.invalid'},{'sec-fetch-site':'cross-site'}])expect((await handleClueraBillingHistory(request(undefined,headers))).status).toBe(403);
 expect(hooks.clients).not.toHaveBeenCalled();expect((await handleClueraBillingHistory(request('expectedAccountId='+foreign))).status).toBe(403);
 vi.spyOn(AccountCookies.prototype,'get').mockReturnValue(session);expect((await handleClueraBillingHistory(request())).status).toBe(403);
 expect(rpc).not.toHaveBeenCalled();expect(hooks.limit).not.toHaveBeenCalled();
});
it('missing sessions, rate limits and malformed backend DTOs expose only fixed messages',async()=>{
 hooks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));expect((await handleClueraBillingHistory(request())).status).toBe(401);expect(rpc).not.toHaveBeenCalled();
 hooks.limit.mockRejectedValueOnce(new AccountError('RATE_LIMITED',429));expect((await handleClueraBillingHistory(request())).status).toBe(429);expect(rpc).not.toHaveBeenCalled();
 for(const value of [{...empty(),userId:foreign},{...empty(),secret:'SYNTHETIC_PRIVATE_BODY'}]){
  rpc.mockResolvedValueOnce({data:value,error:null});const response=await handleClueraBillingHistory(request());expect(response.status).toBe(503);expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_BODY');
 }
});
it('disabled or signed-out history renders honest unavailable state without automatic fetch',async()=>{
 const request=vi.fn();vi.stubGlobal('fetch',request);await render(user,false);expect(button().disabled).toBe(true);expect(host.textContent).toContain('read-only setup awaits approval');
 await render(null,true);expect(button().disabled).toBe(true);expect(host.textContent).not.toContain('No verified payments');expect(request).not.toHaveBeenCalled();
});
it('history is explicit-refresh, single-flight and GET-only; an empty state requires a confirmed DTO',async()=>{
 let finish!:(response:Response)=>void;const request=vi.fn((_url:RequestInfo|URL,_init?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',request);
 await render();expect(request).not.toHaveBeenCalled();expect(host.textContent).not.toContain('No verified payments');
 await act(async()=>{button().click();button().click();});expect(request).toHaveBeenCalledOnce();expect(button().disabled).toBe(true);expect(host.textContent).toContain('Loading server-confirmed');
 expect(request.mock.calls[0][0]).toBe('/api/account/payments/cluera/history?expectedAccountId='+user);expect(request.mock.calls[0][1]).toMatchObject({method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error'});
 await act(async()=>finish(json({history:empty()})));expect(host.textContent).toContain('No verified payments are recorded');expect(button().disabled).toBe(false);
});
it('customer sees saved Pro calendar window and unused allowance separately from current spendable Enterprise, without a renewal promise or mutation',async()=>{
 const fetcher=vi.fn(async()=>json({history:savedHistory()}));vi.stubGlobal('fetch',fetcher);await render();expect(fetcher).not.toHaveBeenCalled();await act(async()=>button().click());
 const section=host.querySelector('section[aria-label="Saved and scheduled monthly access"]')!;expect(section).not.toBeNull();expect(section.textContent).toContain('Saved Pro access');expect(section.textContent).toContain('Saved access window: 20 days. Unused allowance: 39h 0m');expect(section.textContent).toContain('Spendable now from this period: 0s');expect(section.textContent).toContain('Queued paid period');expect(section.textContent).toContain('Spendable now from this period: 200h 0m');expect(section.textContent).toContain('Restoring access does not restart billing');expect(section.textContent).not.toContain('Ended period');expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({method:'GET'});
});
it('native saved-time history is cleared on account change and never rendered from a late former-owner response',async()=>{
 let finish!:(response:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button().click());await render(foreign);await act(async()=>finish(json({history:savedHistory()})));expect(host.textContent).not.toContain('Saved Pro access');expect(host.textContent).not.toContain('Saved access window');expect(fetcher).toHaveBeenCalledOnce();
});
it('malformed, foreign-owner or unavailable history never becomes fake empty or raw error output',async()=>{
 for(const response of [json({history:empty(foreign)}),json({history:{...empty(),secret:'SYNTHETIC_PRIVATE'}}),json({error:'SYNTHETIC_PRIVATE'},503)]){
  vi.stubGlobal('fetch',vi.fn(async()=>response));await render();await act(async()=>button().click());expect(host.textContent).toContain('Billing history is unavailable');expect(host.textContent).not.toContain('No verified payments');expect(host.textContent).not.toContain('SYNTHETIC_PRIVATE');
 }
});
it('account changes abort and fence late foreign history without reading automatically for the new owner',async()=>{
 let finish!:(response:Response)=>void,signal:AbortSignal|null|undefined;
 const request=vi.fn((_url:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal;return new Promise<Response>(resolve=>{finish=resolve;});});vi.stubGlobal('fetch',request);
 await render();await act(async()=>button().click());await render(foreign);expect(signal?.aborted).toBe(true);
 await act(async()=>finish(json({history:populated()})));expect(host.textContent).not.toContain('Synthetic verified pack');expect(request).toHaveBeenCalledOnce();
});
it('parent verification hides and clears loaded history until another explicit refresh',async()=>{
 const request=vi.fn(async()=>json({history:populated()}));vi.stubGlobal('fetch',request);await render();await act(async()=>button().click());expect(host.textContent).toContain('Synthetic verified pack');
 await render(user,true,true);expect(host.textContent).not.toContain('Synthetic verified pack');expect(button().disabled).toBe(true);
 await render(user,true,false);expect(host.textContent).not.toContain('Synthetic verified pack');expect(request).toHaveBeenCalledOnce();
});
it('a current-owner timeout aborts the request and shows a persistent understandable error',async()=>{
 vi.useFakeTimers();let signal:AbortSignal|null|undefined;const request=vi.fn((_url:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal;return new Promise<Response>(()=>{});});vi.stubGlobal('fetch',request);
 await render();await act(async()=>button().click());await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
 expect(signal?.aborted).toBe(true);expect(host.textContent).toContain('Billing history is unavailable');expect(button().disabled).toBe(false);expect(request).toHaveBeenCalledOnce();
});
it('checkout history loads automatically only after owner verification, then refreshes once per snapshot without a write',async()=>{
 const request=vi.fn(async()=>json({history:populated()}));vi.stubGlobal('fetch',request);
 const automatic=async(disabled:boolean,refreshKey:number)=>{await act(async()=>root.render(createElement(ClueraBillingHistory,{accountId:user,enabled:true,disabled,autoLoad:true,refreshKey})));};
 await automatic(true,0);expect(request).not.toHaveBeenCalled();
 await automatic(false,1);expect(request).toHaveBeenCalledOnce();expect(host.textContent).toContain('Synthetic verified pack');
 await automatic(false,1);expect(request).toHaveBeenCalledOnce();
 await automatic(true,1);expect(host.textContent).not.toContain('Synthetic verified pack');
 await automatic(false,2);expect(request).toHaveBeenCalledTimes(2);
 expect(request.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
it('automatic history cannot display a late response belonging to the previous account',async()=>{
 let finish!:(response:Response)=>void;
 const request=vi.fn((_url:RequestInfo|URL)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(ClueraBillingHistory,{accountId:user,enabled:true,autoLoad:true})));
 const old=finish;
 await act(async()=>root.render(createElement(ClueraBillingHistory,{accountId:foreign,enabled:true,autoLoad:true})));
 await act(async()=>old(json({history:populated()})));
 expect(host.textContent).not.toContain('Synthetic verified pack');expect(request).toHaveBeenCalledTimes(2);
 await act(async()=>finish(json({history:empty(foreign)})));expect(host.textContent).toContain('No verified payments');
});
