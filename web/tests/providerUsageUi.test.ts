// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ProviderUsage} from '../app/account/admin/ProviderUsage';
let host:HTMLDivElement,root:Root;
const report={code:'ACTIVE',scope:'LATEST_REQUESTS',limit:50,costStatus:'UNAVAILABLE',rows:[]};
const response=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const button=()=>host.querySelector('button')!;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function render(disabled=false){await act(async()=>root.render(createElement(ProviderUsage,{disabled})));}
it('performs no idle request and reads only after a deliberate Admin action without implying zero costs',async()=>{
 const request=vi.fn(async(_url:string,_init?:RequestInit)=>response(report));vi.stubGlobal('fetch',request);await render();expect(request).not.toHaveBeenCalled();
 await act(async()=>button().click());expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0]).toBe('/api/account/admin/ai-usage');
 expect(host.textContent).toContain('maximum 50');expect(host.textContent).toContain('does not prove zero provider usage or cost');
});
it('aborts and clears retained metadata when the Admin gate is disabled',async()=>{
 let signal:AbortSignal|undefined;
 const request=vi.fn((_url:string,init?:RequestInit)=>{signal=init?.signal as AbortSignal;return new Promise<Response>(()=>{});});vi.stubGlobal('fetch',request);
 await render();await act(async()=>button().click());await render(true);expect(signal?.aborted).toBe(true);expect(button().disabled).toBe(true);expect(host.querySelector('table')).toBeNull();
});
it('does not render secret-bearing unknown DTO fields or provider error bodies',async()=>{
 const request=vi.fn(async()=>response({...report,apiKey:'private-returned-value'}));vi.stubGlobal('fetch',request);await render();await act(async()=>button().click());
 expect(host.textContent).not.toContain('private-returned-value');expect(host.querySelector('table')).toBeNull();
 request.mockResolvedValueOnce(Response.json({error:'private-error'},{status:503}));await act(async()=>button().click());expect(host.textContent).not.toContain('private-error');expect(host.textContent).toContain('disabled or unavailable');
});
