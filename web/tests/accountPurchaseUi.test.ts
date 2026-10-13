// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import PurchasePortal from '../app/account/checkout/PurchasePortal';
let host:HTMLDivElement,root:Root;
const uid='00000000-0000-4000-8000-000000000001';
const offers=[{code:'pro_3_hours',name:'SigmaPro 3 Hours',label:'₹549 · 3 hours · no expiry'}];
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account/checkout');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete window.Paddle;vi.unstubAllGlobals();});
it('missing authentication shows login and disabled plans, never initiates a transaction',async()=>{
 const request=vi.fn(async(_input:RequestInfo|URL,_options?:RequestInit)=>new Response(null,{status:401}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:false})));
 expect(host.textContent).toContain('Sign in to the Account website');expect(host.querySelector('button')?.disabled).toBe(true);
 expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0][1]).not.toHaveProperty('method','POST');
});
it('a verified account still sees paused plans with no SDK/Paddle transaction',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({userId:uid,checkoutAvailable:false,payments:[]})));
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 expect(host.querySelector('button')?.disabled).toBe(true);expect(host.textContent).toContain('Checkout is not available for this account');expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('links the signed-in customer automatically with no UUID input, admin request or approval action',async()=>{
 const request=vi.fn(async()=>Response.json({userId:uid,displayName:'Verified Customer',checkoutAvailable:false,payments:[]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:false})));
 expect(host.textContent).toContain('Signed in as Verified Customer');expect(host.textContent).toContain('no account ID entry or administrator approval');
 expect(host.querySelector('input')).toBeNull();expect(host.textContent).not.toContain(uid);
 expect(request.mock.calls[0][0]).toBe('/api/account/credits');expect(request).toHaveBeenCalledOnce();
});
it('desktop owner hint is not authentication and a mismatched browser owner is denied',async()=>{
 history.replaceState(null,'',`/account/checkout?desktopAccount=${uid}`);
 const request=vi.fn(async(_input:RequestInfo|URL,_options?:RequestInit)=>new Response(null,{status:403}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true})));
 expect(request.mock.calls[0][0]).toContain(`desktopAccount=${uid}`);expect(host.textContent).toContain('same verified account');expect(host.querySelector('button')?.disabled).toBe(true);
});
it('unmount aborts a pending authenticated balance read',async()=>{
 const request=vi.fn((_input:RequestInfo|URL,_options?:RequestInit)=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:false})));
 const signal=request.mock.calls[0][1]!.signal as AbortSignal;await act(async()=>root.unmount());expect(signal.aborted).toBe(true);
 root=createRoot(host);
});
it.each(['CREATING','BOUND','UNCERTAIN'])('reload preserves the server %s lock even if stale availability says enabled',async state=>{
 const request=vi.fn(async()=>Response.json({userId:uid,checkoutAvailable:true,payments:[{offerCode:'pro_3_hours',state,createdAt:'2026-10-10T04:56:10Z'}]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 expect(host.textContent).toContain(state==='UNCERTAIN'?'An earlier checkout needs verification':state==='BOUND'?'An existing checkout is awaiting authoritative payment verification':'An existing checkout is being prepared');
 expect(host.textContent).toContain(state==='UNCERTAIN'?'Verification required':state==='BOUND'?'Existing checkout pending':'Preparing checkout');
 expect(Array.from(host.querySelectorAll('[role="group"] button')).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
 expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0]).toBe('/api/account/credits');expect(host.textContent).not.toContain(uid);
});
it('distinguishes a paused signed-in account from a missing sign-in without a purchase request',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({userId:uid,checkoutAvailable:false,payments:[]})));
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:false})));
 expect(host.textContent).toContain('Sandbox payments are paused');expect(host.textContent).not.toContain('Sign in to buy credits');
});
it('deduplicates focus/online/status refresh and displays only server-confirmed payment states',async()=>{
 let finish!:(value:Response)=>void;const pending=new Promise<Response>(resolve=>{finish=resolve;});
 const request=vi.fn(()=>pending);vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:false})));
 await act(async()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});expect(request).toHaveBeenCalledOnce();
 await act(async()=>finish(Response.json({userId:uid,checkoutAvailable:false,availableMilliseconds:10800000,payments:[
  {offerCode:'pro_3_hours',state:'UNCERTAIN',createdAt:'2026-10-04T09:45:11Z'},
  {offerCode:'pro_3_hours',state:'VERIFIED',createdAt:'2026-10-10T00:00:00Z'},
  {offerCode:'pro_3_hours',state:'REFUNDED',createdAt:'2026-10-10T00:00:01Z'}]})));
 expect(host.textContent).toContain('Available time: 3h 0m');expect(host.textContent).toContain('Needs operator verification');
 expect(host.textContent).toContain('Server-verified entitlement');expect(host.textContent).toContain('Refund reconciled');
 expect(request.mock.calls.every((call:any[])=>call[1]?.method!=='POST')).toBe(true);
});
const recoveredHistory=[
 {offerCode:'pro_3_hours',state:'REJECTED',createdAt:'2026-10-10T04:56:10.21978Z'},
 {offerCode:'pro_3_hours',state:'REJECTED',createdAt:'2026-10-04T09:45:11.323192Z'},
];
it('multiple independently rejected October 4/10 attempts remain history without locking an eligible account',async()=>{
 const request=vi.fn(async()=>Response.json({userId:uid,checkoutAvailable:true,payments:recoveredHistory}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 expect(host.textContent?.match(/Attempt rejected/g)).toHaveLength(2);
 expect(Array.from(host.querySelectorAll('time')).map(time=>time.dateTime)).toEqual(recoveredHistory.map(payment=>payment.createdAt));
 expect(host.textContent).not.toContain('Checkout needs verification');expect(host.textContent).not.toContain('Verification required');
 const purchase=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Continue in sandbox');expect(purchase?.disabled).toBe(false);
 expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0]).toBe('/api/account/credits');expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it.each(['CREATING','BOUND','UNCERTAIN'])('a real %s attempt still locks after multiple historical recoveries',async state=>{
 const request=vi.fn(async()=>Response.json({userId:uid,checkoutAvailable:true,payments:[
  ...recoveredHistory,{offerCode:'pro_3_hours',state,createdAt:'2026-10-11T01:24:00Z'},
 ]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 expect(host.textContent?.match(/Attempt rejected/g)).toHaveLength(2);expect(host.textContent).toContain(state==='UNCERTAIN'?'Checkout needs verification':'Existing checkout pending');
 expect(host.textContent).toContain(state==='UNCERTAIN'?'Verification required':state==='BOUND'?'Existing checkout pending':'Preparing checkout');
 expect(Array.from(host.querySelectorAll('[role="group"] button')).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
 expect(request).toHaveBeenCalledOnce();expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('read-only server refresh replaces an old unresolved snapshot with canonical REJECTED history',async()=>{
 const request=vi.fn().mockResolvedValueOnce(Response.json({userId:uid,checkoutAvailable:false,payments:[
  {...recoveredHistory[0],state:'UNCERTAIN'},recoveredHistory[1],
 ]})).mockResolvedValueOnce(Response.json({userId:uid,checkoutAvailable:true,payments:recoveredHistory}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 expect(host.textContent).toContain('Verification required');
 const refresh=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Refresh server payment status')!;
 await act(async()=>refresh.click());
 expect(host.textContent).not.toContain('Checkout needs verification');expect(host.textContent?.match(/Attempt rejected/g)).toHaveLength(2);
 const purchase=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Continue in sandbox');expect(purchase?.disabled).toBe(false);
 expect(request).toHaveBeenCalledTimes(2);expect(request.mock.calls[1][0]).toBe(`/api/account/credits?desktopAccount=${uid}`);
 expect(request.mock.calls.every(call=>call[1]?.method!=='POST')).toBe(true);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('switching through a new Account page cannot apply a late old-account status response',async()=>{
 let finish!:(value:Response)=>void;const oldRead=new Promise<Response>(resolve=>{finish=resolve;});
 const other='00000000-0000-4000-8000-000000000002';
 const request=vi.fn().mockReturnValueOnce(oldRead).mockResolvedValueOnce(Response.json({userId:other,displayName:'Account B',checkoutAvailable:false,payments:[]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const signal=request.mock.calls[0][1].signal as AbortSignal;
 await act(async()=>root.unmount());root=createRoot(host);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 expect(signal.aborted).toBe(true);expect(host.textContent).toContain('Account B');
 await act(async()=>finish(Response.json({userId:uid,displayName:'Account A',checkoutAvailable:true,payments:recoveredHistory})));
 expect(host.textContent).toContain('Account B');expect(host.textContent).not.toContain('Account A');expect(host.textContent).not.toContain('Attempt rejected');
 expect(Array.from(host.querySelectorAll('button')).some(button=>button.textContent==='Continue in sandbox')).toBe(false);
 expect(request).toHaveBeenCalledTimes(2);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('queues only one read-only SDK status refresh behind an in-flight status read',async()=>{
 let finish!:(value:Response)=>void;const pending=new Promise<Response>(resolve=>{finish=resolve;});
 let event!:(value:{name?:string})=>void;
 window.Paddle={Environment:{set:vi.fn()},Initialize:options=>{event=options.eventCallback;},Checkout:{open:vi.fn(),close:vi.fn()}};
 let reads=0;
 const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'a'.repeat(26)}}));
  reads++;
  if(reads===2)return pending;
  return Promise.resolve(Response.json({userId:uid,checkoutAvailable:true,payments:reads===1?recoveredHistory:[
   {offerCode:'pro_3_hours',state:'VERIFIED',createdAt:'2026-10-11T01:24:00Z'},...recoveredHistory,
  ]}));
 });vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const purchase=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Continue in sandbox')!;
 await act(async()=>purchase.click());
 expect(window.Paddle.Checkout.open).toHaveBeenCalledOnce();
 await act(async()=>window.dispatchEvent(new Event('focus')));
 await act(async()=>{event({name:'checkout.completed'});event({name:'checkout.closed'});});
 expect(reads).toBe(2);expect(Array.from(host.querySelectorAll('[role="group"] button')).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
 await act(async()=>finish(Response.json({userId:uid,checkoutAvailable:false,payments:[
  {offerCode:'pro_3_hours',state:'BOUND',createdAt:'2026-10-11T01:24:00Z'},...recoveredHistory,
 ]})));
 expect(reads).toBe(3);expect(host.textContent).toContain('Server-verified entitlement');
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it('a focus refresh reporting the active bound transaction does not close its checkout overlay or make a second purchase',async()=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'b'.repeat(26)}}));
  reads++;return Promise.resolve(Response.json({userId:uid,checkoutAvailable:reads===1,payments:reads===1?recoveredHistory:[
   {offerCode:'pro_3_hours',state:'BOUND',createdAt:'2026-10-11T01:23:13.062715Z'},...recoveredHistory,
  ]}));
 });vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const purchase=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Continue in sandbox')!;
 await act(async()=>purchase.click());expect(open).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
 await act(async()=>window.dispatchEvent(new Event('focus')));
 expect(host.textContent).toContain('Existing checkout pending');expect(close).not.toHaveBeenCalled();
 expect(Array.from(host.querySelectorAll('button')).filter(button=>button.textContent==='Continue in sandbox').every(button=>button.disabled)).toBe(true);
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it.each([401,403])('a definitive HTTP %s old-owner denial lets the next explicit read verify a switched browser account',async status=>{
 const other='00000000-0000-4000-8000-000000000002';
 const request=vi.fn().mockResolvedValueOnce(Response.json({userId:uid,displayName:'Account A',checkoutAvailable:true,payments:recoveredHistory}))
  .mockResolvedValueOnce(new Response(null,{status})).mockResolvedValueOnce(Response.json({userId:other,displayName:'Account B',checkoutAvailable:true,payments:[]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const refresh=()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Refresh server payment status')!;
 await act(async()=>refresh().click());expect(host.textContent).not.toContain('Signed in as Account A');
 await act(async()=>refresh().click());
 expect(request.mock.calls.map(call=>call[0])).toEqual(['/api/account/credits',`/api/account/credits?desktopAccount=${uid}`,'/api/account/credits']);
 expect(host.textContent).toContain('Signed in as Account B');expect(host.textContent).not.toContain('Signed in as Account A');expect(host.textContent).not.toContain('Attempt rejected');
 expect(request.mock.calls.every(call=>call[1]?.method!=='POST')).toBe(true);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('an explicit desktop owner hint remains pinned after browser denial and never accepts a different owner',async()=>{
 history.replaceState(null,'',`/account/checkout?desktopAccount=${uid}`);const other='00000000-0000-4000-8000-000000000002';
 const request=vi.fn().mockResolvedValueOnce(new Response(null,{status:403})).mockResolvedValueOnce(Response.json({userId:other,displayName:'Account B',checkoutAvailable:true,payments:[]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const refresh=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Refresh server payment status')!;await act(async()=>refresh.click());
 expect(request.mock.calls.every(call=>call[0]===`/api/account/credits?desktopAccount=${uid}`)).toBe(true);expect(host.textContent).not.toContain('Account B');
 expect(Array.from(host.querySelectorAll('button')).some(button=>button.textContent==='Continue in sandbox')).toBe(false);
});
it('an unavailable read does not silently replace the known owner with another browser account',async()=>{
 const request=vi.fn().mockResolvedValueOnce(Response.json({userId:uid,displayName:'Account A',checkoutAvailable:true,payments:recoveredHistory}))
  .mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(new Response(null,{status:503}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const refresh=()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Refresh server payment status')!;
 await act(async()=>refresh().click());await act(async()=>refresh().click());
 expect(request.mock.calls.map(call=>call[0])).toEqual(['/api/account/credits',`/api/account/credits?desktopAccount=${uid}`,`/api/account/credits?desktopAccount=${uid}`]);
 expect(host.textContent).toContain('Signed in as Account A');expect(host.textContent).toContain('Displayed history may be stale');
 expect(Array.from(host.querySelectorAll('[role="group"] button')).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
 expect(request.mock.calls.every(call=>call[1]?.method!=='POST')).toBe(true);
});
it('the original desktop owner stays pinned after SDK query stripping and a definitive browser-session denial',async()=>{
 history.replaceState(null,'',`/account/checkout?desktopAccount=${uid}&_ptxn=txn_untrusted#untrusted`);
 const other='00000000-0000-4000-8000-000000000002',open=vi.fn();
 window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'c'.repeat(26)}}));
  reads++;if(reads===2)return Promise.resolve(new Response(null,{status:403}));
  return Promise.resolve(Response.json({userId:reads===1?uid:other,displayName:reads===1?'Account A':'Account B',checkoutAvailable:true,payments:[]}));
 });vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
 const purchase=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Continue in sandbox')!;await act(async()=>purchase.click());
 expect(open).toHaveBeenCalledOnce();expect(location.search).toBe('');expect(location.hash).toBe('');
 const refresh=()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Refresh server payment status')!;
 await act(async()=>refresh().click());await act(async()=>refresh().click());
 expect(request.mock.calls.filter(call=>call[1]?.method!=='POST').map(call=>call[0])).toEqual(Array(3).fill(`/api/account/credits?desktopAccount=${uid}`));
 expect(host.textContent).not.toContain('Signed in as Account B');expect(open).toHaveBeenCalledOnce();
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
 expect(Array.from(host.querySelectorAll('button')).some(button=>button.textContent==='Continue in sandbox')).toBe(false);
});
const planButton=()=>host.querySelector('[role="group"] button') as HTMLButtonElement;
const statusButton=()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Refresh server payment status')!;
const boundPayment={offerCode:'pro_3_hours',state:'BOUND',createdAt:'2026-10-11T01:23:13.062715Z'};
const eligible=(payments:unknown[]=recoveredHistory)=>Response.json({userId:uid,checkoutAvailable:true,payments});
const verified=()=>eligible([{...boundPayment,state:'VERIFIED'},...recoveredHistory]);
const mountAvailable=()=>act(async()=>root.render(createElement(PurchasePortal,{offers,enabled:true,clientToken:'test_syntheticpublicclient000000'})));
it('retires an acknowledged checkout only after a newer authoritative eligible snapshot, with any next purchase still explicit',async()=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0,posts=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST'){posts++;return Promise.resolve(posts===1?Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'d'.repeat(26)}}):new Response(null,{status:503}));}
  reads++;return Promise.resolve(reads===1?eligible():reads===2?Response.json({userId:uid,checkoutAvailable:false,payments:[boundPayment,...recoveredHistory]}):verified());
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());
 expect(open).toHaveBeenCalledOnce();expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();
 await act(async()=>statusButton().click());expect(close).not.toHaveBeenCalled();expect(planButton().disabled).toBe(true);
 await act(async()=>statusButton().click());
 expect(host.textContent).toContain('Server-verified entitlement');expect(planButton().disabled).toBe(false);expect(close).toHaveBeenCalledOnce();
 expect(open).toHaveBeenCalledOnce();expect(posts).toBe(1);
 await act(async()=>planButton().click());expect(posts).toBe(2);expect(planButton().disabled).toBe(true);expect(open).toHaveBeenCalledOnce();
 const bodies=request.mock.calls.filter(call=>call[1]?.method==='POST').map(call=>JSON.parse(call[1]!.body as string));
 expect(bodies[0].requestId).not.toBe(bodies[1].requestId);
});
it('a verified GET-only resume can retire after fresh authoritative provisioning without another transaction or automatic SDK open',async()=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((input:RequestInfo|URL,_options?:RequestInit)=>{
  if(String(input).startsWith('/api/account/checkout-resume'))return Promise.resolve(Response.json({checkout:{code:'RESUMABLE',offerCode:'pro_3_hours',transactionId:'txn_'+'e'.repeat(26)}}));
  reads++;return Promise.resolve(reads===1?Response.json({userId:uid,checkoutAvailable:false,payments:[boundPayment,...recoveredHistory]}):verified());
 });vi.stubGlobal('fetch',request);await mountAvailable();
 const resume=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Resume existing Sandbox checkout')!;
 await act(async()=>resume.click());expect(open).toHaveBeenCalledOnce();expect(planButton().disabled).toBe(true);
 await act(async()=>statusButton().click());expect(planButton().disabled).toBe(false);expect(close).toHaveBeenCalledOnce();expect(open).toHaveBeenCalledOnce();
 expect(request.mock.calls).toHaveLength(3);expect(request.mock.calls.every(call=>call[1]?.method!=='POST')).toBe(true);
});
it('an eligible read started before binding acknowledgment cannot clear the active checkout lock',async()=>{
 let finishPost!:(response:Response)=>void,finishOld!:(response:Response)=>void;
 const post=new Promise<Response>(resolve=>{finishPost=resolve;}),older=new Promise<Response>(resolve=>{finishOld=resolve;});
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return post;
  reads++;return reads===2?older:Promise.resolve(reads===1?eligible():verified());
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());
 await act(async()=>window.dispatchEvent(new Event('focus')));expect(reads).toBe(2);
 await act(async()=>finishPost(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'f'.repeat(26)}})));
 expect(open).toHaveBeenCalledOnce();
 await act(async()=>finishOld(eligible()));expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();
 await act(async()=>statusButton().click());expect(planButton().disabled).toBe(false);expect(close).toHaveBeenCalledOnce();expect(open).toHaveBeenCalledOnce();
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it.each(['network','unavailable','owner-mismatch','malformed-payments'])('an unknown POST stays locked through a %s status failure and a later eligible snapshot',async failure=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.reject(new Error('unknown write outcome'));
  reads++;
  if(reads===2)return failure==='network'?Promise.reject(new Error('network unavailable')):Promise.resolve(failure==='unavailable'?new Response(null,{status:503}):
   failure==='malformed-payments'?Response.json({userId:uid,checkoutAvailable:true,payments:{}}):Response.json({userId:'00000000-0000-4000-8000-000000000002',checkoutAvailable:true,payments:[]}));
  return Promise.resolve(eligible());
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());expect(planButton().disabled).toBe(true);
 await act(async()=>statusButton().click());expect(close).not.toHaveBeenCalled();expect(planButton().disabled).toBe(true);expect(host.textContent).toContain('Displayed history may be stale');
 await act(async()=>statusButton().click());expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
 expect(host.textContent).toContain('Checkout needs verification');expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it.each(['CREATING','BOUND','UNCERTAIN'])('even a newer enabled snapshot containing %s cannot retire an acknowledged checkout',async state=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'g'.repeat(26)}}));
  reads++;return Promise.resolve(reads===1?eligible():eligible([{...boundPayment,state},...recoveredHistory]));
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());await act(async()=>statusButton().click());
 expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();expect(open).toHaveBeenCalledOnce();
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it('a known binding followed by SDK failure remains locked until fresh server eligibility, never SDK success alone',async()=>{
 const close=vi.fn(),open=vi.fn(()=>{throw new Error('SDK unavailable');});window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'h'.repeat(26)}}));
  reads++;return Promise.resolve(reads===1?eligible():reads===2?Response.json({userId:uid,checkoutAvailable:false,payments:recoveredHistory}):verified());
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());expect(planButton().disabled).toBe(true);
 await act(async()=>statusButton().click());expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();
 await act(async()=>statusButton().click());expect(planButton().disabled).toBe(false);expect(close).toHaveBeenCalledOnce();expect(open).toHaveBeenCalledOnce();
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it.each([
 undefined,{},[null],[{...boundPayment,state:'UNKNOWN'}],[{...boundPayment,offerCode:'unknown_offer'}],[{...boundPayment,createdAt:'not-a-timestamp'}],
])('malformed or incomplete payment history never retires a known binding or unmounts its operation: %j',async payments=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'i'.repeat(26)}}));
  reads++;return Promise.resolve(reads===1?eligible():Response.json({userId:uid,checkoutAvailable:true,payments}));
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());await act(async()=>statusButton().click());
 expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();expect(open).toHaveBeenCalledOnce();expect(host.textContent).toContain('Displayed history may be stale');
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it.each(['null-json','invalid-json','raw-network-error'])('a %s status response uses fixed safe copy and preserves the active operation',async failure=>{
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const privateDetail='synthetic-private-response-fragment';
 const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return Promise.resolve(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'j'.repeat(26)}}));
  reads++;if(reads===1)return Promise.resolve(eligible());
  if(failure==='raw-network-error')return Promise.reject(new Error(privateDetail));
  return Promise.resolve(failure==='null-json'?Response.json(null):new Response(`{"private":"${privateDetail}`,{headers:{'Content-Type':'application/json'}}));
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());await act(async()=>statusButton().click());
 expect(planButton().disabled).toBe(true);expect(close).not.toHaveBeenCalled();expect(open).toHaveBeenCalledOnce();expect(host.textContent).toContain('Account billing status is unavailable.');
 expect(host.textContent).not.toContain(privateDetail);expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
});
it.each([401,403])('a simultaneous HTTP %s owner denial fences a late acknowledged transaction before SDK opening',async status=>{
 let finishPost!:(response:Response)=>void,finishStatus!:(response:Response)=>void;
 const pendingPost=new Promise<Response>(resolve=>{finishPost=resolve;}),pendingStatus=new Promise<Response>(resolve=>{finishStatus=resolve;});
 const close=vi.fn(),open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close}};
 let reads=0;const request=vi.fn((_input:RequestInfo|URL,options?:RequestInit)=>{
  if(options?.method==='POST')return pendingPost;
  reads++;return reads===1?Promise.resolve(eligible()):pendingStatus;
 });vi.stubGlobal('fetch',request);await mountAvailable();await act(async()=>planButton().click());await act(async()=>statusButton().click());
 await act(async()=>{finishStatus(new Response(null,{status}));await Promise.resolve();finishPost(Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'k'.repeat(26)}}));});
 expect(open).not.toHaveBeenCalled();expect(Array.from(host.querySelectorAll('[role="group"] button'))).toHaveLength(0);
 expect(request.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
