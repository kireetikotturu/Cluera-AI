import {createRequire} from 'node:module';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Simulate} from 'react-dom/test-utils';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountLogin} from '../src/renderer/components/AccountLogin';
import type {AccountView} from '../src/shared/accounts';
const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
let dom:any,root:ReturnType<typeof createRoot>,onState=vi.fn<(state:AccountView)=>void>();
beforeEach(()=>{dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 dom.window.accountAPI={login:vi.fn(async()=>({mode:'cluera-staging',state:'signed-out',message:'Synthetic rejected sign-in'})),openWeb:vi.fn(async()=>{}),google:vi.fn(async()=>({mode:'cluera-staging',state:'signed-out'}))};
 root=createRoot(document.getElementById('root')!);onState=vi.fn();});
afterEach(()=>{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals();});
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(item=>item.textContent===text)!;
async function render(state='signed-out'){await act(async()=>root.render(createElement(AccountLogin,{state:{mode:'cluera-staging',state} as any,onState})));}
function fill(type:string,value:string){const input=document.querySelector(`input[type="${type}"]`) as HTMLInputElement;input.value=value;Simulate.change(input);}
it('opens separate fixed Account creation and recovery actions without credentials',async()=>{
 await render();await act(async()=>button('Create account').click());await act(async()=>button('Forgot password?').click());
 expect(dom.window.accountAPI.openWeb.mock.calls).toEqual([['signup'],['reset-password']]);
});
it('serializes same-tick login and clears password and visibility after completion',async()=>{
 await render();await act(async()=>{fill('email','synthetic@example.invalid');fill('password','synthetic-password');});
 await act(async()=>(document.querySelector('[aria-label="Show password"]') as HTMLButtonElement).click());
 expect(document.querySelector('[aria-label="Hide password"]')).not.toBeNull();
 const form=document.querySelector('form')!;await act(async()=>{Simulate.submit(form);Simulate.submit(form);});
 expect(dom.window.accountAPI.login).toHaveBeenCalledTimes(1);expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');expect(onState).toHaveBeenCalledTimes(1);
});
it('disables every authentication action while main is restoring the session',async()=>{
 await render('checking');for(const action of ['Continue with Google','Create account','Forgot password?','Retry saved session'])expect(button(action).disabled).toBe(true);
 expect(dom.window.accountAPI.login).not.toHaveBeenCalled();
});
