// @vitest-environment jsdom
import { act,createElement } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import RazorpayCheckout from '../app/account/checkout/RazorpayCheckout';
let root:Root,host:HTMLDivElement;
const userId='00000000-0000-4000-8000-000000000801',intentId='00000000-0000-4000-8000-000000000811',orderId='order_synthetic0001';
const offers=[{code:'pro_3_hours',name:'SigmaPro 3 Hours',label:'₹549 · 3 hours · no expiry'},
 {code:'pro_40_hours',name:'SigmaPro Monthly',label:'₹5,499 · 40 hours'}];
const account={userId,displayName:'Synthetic Tester',availableMilliseconds:900000,checkoutAvailable:true,payments:[]};
const status={payment:{code:'AVAILABLE',userId,pending:null,history:[],resolvedOrderIds:[]}};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account/checkout');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete window.Razorpay;document.querySelectorAll('script[src*="razorpay"]').forEach(s=>s.remove());vi.unstubAllGlobals();});
const buy=()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.startsWith('Pay ₹549'))!;
const refresh=()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Refresh server status')!;
it('unconfigured mode exposes no SDK/order/write/UUID input; retains account and clearly unavailable Stripe/recurring',async()=>{
 const request=vi.fn(async()=>Response.json(account));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:false,offers})));
 expect(buy().disabled).toBe(true);expect(host.textContent).toContain('awaits private owner setup');expect(host.textContent).toContain('Stripe — not available');
 expect(host.textContent).toContain('Recurring integration pending');expect(host.querySelector('input[type="text"]')).toBeNull();
 expect(request).toHaveBeenCalledOnce();expect(document.querySelector('script[src*="razorpay"]')).toBeNull();
});
it('legacy Paddle BOUND history does not masquerade as a new Razorpay lock; authoritative new status is required',async()=>{
 const request=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).includes('payments/checkout')?status:{...account,payments:[{offerCode:'pro_3_hours',state:'BOUND',createdAt:'2026-10-11T01:23:13Z'}]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:true,offers})));
 expect(buy().disabled).toBe(false);expect(host.textContent).toContain('Paddle records are preserved');expect(document.querySelector('script')).toBeNull();
 expect(request.mock.calls.every(c=>c[1]?.method!=='POST')).toBe(true);
});
it.each(['CREATING','BOUND','UNCERTAIN'])('new canonical %s always locks; no SDK or automatic resume',async state=>{
 const request=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).includes('payments/checkout')?
 {payment:{...status.payment,code:'PENDING',pending:{id:intentId,state,offerCode:'pro_3_hours',orderId:state==='BOUND'?orderId:null}}}:account));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:true,offers})));expect(buy().disabled).toBe(true);
 expect(request.mock.calls.every(c=>c[1]?.method!=='POST')).toBe(true);expect(document.querySelector('script')).toBeNull();
});
it('unknown CREATE retains its one operation across later eligible reads and never automatically retries',async()=>{
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?new Response('raw private body',{status:503}):Response.json(String(url).includes('payments/checkout')?status:account));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:true,offers})));await act(async()=>buy().click());
 expect(request.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);await act(async()=>refresh().click());expect(buy().disabled).toBe(true);
 expect(host.textContent).not.toContain('raw private body');expect(document.querySelector('script')).toBeNull();
});
it('explicit click opens only strict server-created Test order, callback/SDK events cannot grant or unlock',async()=>{
 let options:Record<string,any>={};const open=vi.fn(),close=vi.fn();window.Razorpay=class{constructor(o:Record<string,unknown>){options=o;}open=open;close=close;on=vi.fn();};
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>Response.json(init?.method==='POST'?
 {payment:{code:'BOUND',orderId,keyId:'rzp_test_synthetic123456',amount:54900,currency:'INR',offerCode:'pro_3_hours'}}:String(url).includes('payments/checkout')?status:account));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:true,offers})));expect(open).not.toHaveBeenCalled();
 await act(async()=>buy().click());expect(open).toHaveBeenCalledOnce();expect(options).toMatchObject({order_id:orderId,retry:{enabled:false}});
 await act(async()=>refresh().click());expect(buy().disabled).toBe(true);expect(close).not.toHaveBeenCalled();
 await act(async()=>options.handler({razorpay_order_id:'order_foreign0001',razorpay_payment_id:'pay_synthetic0001',razorpay_signature:'a'.repeat(64)}));
 expect(request.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);expect(buy().disabled).toBe(true);
});
it('403 during owned gateway status closes old SDK and aborts owner callbacks before account switching',async()=>{
 let deny=false;const close=vi.fn();window.Razorpay=class{open=vi.fn();close=close;on=vi.fn();};
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json({payment:{code:'BOUND',orderId,keyId:'rzp_test_synthetic123456',amount:54900,currency:'INR',offerCode:'pro_3_hours'}}):
 String(url).includes('payments/checkout')?(deny?new Response(null,{status:403}):Response.json(status)):Response.json(account));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:true,offers})));await act(async()=>buy().click());deny=true;
 await act(async()=>refresh().click());expect(close).toHaveBeenCalledOnce();expect(buy().disabled).toBe(true);expect(host.textContent).not.toContain('Signed in as');
});
it('unmount aborts read without accessing a private session or writing',async()=>{
 const request=vi.fn((_u:RequestInfo|URL,_init?:RequestInit)=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(RazorpayCheckout,{enabled:true,offers})));const signal=request.mock.calls[0][1]!.signal!;
 await act(async()=>root.unmount());expect(signal.aborted).toBe(true);root=createRoot(host);
});
