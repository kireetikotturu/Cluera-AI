// @vitest-environment jsdom
import {createHash,randomUUID} from 'node:crypto';
// Node's File can be read like a browser file; the simulated one in this test page cannot.
import {File as NodeFile} from 'node:buffer';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {sendResume,RESUME_RETRY_MS} from '../lib/live/resumeUpload';
import {SetupForm,type SetupDraft} from '../app/account/live/SetupForm';

const BrowserFile=NodeFile as unknown as typeof File;
const sessionRef=randomUUID(),prefix='https://yhnqlfcgrmckhyjdxegg.supabase.co/storage/v1/object/upload/sign/customer-resumes/pending/';
const digest=async(data:BufferSource)=>{const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data as ArrayBuffer);return new Uint8Array(createHash('sha256').update(bytes).digest()).buffer;};
const deps=(replies:Array<()=>Response>)=>{const calls:Array<[string,RequestInit]>=[],waits:number[]=[];
 return {calls,waits,value:{request:(async(url:string|URL|Request,init?:RequestInit)=>{calls.push([String(url),init!]);return (replies.shift()??(()=>Response.json({stored:true})))();}) as typeof fetch,digest,wait:async(ms:number)=>{waits.push(ms);}}};};
const pdf=()=>new BrowserFile([new TextEncoder().encode('%PDF-1.4 resume bytes')],'Asha CV.pdf',{type:''});

it('sends the uploaded PDF straight to private storage and then asks for it to be kept',async()=>{
 const url=`${prefix}user/id?token=t`,h=deps([()=>Response.json({id:'11111111-1111-4111-8111-111111111111',upload:{url}}),()=>new Response('{}'),()=>Response.json({stored:true})]);
 const file=pdf();
 expect(await sendResume({text:'Asha Rao',name:'Asha CV',file,sessionRef},h.value)).toBe('saved');
 expect(h.calls.map(([u,init])=>[init.method,u])).toEqual([['POST','/api/account/resume'],['PUT',url],['POST','/api/account/resume']]);
 expect(JSON.parse(String(h.calls[0][1].body))).toEqual({step:'BEGIN',kind:'PDF',hash:createHash('sha256').update('%PDF-1.4 resume bytes').digest('hex'),bytes:file.size,name:'Asha CV.pdf',sessionRef,text:'Asha Rao'});
 expect(h.calls[0][1].credentials).toBe('same-origin');
 expect(h.calls[1][1]).toMatchObject({headers:{'content-type':'application/pdf','x-upsert':'true'},credentials:'omit',body:file});
});
it('sends only the text for a typed or saved résumé, and nothing without one',async()=>{
 const h=deps([]);
 expect(await sendResume({text:'  My experience  ',name:'Typed résumé',file:null,sessionRef},h.value)).toBe('saved');
 expect(JSON.parse(String(h.calls[0][1].body))).toMatchObject({kind:'TYPED',text:'My experience',name:'Typed résumé',bytes:13});
 expect(await sendResume({text:'   ',name:'x',file:pdf(),sessionRef},h.value)).toBe('skipped');expect(h.calls).toHaveLength(1);
});
it('retries a network problem, gives up on a refusal, and never uploads elsewhere',async()=>{
 const flaky=deps([()=>new Response('',{status:503}),()=>Response.json({stored:true})]);
 expect(await sendResume({text:'x'.repeat(10),name:'a',file:null,sessionRef},flaky.value)).toBe('saved');expect(flaky.waits).toEqual([RESUME_RETRY_MS[0]]);
 const refused=deps([()=>new Response('',{status:401})]);
 expect(await sendResume({text:'abc',name:'a',file:null,sessionRef},refused.value)).toBe('failed');expect(refused.calls).toHaveLength(1);
 const elsewhere=deps([()=>Response.json({id:'x',upload:{url:'https://attacker.invalid/put'}})]);
 expect(await sendResume({text:'abc',name:'a',file:pdf(),sessionRef},elsewhere.value)).toBe('failed');expect(elsewhere.calls).toHaveLength(1);
});
it('keeps the uploaded file with the new session, drops it when removed, and says that a copy is saved',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const started:SetupDraft[]=[];
 const models=[{modelId:'gemini-3.6-flash',displayName:'Gemini',provider:'gemini' as const,isDefault:true,tag:'',image:true}];
 await act(async()=>root.render(createElement(SetupForm,{models,defaults:{interviewContext:'',assignmentContext:'',assignmentModel:''},documents:[],busy:false,error:'',onStart:(draft:SetupDraft)=>started.push(draft),onBack:()=>{}})));
 expect(host.querySelector('a[href="/privacy"]')?.parentElement?.textContent).toContain('a copy of this résumé is saved to your Cluera account');
 const role=host.querySelector('input[required]') as HTMLInputElement;
 const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
 await act(async()=>{setter.call(role,'Java developer');role.dispatchEvent(new Event('input',{bubbles:true}));});
 const input=host.querySelector('input[type="file"]') as HTMLInputElement;
 const file=new BrowserFile(['Asha Rao\nSpring Boot developer with five years of payment systems experience.'],'Asha CV.txt',{type:'text/plain'});
 Object.defineProperty(input,'files',{configurable:true,value:[file]});
 await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
 await vi.waitFor(()=>expect(host.textContent).toContain('Read from your file'));
 const submit=()=>act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 await submit();
 expect(started[0].resumeFile).toBe(file);expect(started[0].resumeName).toBe('Asha CV');
 const remove=[...host.querySelectorAll('button')].find(button=>button.textContent==='Remove')!;
 await act(async()=>remove.click());await submit();
 expect(started[1].resumeFile).toBeNull();expect(started[1].resumeText).toBe('');
 act(()=>root.unmount());host.remove();vi.unstubAllGlobals();
});
