// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {emailNotice} from '../lib/accounts/publicAuth';
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account');vi.stubGlobal('fetch',vi.fn(async()=>Response.json({},{status:401})));});
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
