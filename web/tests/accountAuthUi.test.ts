// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {emailNotice} from '../lib/accounts/publicAuth';
import {resolveCheckoutSelection} from '../lib/cluera/checkoutJourney';
vi.mock('../app/account/AccountWorkspace',()=>({AccountWorkspace:()=>createElement('p',{},'Synthetic account workspace')}));
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);sessionStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account');vi.stubGlobal('fetch',vi.fn(async()=>Response.json({},{status:401})));});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it.each([['#signup','Create an account'],['#forgot-password','Reset your password'],['#unknown','Sign in']])('honors only allowlisted non-secret browser handoff %s',async(hash,title)=>{
 history.replaceState(null,'',`/account${hash}`);await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.querySelector('h2')?.textContent).toBe(title);expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('preserves signup password policy, shows password accessibly and submits only once',async()=>{
 history.replaceState(null,'','/account#signup');const fetcher=vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401}));vi.stubGlobal('fetch',fetcher);
 await act(async()=>root.render(createElement(AccountPanel)));
 const password=host.querySelector('input[name="password"]') as HTMLInputElement;expect(password.minLength).toBe(12);expect(password.maxLength).toBe(128);
 await act(async()=>(host.querySelector('[aria-label="Show password"]') as HTMLButtonElement).click());expect(password.type).toBe('text');
 (host.querySelector('input[name="email"]') as HTMLInputElement).value='synthetic@example.invalid';password.value='synthetic-password';
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(posts[0][1]?.signal).toBeInstanceOf(AbortSignal);expect(password.value).toBe('');expect(host.textContent).toContain(emailNotice);
});
it('updates an existing browser page for a new handoff and clears the previous password',async()=>{
 await act(async()=>root.render(createElement(AccountPanel)));
 (host.querySelector('input[name="password"]') as HTMLInputElement).value='synthetic-old-password';
 await act(async()=>{history.replaceState(null,'','/account#signup');window.dispatchEvent(new HashChangeEvent('hashchange'));});
 expect(host.querySelector('h2')?.textContent).toBe('Create an account');expect((host.querySelector('input[name="password"]') as HTMLInputElement).value).toBe('');
 await act(async()=>{history.replaceState(null,'','/account#forgot-password');window.dispatchEvent(new HashChangeEvent('hashchange'));});
 expect(host.querySelector('h2')?.textContent).toBe('Reset your password');expect(host.querySelector('input[name="password"]')).toBeNull();expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it('updates the safe URL hint when switching back to sign in',async()=>{
 history.replaceState(null,'','/account#signup');await act(async()=>root.render(createElement(AccountPanel)));
 await act(async()=>{Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Back to sign in')!.click();});
 expect(host.querySelector('h2')?.textContent).toBe('Sign in');expect(location.hash).toBe('#login');
});
it('does not reflect unexpected upstream errors into the page',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'PRIVATE_UPSTREAM_DETAILS'},{status:503})));
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.textContent).not.toContain('PRIVATE_UPSTREAM_DETAILS');expect(host.textContent).toContain('Account service is unavailable.');
});
it('rejects malformed account snapshots rather than entering the workspace',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({account:{email:'PRIVATE_UPSTREAM_DETAILS'},passwordRecovery:false})));
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.textContent).not.toContain('Signed in as');expect(host.textContent).not.toContain('PRIVATE_UPSTREAM_DETAILS');
 expect(host.textContent).toContain('Account service is unavailable.');
});
it('offers explicit email-only verification resend with no automatic request',async()=>{
 history.replaceState(null,'','/account#resend-verification');const fetcher=vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401}));vi.stubGlobal('fetch',fetcher);
 await act(async()=>root.render(createElement(AccountPanel)));expect(host.querySelector('h2')?.textContent).toBe('Resend verification');expect(host.querySelector('input[name="password"]')).toBeNull();expect(fetcher).toHaveBeenCalledOnce();
 (host.querySelector('input[name="email"]') as HTMLInputElement).value='fixture@example.invalid';await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 const post=fetcher.mock.calls.find(([,init])=>init?.method==='POST')!;expect(post[0]).toBe('/api/account/resend-verification');expect(JSON.parse(post[1]!.body as string)).toEqual({email:'fixture@example.invalid'});expect(host.textContent).toContain(emailNotice);
});
it('retains the selected plan through signup and email/Google return without requesting payment',async()=>{
 history.replaceState(null,'','/account?offer=cluera_monthly_100h_v2#signup');
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.textContent).toContain('Selected plan: Cluera Pro 100 Hours');
 expect(sessionStorage.getItem('cluera.checkout-selection.v1')).toContain('cluera_monthly_100h_v2');
 expect(vi.mocked(fetch).mock.calls.every(([url,init])=>url==='/api/account/session'&&!init?.method)).toBe(true);
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Back to sign in')!.click());
 expect(location.search).toBe('?offer=cluera_monthly_100h_v2');
});
const syntheticAccount={userId:'00000000-0000-4000-8000-000000000801',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
it('a restored verified session offers the remembered plan but never automatically navigates or starts checkout',async()=>{
 resolveCheckoutSelection('?offer=cluera_monthly_40h_v2',sessionStorage);
 const request=vi.fn(async()=>Response.json({account:syntheticAccount,passwordRecovery:false}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));
 const link=host.querySelector<HTMLAnchorElement>('a[href*="checkout"]')!;
 expect(link.textContent).toBe('Continue to selected plan');expect(link.getAttribute('href')).toBe('/account/checkout?offer=cluera_monthly_40h_v2');
 expect(location.pathname).toBe('/account');expect(request).toHaveBeenCalledOnce();expect(host.querySelector('script')).toBeNull();
});
it('password recovery cannot expose the plan continuation and logout clears both selection storage and query',async()=>{
 history.replaceState(null,'','/account?offer=cluera_pack_3h_v2');
 const request=vi.fn(async(_url:unknown,init?:RequestInit)=>init?.method==='POST'?Response.json({ok:true}):Response.json({account:syntheticAccount,passwordRecovery:true}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.querySelector('a[href*="checkout"]')).toBeNull();
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Sign out of this browser')!.click());
 expect(sessionStorage.getItem('cluera.checkout-selection.v1')).toBeNull();expect(location.search).toBe('');expect(host.textContent).not.toContain('Selected plan');
});
