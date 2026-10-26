// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AiQuickSetup} from '../app/account/admin/AiQuickSetup';

let host:HTMLDivElement,root:Root;
const factor='00000000-0000-4000-8000-000000000003';
const meta=(provider:string,extra:object={})=>({provider,revision:1,credentialPresent:true,enabled:false,defaultModel:null,probeStatus:'UNVERIFIED',probeAt:null,models:[],complete:false,updatedAt:'2026-10-13T00:00:00Z',...extra});
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const render=(onApplied?:()=>void)=>act(async()=>root.render(createElement(AiQuickSetup,{onApplied})));
function api(post:(body:any)=>Response){
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return post(JSON.parse(String(init.body)));
  return Response.json(url.includes('factors')?{factors:[{id:factor,status:'verified'}]}:{code:'ACTIVE',providers:[meta('gemini')]});
 });vi.stubGlobal('fetch',request);return request;
}
async function fill(provider:'gemini'|'deepgram',key='synthetic-quick-setup-key-0000',code='123456'){
 const form=[...host.querySelectorAll('form')].find(f=>f.textContent?.includes(provider==='gemini'?'Google Gemini API key':'Deepgram API key'))!;
 (form.elements.namedItem('key') as HTMLInputElement).value=key;(form.elements.namedItem('code') as HTMLInputElement).value=code;
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));return form;
}
it('makes no request until Check status and then offers both providers',async()=>{
 const request=api(()=>Response.json({}));await render();expect(request).not.toHaveBeenCalled();expect(host.querySelector('form')).toBeNull();
 await act(async()=>button('Check status').click());
 expect(request).toHaveBeenCalledTimes(2);expect(host.textContent).toContain('Google Gemini');expect(host.textContent).toContain('Deepgram');expect(host.textContent).toContain('Key saved · not enabled');
});
it('explains when the vault is not switched on',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('factors')?Response.json({factors:[]}):Response.json({error:'VAULT_BOOTSTRAP_REQUIRED'},{status:503})));
 await render();await act(async()=>button('Check status').click());
 expect(host.textContent).toContain('encrypted key vault is not switched on');expect(host.querySelector('form')).toBeNull();
});
it('sends one SETUP request, clears secrets, refreshes and tells the admin to restart the desktop app',async()=>{
 let setups=0;const applied=vi.fn();
 const request=api(body=>{setups+=1;expect(body).toMatchObject({action:'SETUP',provider:'gemini',revision:1,factorId:factor,code:'123456'});
  return Response.json({code:'SETUP_COMPLETE',modelId:'gemini-3.5-flash',metadata:meta('gemini',{enabled:true})});});
 await render(applied);await act(async()=>button('Check status').click());
 const form=await fill('gemini');
 expect((form.elements.namedItem('key') as HTMLInputElement).value).toBe('');expect((form.elements.namedItem('code') as HTMLInputElement).value).toBe('');
 expect(setups).toBe(1);expect(applied).toHaveBeenCalledOnce();expect(host.textContent).toContain('Restart the Cluera desktop app');
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(host.textContent).not.toContain('synthetic-quick-setup-key');
});
it.each([
 ['KEY_REJECTED','rejected this key'],['MODEL_NOT_AVAILABLE','does not list the model Cluera needs'],['CONFLICT','Settings changed'],
])('shows a plain explanation for %s',async(reason,text)=>{
 api(()=>Response.json({code:'SETUP_STOPPED',stage:'CHECK_KEY',reason,modelId:'gemini-3.5-flash',metadata:meta('gemini')}));
 await render();await act(async()=>button('Check status').click());await fill('gemini');expect(host.textContent).toContain(text);
});
it('rejects an obviously incomplete key or code without sending anything',async()=>{
 const request=api(()=>Response.json({}));await render();await act(async()=>button('Check status').click());
 await fill('gemini','short');expect(host.textContent).toContain('full API key');await fill('gemini','synthetic-quick-setup-key-0000','12');expect(host.textContent).toContain('6-digit code');
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('explains a rejected authenticator and an unknown outcome without retrying',async()=>{
 const request=api(()=>new Response(JSON.stringify({error:'FORBIDDEN'}),{status:403}));
 await render();await act(async()=>button('Check status').click());await fill('gemini');expect(host.textContent).toContain('authenticator code was not accepted');
 request.mockImplementation(async(url:string,init?:RequestInit)=>{if(init?.method==='POST')throw Error('network');return Response.json(url.includes('factors')?{factors:[{id:factor}]}:{code:'ACTIVE',providers:[]});});
 await fill('gemini');expect(host.textContent).toContain('result is unknown');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2);
});
