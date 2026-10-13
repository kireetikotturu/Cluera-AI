import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Simulate} from 'react-dom/test-utils';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SessionEditorPage} from '../src/renderer/pages/SessionEditorPage';
import {useAppStore} from '../src/renderer/stores/appStore';
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
let dom:any,root:ReturnType<typeof createRoot>;
const provider=(model='flash')=>({providerMode:'managed',defaultGeminiModel:model,modelOptions:[{modelId:model,displayName:model}]} as any);
const session={id:'session-one',title:'Original session',company:'Acme',role:'Engineer',resumeText:'Resume',jobDescription:'Description',selectedModel:'flash',language:'English'};
beforeEach(()=>{
 dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 // React 18 is imported before this manual DOM exists, so it selects its
 // legacy input-event shim. Real browser input is checked separately.
 dom.window.HTMLElement.prototype.attachEvent=()=>{};
 dom.window.HTMLElement.prototype.detachEvent=()=>{};
 vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 useAppStore.setState(useAppStore.getInitialState(),true);useAppStore.setState({providerStatus:provider()});
 dom.window.electronAPI={listLibraryFiles:vi.fn(async()=>[]),getProviderStatus:vi.fn(async()=>provider()),
  getSession:vi.fn(async()=>({session,documents:[{id:'document-one',type:'supporting',name:'Notes',sizeBytes:100,text:'notes'}]})),
  removeDocument:vi.fn(async()=>{throw Error('Synthetic removal failed');}),saveSession:vi.fn(async()=>session),
  listSessions:vi.fn(async()=>[session]),addTextDocument:vi.fn(async()=>({id:'text-one'})),addExtractedDocument:vi.fn(async()=>({}))};
 root=createRoot(document.getElementById('root')!);
});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(SessionEditorPage,{onCollapse:()=>{},account:true} as any)));}
function fill(selector:string,value:string){const input=document.querySelector(selector) as HTMLInputElement;
 Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);
 Simulate.change(input);}
it('preserves the new-session draft when the approved model default refreshes',async()=>{
 await render();await act(async()=>fill('input[placeholder="Frontend interview at Acme"]','Unsaved interview'));
 expect((document.querySelector('input[placeholder="Frontend interview at Acme"]') as HTMLInputElement).value).toBe('Unsaved interview');
 await act(async()=>useAppStore.setState({providerStatus:provider('pro')}));
 expect((document.querySelector('input[placeholder="Frontend interview at Acme"]') as HTMLInputElement).value).toBe('Unsaved interview');
});
it('catches failed removal, keeps the supporting file and reports a recoverable error',async()=>{
 useAppStore.setState({activeSessionId:session.id});await render();
 await act(async()=>(document.querySelector('[aria-label="Remove Notes"]') as HTMLButtonElement).click());
 expect(document.body.textContent).toContain('Synthetic removal failed');expect(document.querySelector('[aria-label="Remove Notes"]')).not.toBeNull();
});
it('serializes same-tick saves and retains all required context validation',async()=>{
 useAppStore.setState({activeSessionId:session.id});await render();
 const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent?.includes('Save Session'))!;
 await act(async()=>{button.click();button.click();});
 expect(dom.window.electronAPI.saveSession).toHaveBeenCalledTimes(1);
 expect(useAppStore.getState().page).toBe('copilot');
});
it('keeps the Account action bar outside the form scroller and labels supporting text',async()=>{
 await render();const footer=document.querySelector('.wizard-actions')!;
 expect(footer.closest('.wizard-content')).toBeNull();expect(document.querySelector('textarea[aria-label="Supporting context text"]')).not.toBeNull();
});
