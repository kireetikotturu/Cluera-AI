import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('../src/renderer/pages/HomePage',()=>({HomePage:()=>createElement('div',null,'Dashboard')}));
vi.mock('../src/renderer/pages/CopilotPage',()=>({CopilotPage:()=>createElement('div',null,'Live page')}));
vi.mock('../src/renderer/components/DiagonalResizeHandle',()=>({DiagonalResizeHandle:()=>null}));
import App from '../src/renderer/App';
import {useAppStore} from '../src/renderer/stores/appStore';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const account={mode:'cluera-staging' as const,state:'active' as const,userId:'00000000-0000-4000-8000-000000000001'};
let dom:any,root:ReturnType<typeof createRoot>,events:Map<string,(payload:unknown)=>void>;
beforeEach(()=>{
  dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}}));
  vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>{callback();return 1;});
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  useAppStore.setState(useAppStore.getInitialState(),true);
  events=new Map();
  dom.window.electronAPI={bridgeVersion:'2.0.0',onEvent:(name:string,callback:(payload:unknown)=>void)=>{events.set(name,callback);return()=>events.delete(name);},
    getUpdateStatus:async()=>({state:'current'}),checkForUpdates:async()=>({state:'current'}),listSessions:async()=>[],getProviderStatus:async()=>({providerMode:'managed'}),
    getSettings:async()=>({theme:'dark',overlayOpacity:1})};
  dom.window.accountAPI={openWeb:vi.fn(async()=>undefined),credits:{refresh:vi.fn(async()=>({}))}};
  root=createRoot(document.getElementById('root')!);
});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals();});
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent?.trim()===text)!;
it('returns to the dashboard with a clear warning and a way to add time when the time runs out',async()=>{
  await act(async()=>root.render(createElement(App,{account})));
  expect(document.body.textContent).toContain('Dashboard');
  await act(async()=>events.get('session:time-over')!(null));
  const dialog=document.querySelector('dialog.time-up-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);expect(dialog.textContent).toContain('Your time is used up');
  expect(dom.window.accountAPI.credits.refresh).toHaveBeenCalled();
  await act(async()=>button('Add time').click());
  expect(dom.window.accountAPI.openWeb).toHaveBeenCalledExactlyOnceWith('credits');
  await act(async()=>button('Not now').click());
  expect(document.querySelector('dialog.time-up-dialog')).toBeNull();expect(useAppStore.getState().timeOver).toBe(false);
});
it('does not show an old notice again after a new session',async()=>{
  await act(async()=>root.render(createElement(App,{account})));
  await act(async()=>events.get('session:time-over')!(null));
  await act(async()=>useAppStore.setState({page:'copilot' as const,activeSessionId:null}));
  await act(async()=>useAppStore.getState().setPage('home'));
  expect(document.querySelector('dialog.time-up-dialog')).toBeNull();
});
it('does not cover the live page while it is still closing',async()=>{
  await act(async()=>root.render(createElement(App,{account})));
  await act(async()=>{useAppStore.setState({page:'copilot' as const,activeSessionId:null});useAppStore.getState().setTimeOver(true);});
  expect(document.querySelector('dialog.time-up-dialog')).toBeNull();
});
