// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {AiProviders} from '../app/account/admin/AiProviders';
let host:HTMLDivElement,root:Root;
const factor='00000000-0000-4000-8000-000000000003';
const row={provider:'gemini',revision:1,credentialPresent:true,enabled:false,defaultModel:null,probeStatus:'UNVERIFIED',probeAt:null,models:[],complete:false,updatedAt:'2026-10-13T00:00:00Z'};
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(AiProviders)));}
it('has no automatic reads/writes and blocks controls when bootstrap is unavailable without raw error echo',async()=>{
 const request=vi.fn(async()=>Response.json({error:'private-value'},{status:503}));vi.stubGlobal('fetch',request);await render();expect(request).not.toHaveBeenCalled();
 await act(async()=>button('Refresh vault').click());expect(request).toHaveBeenCalledOnce();expect(host.textContent).toContain('Vault bootstrap is not complete');expect(host.textContent).not.toContain('private-value');
 expect([...host.querySelectorAll('fieldset')].every(f=>f.disabled)).toBe(true);
 expect(host.textContent).toContain('Cost unavailable');expect(host.textContent).toContain('no verified provider rate');
});
it('clears entry secrets, deduplicates submit, retains unknown operation and verifies by GET without resubmission',async()=>{
 let unknown=true;
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return Response.json({error:'private-provider-value'},{status:503});
  if(url.includes('factors'))return Response.json({factors:[{id:factor,status:'verified'}]});
  if(url.includes('operation')){unknown=false;return Response.json({code:'APPLIED',metadata:row});}
  return Response.json({code:'ACTIVE',providers:[row]});
 });vi.stubGlobal('fetch',request);await render();
 await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!,key=form.elements.namedItem('key') as HTMLInputElement,code=form.elements.namedItem('code') as HTMLInputElement,auth=form.elements.namedItem('factor') as HTMLSelectElement;
 key.value='synthetic-private-entry-value';code.value='123456';auth.value=factor;
 await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(key.value).toBe('');expect(code.value).toBe('');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(host.textContent).not.toContain('private-provider-value');expect(unknown).toBe(true);
 await act(async()=>button('Verify pending change').click());expect(unknown).toBe(false);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(host.textContent).toContain('Original operation confirmed');
});
it('rejects extra secret-bearing DTO fields and unsafe model IDs rather than rendering them',async()=>{
 const request=vi.fn(async()=>Response.json({code:'ACTIVE',providers:[{...row,apiKey:'private-returned-secret'}]}));vi.stubGlobal('fetch',request);await render();await act(async()=>button('Refresh vault').click());
 expect(host.textContent).not.toContain('private-returned-secret');expect([...host.querySelectorAll('fieldset')].every(f=>f.disabled)).toBe(true);
});
it('aborts an explicit read on unmount and does not poll or fetch old Admin sessions',async()=>{
 let captured:AbortSignal|undefined;
 const request=vi.fn((_url:string,init?:RequestInit)=>{captured=init?.signal as AbortSignal;return new Promise<Response>(()=>{});});vi.stubGlobal('fetch',request);await render();await act(async()=>button('Refresh vault').click());await act(async()=>root.unmount());expect(captured?.aborted).toBe(true);expect(request).toHaveBeenCalledOnce();
});
