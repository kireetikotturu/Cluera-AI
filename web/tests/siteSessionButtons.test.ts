// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AdminRoleProvider} from '../app/account/AdminRoleNavigation';
import {BuyLink} from '../app/BuyLink';

let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);
 window.localStorage.clear();document.documentElement.removeAttribute('data-signed-in');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const render=async(status:number)=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status})));
 await act(async()=>root.render(createElement(AdminRoleProvider,null,createElement(BuyLink,{offerCode:'cluera_pack_3h_v2',label:'Buy Now: Pro'},'Buy Now'))));
 await act(async()=>{await Promise.resolve();});
};
const link=()=>host.querySelector('a')!;

it('sends a signed-out visitor straight to sign-in with the chosen plan kept',async()=>{
 await render(401);
 expect(link().getAttribute('href')).toBe('/account?offer=cluera_pack_3h_v2#login');
 expect(document.documentElement.hasAttribute('data-signed-in')).toBe(false);
});
it('sends a signed-in visitor straight to checkout and marks the page as signed in',async()=>{
 await render(403);
 expect(link().getAttribute('href')).toBe('/account/checkout?offer=cluera_pack_3h_v2');
 expect(document.documentElement.getAttribute('data-signed-in')).toBe('1');
 expect(window.localStorage.getItem('cluera-signed-in-hint-v1')).toBe('1');
});
it('forgets the signed-in hint once the visitor is signed out', async()=>{
 window.localStorage.setItem('cluera-signed-in-hint-v1','1');
 await render(401);
 expect(window.localStorage.getItem('cluera-signed-in-hint-v1')).toBe('0');
 expect(document.documentElement.hasAttribute('data-signed-in')).toBe(false);
});
