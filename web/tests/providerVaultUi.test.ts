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
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
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
it('shows save progress and a useful next step while clearing the submitted secret and code',async()=>{
 let finish!:(response:Response)=>void;
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return new Promise<Response>(resolve=>{finish=resolve;});
  return Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[]});
 });vi.stubGlobal('fetch',request);await render();
 await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!,key=form.elements.namedItem('key') as HTMLInputElement,code=form.elements.namedItem('code') as HTMLInputElement;
 expect(key.required).toBe(true);key.value='synthetic-private-entry-value';code.value='123456';(form.elements.namedItem('factor') as HTMLSelectElement).value=factor;
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Saving encrypted key');expect(key.value).toBe('');expect(code.value).toBe('');expect(form.querySelector('fieldset')?.disabled).toBe(true);
 await act(async()=>finish(Response.json({code:'APPLIED',metadata:row})));
 expect(host.textContent).toContain('Encrypted key saved. Next choose Test metadata access');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it.each(['fetch','body'])('settles a hung %s and fences late mutation success without retrying',async phase=>{
 vi.useFakeTimers();let finish!:(value:any)=>void;
 const stalled=new Promise<any>(resolve=>{finish=resolve;});
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return phase==='fetch'?stalled:{ok:true,json:()=>stalled};
  return Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[]});
 });vi.stubGlobal('fetch',request);await render();await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!;(form.elements.namedItem('key') as HTMLInputElement).value='synthetic-private-entry-value';(form.elements.namedItem('code') as HTMLInputElement).value='123456';(form.elements.namedItem('factor') as HTMLSelectElement).value=factor;
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>vi.advanceTimersByTimeAsync(15000));expect(host.textContent).toContain('The result is unknown');expect(button('Verify pending change').disabled).toBe(false);
 await act(async()=>finish(phase==='fetch'?Response.json({code:'APPLIED',metadata:row}):{code:'APPLIED',metadata:row}));
 expect(host.textContent).toContain('The result is unknown');expect(button('Verify pending change')).toBeTruthy();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('distinguishes enabled providers from desktop model approval without enabling models automatically',async()=>{
 const enabled={...row,enabled:true,defaultModel:'gemini-3.5-flash',complete:true,probeStatus:'VERIFIED',models:[{id:'gemini-3.5-flash',runtimeCompatible:true}]};
 const policy={provider:'gemini' as const,modelId:'gemini-3.5-flash',displayName:'Gemini',enabled:false,isDefault:false,priority:100,capabilities:['text','image'] as ('text'|'image')[],health:'UNVERIFIED' as const};
 const request=vi.fn(async()=>Response.json({code:'ACTIVE',providers:[enabled]}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AiProviders,{models:[policy]})));await act(async()=>button('Refresh vault').click());
 expect(host.textContent).toContain('model approval required in AI model registry');expect(host.querySelector('a[href="#account-admin-models"]')).toBeTruthy();
 await act(async()=>root.render(createElement(AiProviders,{models:[{...policy,enabled:true,isDefault:true}]})));
 expect(host.textContent).toContain('provider and model settings are enabled in the displayed snapshots');expect(host.textContent).toContain('Real text/audio still needs device verification');expect(request).toHaveBeenCalledOnce();
});
it('reports rejected MFA as not saved and permits a fresh manual attempt',async()=>{
 const request=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({error:'private-value'},{status:403}):Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[]}));
 vi.stubGlobal('fetch',request);await render();await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!;await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Authentication was rejected before saving');expect(host.textContent).not.toContain('private-value');expect(form.querySelector('fieldset')?.disabled).toBe(false);
});
const verifiedRow=()=>({...row,probeStatus:'VERIFIED',probeAt:new Date().toISOString(),complete:true,models:[{id:'gemini-3.5-flash',runtimeCompatible:true}]});
async function configureForm(){
 await render();await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!,action=form.elements.namedItem('action') as HTMLSelectElement;
 await act(async()=>{action.value='CONFIGURE';action.dispatchEvent(new Event('change',{bubbles:true}));});
 (form.elements.namedItem('enabled') as HTMLInputElement).checked=true;
 (form.elements.namedItem('factor') as HTMLSelectElement).value=factor;
 (form.elements.namedItem('code') as HTMLInputElement).value='123456';
 return form;
}
it('requires a compatible selected default before sending an enablement request',async()=>{
 const request=vi.fn(async(url:string)=>Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[verifiedRow()]}));
 vi.stubGlobal('fetch',request);const form=await configureForm();
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Choose a compatible default model before enabling this provider');
 expect(request.mock.calls.every(([url])=>!url.includes('operation'))).toBe(true);expect(request).toHaveBeenCalledTimes(2);
 expect(button('Verify pending change')).toBeUndefined();
});
it.each(['CONFLICT','CHANGE_REJECTED'])('releases a confirmed %s rejection only for an explicit refreshed manual change',async error=>{
 let rejected=true;
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return rejected?Response.json({error},{status:409}):Response.json({code:'APPLIED',metadata:{...verifiedRow(),revision:2,enabled:true,defaultModel:'gemini-3.5-flash'}});
  return Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[verifiedRow()]});
 });vi.stubGlobal('fetch',request);const form=await configureForm();(form.elements.namedItem('model') as HTMLSelectElement).value='gemini-3.5-flash';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Nothing was saved');expect(host.textContent).toContain('Refresh vault');expect(button('Verify pending change')).toBeUndefined();
 expect(form.querySelector('fieldset')?.disabled).toBe(true);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 rejected=false;await act(async()=>button('Refresh vault').click());
 expect(form.querySelector('fieldset')?.disabled).toBe(false);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 (form.elements.namedItem('code') as HTMLInputElement).value='654321';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('Provider settings saved: enabled');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2);
});
it.each([{error:'unknown-private-value'},{error:'CONFLICT',extra:'private-value'},{}])('keeps an unrecognized 409 response locked without echoing data',async responseBody=>{
 const request=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json(responseBody,{status:409}):Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[verifiedRow()]}));
 vi.stubGlobal('fetch',request);const form=await configureForm();(form.elements.namedItem('model') as HTMLSelectElement).value='gemini-3.5-flash';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(button('Verify pending change')).toBeTruthy();expect(form.querySelector('fieldset')?.disabled).toBe(true);expect(host.textContent).not.toContain('private-value');
});
it('does not unlock an unknown change when a rejection body arrives after the deadline',async()=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void;const stalled=new Promise(resolve=>{finish=resolve;});
 const request=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?{ok:false,status:409,json:()=>stalled}:Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[verifiedRow()]}));
 vi.stubGlobal('fetch',request);const form=await configureForm();(form.elements.namedItem('model') as HTMLSelectElement).value='gemini-3.5-flash';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>vi.advanceTimersByTimeAsync(15000));await act(async()=>finish({error:'CONFLICT'}));
 expect(button('Verify pending change')).toBeTruthy();expect(form.querySelector('fieldset')?.disabled).toBe(true);expect(host.textContent).not.toContain('Nothing was saved');
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
