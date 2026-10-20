import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('../src/renderer/pages/HomePage',()=>({HomePage:()=>createElement('div',null,'Workspace ready')}));
vi.mock('../src/renderer/components/DiagonalResizeHandle',()=>({DiagonalResizeHandle:()=>null}));
import App from '../src/renderer/App';
import {useAppStore} from '../src/renderer/stores/appStore';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const account={mode:'cluera-staging' as const,state:'active' as const,userId:'00000000-0000-4000-8000-000000000001'};
let dom:any,root:ReturnType<typeof createRoot>,resolve:(value:any)=>void,reject:(error:Error)=>void;
beforeEach(()=>{
  dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}}));
  useAppStore.setState(useAppStore.getInitialState(),true);
  dom.window.electronAPI={bridgeVersion:'2.0.0',onEvent:()=>()=>{},
    getUpdateStatus:async()=>({state:'current'}),checkForUpdates:async()=>({state:'current'}),
    listSessions:vi.fn(()=>new Promise((yes,no)=>{resolve=yes;reject=no;})),
    getProviderStatus:async()=>({providerMode:'managed'}),
    getSettings:async()=>({theme:'dark',overlayOpacity:1})};
  root=createRoot(document.getElementById('root')!);
});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals();});
it.each(['resolve','reject'])('ignores late workspace %s after account unmount',async outcome=>{
  await act(async()=>root.render(createElement(App,{account})));
  act(()=>root.unmount());root=createRoot(document.createElement('div'));
  useAppStore.setState({sessions:[{id:'other-owner'}] as any,error:null});
  await act(async()=>outcome==='resolve'?resolve([{id:'old-owner'}]):reject(new Error('private data')));
  expect(useAppStore.getState().sessions.map(value=>value.id)).toEqual(['other-owner']);
  expect(useAppStore.getState().error).toBeNull();
});
it('offers explicit retry after initialization failure without exposing internal errors',async()=>{
  await act(async()=>root.render(createElement(App,{account})));
  await act(async()=>reject(new Error('private local path')));
  expect(document.body.textContent).toContain('Workspace could not load');
  expect(document.body.textContent).not.toContain('private local path');
  await act(async()=>(document.querySelector('button') as HTMLButtonElement).click());
  expect(dom.window.electronAPI.listSessions).toHaveBeenCalledTimes(2);
  await act(async()=>resolve([]));
  expect(document.body.textContent).toContain('Workspace ready');
});
