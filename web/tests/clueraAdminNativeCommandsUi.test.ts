// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeCommandReview} from '../app/account/admin/NativeCommandReview';
import {adminBoundedRead} from '../lib/accounts/adminBoundedRead';
const viewer='a'.repeat(64),customer='00000000-0000-4000-8000-000000000001';let host:HTMLDivElement,root:Root;
const safe=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const fixture=()=>({code:'ACTIVE',viewer,subject:null,observedAt:new Date().toISOString(),nextCursor:null,rows:[
 {id:'00000000-0000-4000-8000-000000000101',userId:customer,subscriptionId:'sub_review00000001',kind:'CANCEL_FUTURE',state:'UNCERTAIN',createdAt:'2026-01-01T00:00:00Z',effectiveAt:null,leaseUntil:'2026-01-01T00:01:00Z',observedAt:null},
 {id:'00000000-0000-4000-8000-000000000102',userId:customer,subscriptionId:'sub_review00000001',kind:'RESCHEDULE',state:'REVIEW',createdAt:'2026-01-01T00:00:00Z',effectiveAt:'2026-11-01T00:00:00Z',leaseUntil:null,observedAt:null}]});
const render=async(disabled=false)=>{await act(async()=>root.render(createElement(NativeCommandReview,{disabled})));};
const submit=async()=>{await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it('mount makes no request and an explicit refresh shows unknown/review observations without mutation controls',async()=>{
 const fetcher=vi.fn(async(url:string)=>safe(url.includes('?')?fixture():{code:'ACTIVE',viewer}));vi.stubGlobal('fetch',fetcher);await render();expect(fetcher).not.toHaveBeenCalled();await submit();
 expect(fetcher).toHaveBeenCalledTimes(2);expect(host.textContent).toContain('Original outcome is unknown');expect(host.textContent).toContain('Unsupported rescheduling');
 expect(Array.from(host.querySelectorAll('button')).map(button=>button.textContent)).toEqual(['Read native command review']);
 for(const[url,init]of fetcher.mock.calls as unknown as Array<[string,RequestInit]>){expect(url.startsWith('/api/account/admin/billing/cluera/native-commands')).toBe(true);expect(init.method).toBeUndefined();expect(init.body).toBeUndefined();expect(init.credentials).toBe('same-origin');expect(init.redirect).toBe('error');}
});
it('denial, absent capability and malformed private payloads erase earlier records and use fixed messages',async()=>{
 let outcome=0;const fetcher=vi.fn(async(url:string)=>outcome===1?safe({error:'private-never-render'},403):outcome===2?safe({error:'private-never-render'},404)
  :safe(url.includes('?')?outcome===3?{...fixture(),claimId:'private-never-render'}:fixture():{code:'ACTIVE',viewer}));vi.stubGlobal('fetch',fetcher);await render();await submit();expect(host.textContent).toContain('sub_review00000001');
 for(outcome=1;outcome<=3;outcome++){await submit();expect(host.textContent).not.toContain('sub_review00000001');expect(host.textContent).not.toContain('private-never-render');}
});
it('pagination uses only the retained viewer/customer/cursor and never a resolution or replay body',async()=>{
 const fetcher=vi.fn(async(url:string)=>{if(!url.includes('?'))return safe({code:'ACTIVE',viewer});const value=fixture();if(!url.includes('cursor='))value.nextCursor='c3ludGhldGlj.c2lnbmVk' as any;return safe(value);});vi.stubGlobal('fetch',fetcher);await render();await submit();
 await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Read next 50 native commands')!.click());expect(fetcher).toHaveBeenCalledTimes(3);
 const next=new URL(fetcher.mock.calls[2][0],'http://localhost');expect([...next.searchParams.keys()]).toEqual(['viewer','cursor']);expect(next.searchParams.get('viewer')).toBe(viewer);
});
it('parent session/assurance locks abort a pending read and prevent late data from being retained',async()=>{
 let resolve!:(value:Response)=>void;const fetcher=vi.fn(async(url:string)=>url.includes('?')?new Promise<Response>(done=>{resolve=done;}):safe({code:'ACTIVE',viewer}));vi.stubGlobal('fetch',fetcher);await render();await submit();await render(true);
 await act(async()=>resolve(safe(fixture())));expect(host.textContent).not.toContain('sub_review00000001');expect(host.querySelector('button')!.matches(':disabled')).toBe(true);
});
it('an expired CLAIMED lease is explicitly unknown and requires review without a retry control',async()=>{
 const value=fixture();value.rows[0].state='CLAIMED';vi.stubGlobal('fetch',vi.fn(async(url:string)=>safe(url.includes('?')?value:{code:'ACTIVE',viewer})));await render();await submit();
 expect(host.textContent).toContain('outcome is unknown and requires operator review');expect(host.textContent).toContain('Do not repeat the request.');expect(host.querySelectorAll('button')).toHaveLength(1);
});
it('bounded reader rejects foreign paths, oversized data and a stream that ignores both abort and cancellation',async()=>{
 const fetcher=vi.fn(async()=>safe({}));vi.stubGlobal('fetch',fetcher);await expect(adminBoundedRead('https://foreign.invalid',new AbortController())).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 fetcher.mockImplementation(async()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}}));
 await expect(adminBoundedRead('/api/account/admin/billing/cluera/native-commands',new AbortController())).rejects.toThrow();
 vi.useFakeTimers();fetcher.mockImplementation(async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}),{headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}}));
 const result=adminBoundedRead('/api/account/admin/billing/cluera/native-commands',new AbortController()).then(()=>false,()=>true);await vi.advanceTimersByTimeAsync(8001);expect(await result).toBe(true);
});
