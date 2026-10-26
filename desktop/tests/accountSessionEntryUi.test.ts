import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HomePage} from '../src/renderer/pages/HomePage';
import {useAppStore} from '../src/renderer/stores/appStore';
vi.mock('../src/renderer/components/AccountCreditsSection',()=>({AccountCreditsSection:()=>null}));
const {JSDOM}=createRequire(import.meta.url)('jsdom');
let dom:any,root:ReturnType<typeof createRoot>;
const provider={providerMode:'managed',defaultGeminiModel:'flash',modelOptions:[{modelId:'flash'}],
 defaultDeepgramModel:'flux',deepgramModelOptions:[{modelId:'flux'}]};
beforeEach(()=>{
 dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 dom.window.HTMLElement.prototype.scrollIntoView=vi.fn();
 vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 useAppStore.setState(useAppStore.getInitialState(),true);
 dom.window.electronAPI={getProviderStatus:vi.fn(async()=>provider)};
 root=createRoot(document.getElementById('root')!);
});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.useRealTimers();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(HomePage,{onCollapse:()=>{},
 account:{mode:'cluera-staging',state:'active',userId:'synthetic-owner'}})));}
const create=()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.includes('Create Session'))!;
it('shows progress immediately, blocks duplicate clicks and opens the editor after the read',async()=>{
 let resolve!:(value:unknown)=>void;
 dom.window.electronAPI.getProviderStatus.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 await render();const button=create();await act(async()=>{button.click();button.click();});
 expect(button.disabled).toBe(true);expect(document.querySelector('[role="status"]')?.textContent).toContain('Checking');
 expect(dom.window.electronAPI.getProviderStatus).toHaveBeenCalledTimes(1);
 await act(async()=>resolve(provider));expect(useAppStore.getState().page).toBe('create');
});
it('focuses the failure so a scrolled dashboard cannot hide the reason and permits an explicit retry',async()=>{
 dom.window.electronAPI.getProviderStatus.mockResolvedValue({...provider,modelOptions:[]});
 await render();await act(async()=>create().click());
 const alert=document.querySelector('[role="alert"]');expect(alert).not.toBeNull();expect(document.activeElement).toBe(alert);
 expect(alert?.textContent).toContain('administrator');expect(create().disabled).toBe(false);
 expect(useAppStore.getState().page).toBe('home');
 dom.window.electronAPI.getProviderStatus.mockResolvedValue(provider);await act(async()=>create().click());
 expect(useAppStore.getState().page).toBe('create');
});
it('settles an unresponsive setup read and ignores its late result',async()=>{
 vi.useFakeTimers();let resolve!:(value:unknown)=>void;
 dom.window.electronAPI.getProviderStatus.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 await render();await act(async()=>create().click());
 await act(async()=>vi.advanceTimersByTimeAsync(10000));
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('timed out');expect(create().disabled).toBe(false);
 await act(async()=>resolve(provider));expect(useAppStore.getState().page).toBe('home');expect(useAppStore.getState().providerStatus).toBeNull();
});
it('blocks session entry when transcription has no approved model',async()=>{
 dom.window.electronAPI.getProviderStatus.mockResolvedValue({...provider,deepgramModelOptions:[]});
 await render();await act(async()=>create().click());
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('transcription');expect(useAppStore.getState().page).toBe('home');
});
