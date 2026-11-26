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
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent?.trim()===text)!;
it('shows one loading screen, not the sign-in form, while the app opens an account',async()=>{
 await act(async()=>root.render(createElement(AccountRoot)));
 expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
 await act(async()=>notify({mode:'cluera-staging',state:'checking',loading:true,message:'Opening your workspace…'}));
 expect(document.body.textContent).toContain('Opening your workspace…');
 expect(Number(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'))).toBeGreaterThan(30);
 expect(document.querySelector('[data-login-state]')).toBeNull();
});
it('keeps a saved sign-in that cannot be checked yet on a connecting screen with a retry, never the sign-in form',async()=>{
 dom.window.accountAPI.retry=vi.fn(async()=>({mode:'cluera-staging',state:'unavailable',reconnecting:true}));
 dom.window.accountAPI.logout=vi.fn(async()=>({mode:'cluera-staging',state:'signed-out'}));
 await act(async()=>root.render(createElement(AccountRoot)));
 await act(async()=>notify({mode:'cluera-staging',state:'unavailable',reconnecting:true}));
 expect(document.body.textContent).toContain('Connecting to your account…');
 expect(document.body.textContent).toContain('You are still signed in.');
 expect(document.querySelector('[data-login-state]')).toBeNull();
 await act(async()=>button('Try again now').click());expect(dom.window.accountAPI.retry).toHaveBeenCalledOnce();
 await act(async()=>button('Use another account').click());expect(dom.window.accountAPI.logout).toHaveBeenCalledWith(false);
 expect(document.querySelector('[data-login-state="signed-out"]')).not.toBeNull();
});
it('keeps the dashboard open while the signed-in account reconnects',async()=>{
 await act(async()=>root.render(createElement(AccountRoot)));
 await act(async()=>notify({mode:'cluera-staging',state:'active',userId:'00000000-0000-4000-8000-000000000001'}));
 await act(async()=>notify({mode:'cluera-staging',state:'active',userId:'00000000-0000-4000-8000-000000000001',reconnecting:true}));
 expect(document.querySelector('[data-active-workspace]')).not.toBeNull();
});
it('shows a safe initialization failure when no authoritative event has arrived',async()=>{
 await act(async()=>root.render(createElement(AccountRoot)));
 await act(async()=>rejectStatus(new Error('private-ipc-failure')));
 expect(document.querySelector('[data-login-state="unavailable"]')?.textContent).toBe('Desktop account initialization failed. Restart the app.');
});
