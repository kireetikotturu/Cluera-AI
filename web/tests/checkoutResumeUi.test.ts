// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import CheckoutClient from '../app/account/checkout/CheckoutClient';

const uid='00000000-0000-4000-8000-000000000001';
const transactionId='txn_'+'a'.repeat(26);
const offers=[{code:'pro_3_hours',name:'SigmaPro 3 Hours',label:'₹549 · 3 hours'}];
const props={clientToken:'test_synthetic',offers,expectedAccountId:uid,serverBlocked:true,pendingOfferCode:'pro_3_hours',pendingLabel:'Existing checkout pending',allowResume:true};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account/checkout');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete window.Paddle;vi.unstubAllGlobals();});
const resume=()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Resume existing Sandbox checkout')!;

it('resumes only the authoritative existing transaction after one explicit GET; never creates an intent or transaction',async()=>{
 const open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
 const request=vi.fn(async()=>Response.json({checkout:{code:'RESUMABLE',offerCode:'pro_3_hours',transactionId}}));vi.stubGlobal('fetch',request);
 history.replaceState(null,'','/account/checkout?_ptxn=txn_untrusted#untrusted');
 await act(async()=>root.render(createElement(CheckoutClient,props)));
 expect(request).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();expect(document.querySelector('script[src*="paddle"]')).toBeNull();
 await act(async()=>{resume().click();resume().click();});
 expect(request).toHaveBeenCalledOnce();const [url,options]=request.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe(`/api/account/checkout-resume?expectedAccountId=${uid}`);expect(options.method).toBe('GET');expect(options.credentials).toBe('same-origin');
 expect(options.cache).toBe('no-store');expect(options.redirect).toBe('error');expect(options.referrerPolicy).toBe('same-origin');expect(options.body).toBeUndefined();expect(options.headers).toBeUndefined();
 expect(open).toHaveBeenCalledOnce();expect(open).toHaveBeenCalledWith({transactionId,settings:{displayMode:'overlay',showAddDiscounts:false}});
 expect(location.search).toBe('');expect(location.hash).toBe('');expect(host.textContent).toContain('does not create another transaction or grant credits');
 expect(Array.from(host.querySelectorAll('button')).every(button=>button.disabled)).toBe(true);
});
it.each([401,403,409,503])('denied or unresolved resume HTTP %s never loads SDK, opens checkout or retries',async status=>{
 const request=vi.fn(async()=>Response.json({checkout:{code:'PENDING'},detail:'synthetic-private-detail'},{status}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(CheckoutClient,props)));await act(async()=>resume().click());
 expect(request).toHaveBeenCalledOnce();expect(host.textContent).toContain('existing checkout could not be verified');expect(host.textContent).not.toContain('synthetic-private-detail');
 expect(resume().disabled).toBe(true);await act(async()=>resume().click());expect(request).toHaveBeenCalledOnce();expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it.each([
 {code:'PENDING',offerCode:'pro_3_hours',transactionId},
 {code:'NOT_FOUND',offerCode:'pro_3_hours',transactionId},
 {code:'RESUMABLE',offerCode:'enterprise_monthly',transactionId},
 {code:'RESUMABLE',offerCode:'pro_3_hours',transactionId:'txn_bad'},
 {code:'RESUMABLE',offerCode:'pro_3_hours',transactionId:[transactionId]},
 {code:'VERIFIED',offerCode:'pro_3_hours',transactionId},
])('rejects non-resumable or mismatched server metadata without trusting browser payment success: %j',async checkout=>{
 const open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
 const request=vi.fn(async()=>Response.json({checkout}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(CheckoutClient,props)));await act(async()=>resume().click());
 expect(request).toHaveBeenCalledOnce();expect(open).not.toHaveBeenCalled();expect(resume().disabled).toBe(true);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('owner unmount aborts resume and rejects a late successful old-owner response',async()=>{
 let finish!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>{finish=resolve;});
 const request=vi.fn((_input:RequestInfo|URL,_options?:RequestInit)=>pending);vi.stubGlobal('fetch',request);
 const open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
 await act(async()=>root.render(createElement(CheckoutClient,props)));await act(async()=>resume().click());
 const signal=request.mock.calls[0][1]!.signal as AbortSignal;
 await act(async()=>root.unmount());root=createRoot(host);expect(signal.aborted).toBe(true);
 await act(async()=>finish(Response.json({checkout:{code:'RESUMABLE',offerCode:'pro_3_hours',transactionId}})));
 expect(open).not.toHaveBeenCalled();expect(request).toHaveBeenCalledOnce();expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('no canonical BOUND advisory means no resume action and no automatic SDK or request',async()=>{
 const request=vi.fn();vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(CheckoutClient,{...props,allowResume:false})));
 expect(Array.from(host.querySelectorAll('button')).some(button=>button.textContent==='Resume existing Sandbox checkout')).toBe(false);
 expect(request).not.toHaveBeenCalled();expect(document.querySelector('script[src*="paddle"]')).toBeNull();
});
it('an offer no longer enabled in the rendered catalog cannot be opened through resume',async()=>{
 const open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
 const request=vi.fn(async()=>Response.json({checkout:{code:'RESUMABLE',offerCode:'pro_3_hours',transactionId}}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(CheckoutClient,{...props,offers:[]})));await act(async()=>resume().click());
 expect(request).toHaveBeenCalledOnce();expect(open).not.toHaveBeenCalled();expect(resume().disabled).toBe(true);
});
