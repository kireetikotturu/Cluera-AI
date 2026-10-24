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
  if(url.includes('operation')){unknown=false;return Response.json({code:'APPLIED',operationId:new URL(url,'https://fixture.invalid').searchParams.get('operation'),metadata:{...row,revision:2}});}
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
async function pendingMetadata(request:ReturnType<typeof vi.fn>){
 vi.stubGlobal('fetch',request);await render();await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!,action=form.elements.namedItem('action') as HTMLSelectElement;
 await act(async()=>{action.value='TEST';action.dispatchEvent(new Event('change',{bubbles:true}));});
 (form.elements.namedItem('factor') as HTMLSelectElement).value=factor;(form.elements.namedItem('code') as HTMLInputElement).value='123456';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 return form;
}
function pendingFixture(verify:(operationId:string)=>Response|Promise<Response>,retry?:(body:any)=>Response){
 return vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){const body=JSON.parse(String(init.body));return body.retry&&retry?retry(body):Response.json({error:'PROVIDER_SERVICE_UNAVAILABLE'},{status:503});}
  const params=new URL(url,'https://fixture.invalid').searchParams;
  if(params.has('operation'))return verify(params.get('operation')!);
  return Response.json(params.has('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[row]});
 });
}
it('recovers a not-recorded metadata check using the same operation and fresh MFA, without resubmitting a key or enabling',async()=>{
 const request=pendingFixture(operationId=>Response.json({code:'NOT_RECORDED',operationId,metadata:row}),body=>Response.json({code:'APPLIED',operationId:body.operationId,metadata:{...verifiedRow(),revision:2}}));
 const original=await pendingMetadata(request);await act(async()=>button('Verify pending change').click());
 expect(host.textContent).toContain('No completed audit record');expect(original.querySelector('fieldset')?.disabled).toBe(true);
 const form=host.querySelector('form[aria-label="Retry original metadata check"]')! as HTMLFormElement;
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(request.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
 (form.elements.namedItem('factor') as HTMLSelectElement).value=factor;(form.elements.namedItem('code') as HTMLInputElement).value='654321';
 await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 const posts=request.mock.calls.filter(([,i])=>i?.method==='POST').map(([,i])=>JSON.parse(String(i?.body)));
 expect(posts).toHaveLength(2);expect(posts[1]).toEqual({...posts[0],retry:true,code:'654321'});
 expect(posts[1]).not.toHaveProperty('apiKey');expect(posts[1]).not.toHaveProperty('enabled');expect(posts[1]).not.toHaveProperty('defaultModel');
 expect(host.textContent).toContain('Original operation confirmed');expect(host.textContent).toContain('Key saved');expect(host.textContent).not.toContain('654321');expect(button('Verify pending change')).toBeUndefined();
 expect(host.querySelector('.ai-provider-grid fieldset')?.hasAttribute('disabled')).toBe(false);
});
it.each([401,403,429,503])('shows actionable verification HTTP %s without releasing the pending operation or retrying',async status=>{
 let recovered=false;const request=pendingFixture(operationId=>recovered?Response.json({code:'APPLIED',operationId,metadata:{...row,revision:2}}):Response.json({error:'private-server-value'},{status}));
 await pendingMetadata(request);await act(async()=>button('Verify pending change').click());
 expect(host.textContent).toContain(status===401||status===403?'active Admin session and MFA':status===429?'rate limited':'temporarily unavailable');
 expect(host.textContent).not.toContain('private-server-value');expect(button('Verify pending change')).toBeTruthy();expect(button('Retry metadata check')).toBeUndefined();
 recovered=true;await act(async()=>button('Verify pending change').click());
 expect(host.textContent).toContain('Original operation confirmed');expect(button('Load existing authenticators').disabled).toBe(false);
 expect(request.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
});
it('refresh while pending verifies the same operation instead of discarding its status',async()=>{
 const request=pendingFixture(operationId=>Response.json({code:'NOT_RECORDED',operationId,metadata:row}));await pendingMetadata(request);
 await act(async()=>button('Refresh vault').click());expect(host.textContent).toContain('No completed audit record');
 const url=String(request.mock.calls.at(-1)?.[0]);expect(url).toContain('operation=');expect(url).toContain('provider=gemini');expect(url).toContain('revision=1');
});
it('releases a superseded request using current settings and requires a new deliberate change',async()=>{
 const request=pendingFixture(operationId=>Response.json({code:'SUPERSEDED',operationId,metadata:{...row,revision:3}}));await pendingMetadata(request);
 await act(async()=>button('Verify pending change').click());expect(host.textContent).toContain('old revision can no longer apply');expect(button('Verify pending change')).toBeUndefined();
 expect(request.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
});
it.each(['wrong-id','wrong-provider','unexpected','extra-field','wrong-revision'])('retains the lock for %s verification data',async failure=>{
 const request=pendingFixture(operationId=>Response.json(failure==='unexpected'?{code:'NOT_FOUND'}:{code:'NOT_RECORDED',operationId:failure==='wrong-id'?crypto.randomUUID():operationId,metadata:{...row,...(failure==='wrong-provider'?{provider:'deepgram'}:{}),...(failure==='wrong-revision'?{revision:2}:{})},...(failure==='extra-field'?{apiKey:'private-value'}:{})}));
 await pendingMetadata(request);await act(async()=>button('Verify pending change').click());expect(button('Verify pending change')).toBeTruthy();expect(button('Retry metadata check')).toBeUndefined();expect(host.textContent).not.toContain('private-value');
});
it('keeps a failed retry bound to its original operation and requires verification before another code',async()=>{
 const request=pendingFixture(operationId=>Response.json({code:'NOT_RECORDED',operationId,metadata:row}),()=>Response.json({error:'FORBIDDEN'},{status:403}));await pendingMetadata(request);await act(async()=>button('Verify pending change').click());
 const form=host.querySelector('form[aria-label="Retry original metadata check"]')! as HTMLFormElement;(form.elements.namedItem('factor') as HTMLSelectElement).value=factor;(form.elements.namedItem('code') as HTMLInputElement).value='654321';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('original operation is still pending verification');expect(button('Retry metadata check')).toBeUndefined();expect(button('Verify pending change')).toBeTruthy();
});
it('never offers a key replacement replay when an unknown key-save has no audit',async()=>{
 const request=pendingFixture(operationId=>Response.json({code:'NOT_RECORDED',operationId,metadata:row}));vi.stubGlobal('fetch',request);await render();await act(async()=>button('Refresh vault').click());await act(async()=>button('Load existing authenticators').click());
 const form=host.querySelector('form')!;(form.elements.namedItem('key') as HTMLInputElement).value='synthetic-private-entry-value';await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>button('Verify pending change').click());expect(button('Retry metadata check')).toBeUndefined();expect(host.textContent).toContain('Absence does not prove failure');expect(host.textContent).not.toContain('synthetic-private-entry-value');
});
it('fences a late successful verification after the read deadline, then restores availability on a fresh read',async()=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void,stalled=true;
 const request=pendingFixture(operationId=>stalled?({ok:true,json:()=>new Promise(resolve=>{finish=resolve;})} as Response):Response.json({code:'APPLIED',operationId,metadata:{...row,revision:2}}));await pendingMetadata(request);
 const id=JSON.parse(String(request.mock.calls.find(([,i])=>i?.method==='POST')?.[1]?.body)).operationId;
 await act(async()=>button('Verify pending change').click());await act(async()=>vi.advanceTimersByTimeAsync(15000));await act(async()=>finish({code:'APPLIED',operationId:id,metadata:{...row,revision:2}}));expect(button('Verify pending change')).toBeTruthy();
 stalled=false;await act(async()=>button('Verify pending change').click());expect(host.textContent).toContain('Original operation confirmed');expect(host.querySelector('.ai-provider-grid fieldset')?.hasAttribute('disabled')).toBe(false);
});
it('retains the original settings on retry and offers a separately approved metadata check after rejection',async()=>{
 const posts:any[]=[];
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){
   const body=JSON.parse(String(init.body));posts.push(body);
   if(body.retry)return Response.json({code:'REJECTED',operationId:body.operationId,metadata:verifiedRow()});
   if(body.action==='TEST')return Response.json({code:'APPLIED',metadata:{...verifiedRow(),revision:2}});
   return Response.json({error:'PROVIDER_SERVICE_UNAVAILABLE'},{status:503});
  }
  const params=new URL(url,'https://fixture.invalid').searchParams;
  return Response.json(params.has('operation')?{code:'NOT_RECORDED',operationId:params.get('operation'),metadata:verifiedRow()}:params.has('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[verifiedRow()]});
 });vi.stubGlobal('fetch',request);const form=await configureForm();(form.elements.namedItem('model') as HTMLSelectElement).value='gemini-3.5-flash';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await act(async()=>button('Verify pending change').click());
 expect(host.textContent).toContain('Original settings: provider enabled; default model gemini-3.5-flash');
 const recovery=host.querySelector('form[aria-label="Retry original provider settings"]')! as HTMLFormElement;
 (recovery.elements.namedItem('factor') as HTMLSelectElement).value=factor;(recovery.elements.namedItem('code') as HTMLInputElement).value='654321';
 await act(async()=>recovery.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(posts[1]).toEqual({...posts[0],code:'654321',retry:true});expect(host.textContent).toContain('original operation is still unconfirmed');expect(button('Verify pending change')).toBeTruthy();
 await act(async()=>button('Run new metadata check').click());expect(posts).toHaveLength(2);
 const refreshed=host.querySelector('form[aria-label="Retry original provider settings"]')! as HTMLFormElement;
 (refreshed.elements.namedItem('factor') as HTMLSelectElement).value=factor;(refreshed.elements.namedItem('code') as HTMLInputElement).value='987654';await act(async()=>button('Run new metadata check').click());
 expect(posts).toHaveLength(3);expect(posts[2].action).toBe('TEST');expect(posts[2].operationId).not.toBe(posts[0].operationId);expect(posts[2].revision).toBe(posts[0].revision);
 expect(posts[2]).not.toHaveProperty('enabled');expect(posts[2]).not.toHaveProperty('apiKey');expect(posts[2]).not.toHaveProperty('defaultModel');
 expect(button('Verify pending change')).toBeUndefined();expect(host.textContent).toContain('Metadata check complete');
});
