import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HomePage} from '../src/renderer/pages/HomePage';
import {useAppStore} from '../src/renderer/stores/appStore';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const account={mode:'cluera-staging' as const,state:'active' as const,userId:'00000000-0000-4000-8000-000000000001',email:'synthetic@example.invalid'};
const session=(id:string)=>({id,title:id,company:'Synthetic',role:'Engineer',updatedAt:new Date().toISOString()});
let dom:any,root:ReturnType<typeof createRoot>;
beforeEach(()=>{
 dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 dom.window.confirm=()=>true;
 dom.window.electronAPI={getSession:vi.fn(async()=>null),deleteSession:vi.fn()};
 useAppStore.setState(useAppStore.getInitialState(),true);useAppStore.setState({sessions:[session('first')] as any});
 root=createRoot(document.getElementById('root')!);
});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(HomePage,{onCollapse:()=>{},account,customerName:'Synthetic'})));}
it('serializes deletion and retains a session added while the delete is pending',async()=>{
 let resolve!:()=>void;dom.window.electronAPI.deleteSession.mockImplementation(()=>new Promise<void>(r=>{resolve=r;}));
 await render();await act(async()=>{const button=document.querySelector('[aria-label="Delete first"]') as HTMLButtonElement;button.click();button.click();});
 expect(dom.window.electronAPI.deleteSession).toHaveBeenCalledOnce();
 await act(async()=>useAppStore.setState({sessions:[session('first'),session('new')] as any}));
 await act(async()=>resolve());
 expect(useAppStore.getState().sessions.map(s=>s.id)).toEqual(['new']);
});
it('retains the session and shows fixed safe guidance on a failed delete',async()=>{
 dom.window.electronAPI.deleteSession.mockRejectedValue(new Error('Private underlying detail must not escape'));
 await render();await act(async()=>(document.querySelector('[aria-label="Delete first"]') as HTMLButtonElement).click());
 expect(useAppStore.getState().sessions.map(s=>s.id)).toEqual(['first']);
 expect(useAppStore.getState().error).toBe('Session deletion could not be confirmed. Your session list is retained.');
});
it('does not mutate another workspace after the dashboard unmounts',async()=>{
 let resolve!:()=>void;dom.window.electronAPI.deleteSession.mockImplementation(()=>new Promise<void>(r=>{resolve=r;}));
 await render();await act(async()=>(document.querySelector('[aria-label="Delete first"]') as HTMLButtonElement).click());
 act(()=>root.unmount());root=createRoot(document.createElement('div'));
 useAppStore.setState({sessions:[session('other-owner')] as any});await act(async()=>resolve());
 expect(useAppStore.getState().sessions.map(s=>s.id)).toEqual(['other-owner']);
});
