import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {AccountView} from '../src/shared/accounts';

vi.mock('../src/renderer/App',()=>({default:()=>createElement('div',{'data-active-workspace':true},'Active workspace')}));
vi.mock('../src/renderer/components/AccountLogin',()=>({AccountLogin:({state}:{state:AccountView})=>createElement('div',{'data-login-state':state.state},state.message)}));
vi.mock('../src/renderer/stores/appStore',()=>({useAppStore:{setState:vi.fn(),getInitialState:()=>({})}}));
import {AccountRoot} from '../src/renderer/components/AccountRoot';
const require=createRequire(import.meta.url),{JSDOM}=require('jsdom');
let dom:any,root:ReturnType<typeof createRoot>,notify:(state:AccountView)=>void,rejectStatus:(reason:Error)=>void;
beforeEach(()=>{
 dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 dom.window.accountAPI={onStatus:(callback:typeof notify)=>{notify=callback;return()=>undefined;},status:()=>new Promise((_resolve,reject)=>{rejectStatus=reject;})};
 root=createRoot(document.getElementById('root')!);
});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals();});
it('keeps an authoritative active event when an earlier initialization request later fails',async()=>{
 await act(async()=>root.render(createElement(AccountRoot)));
 await act(async()=>notify({mode:'cluera-staging',state:'active',userId:'00000000-0000-4000-8000-000000000001'}));
 expect(document.querySelector('[data-active-workspace]')).not.toBeNull();
 await act(async()=>rejectStatus(new Error('private-ipc-failure')));
 expect(document.querySelector('[data-active-workspace]')).not.toBeNull();
 expect(document.body.textContent).not.toContain('private-ipc-failure');
});
it('shows a safe initialization failure when no authoritative event has arrived',async()=>{
 await act(async()=>root.render(createElement(AccountRoot)));
 await act(async()=>rejectStatus(new Error('private-ipc-failure')));
 expect(document.querySelector('[data-login-state="unavailable"]')?.textContent).toBe('Desktop account initialization failed. Restart the app.');
});
