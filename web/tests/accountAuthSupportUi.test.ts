// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {authFailure,emailNotice} from '../lib/accounts/publicAuth';
vi.mock('../app/account/AccountWorkspace',()=>({AccountWorkspace:()=>createElement('p',{},'Synthetic workspace')}));
const account={userId:'00000000-0000-4000-8000-000000000801',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
let host:HTMLDivElement,root:Root;
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(node=>node.textContent===text)!;
const render=async(hash='')=>{history.replaceState(null,'',`/account${hash}`);await act(async()=>root.render(createElement(AccountPanel)));};
const submit=async()=>{await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));};
const email=()=>{(host.querySelector('input[name="email"]')as HTMLInputElement).value='fixture@example.invalid';};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);history.replaceState(null,'','/account');sessionStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
function fixture(post:(url:string,init:RequestInit)=>Promise<Response>=async()=>Response.json({message:emailNotice})){
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>url==='/api/account/auth-options'?Response.json({google:'disabled'}):init?.method==='POST'?post(url,init):Response.json({},{status:401}));vi.stubGlobal('fetch',fetcher);return fetcher;
}
it('forgot-password requests are email-only, qualified and cooled down without automatic or duplicate sends',async()=>{
 vi.useFakeTimers();const fetcher=fixture();await render('#forgot-password');email();await submit();
 const posts=()=>fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts()).toHaveLength(1);expect(posts()[0][0]).toBe('/api/account/forgot-password');expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({email:'fixture@example.invalid'});
 expect(host.querySelector('input[name="password"]')).toBeNull();expect(host.textContent).toContain('latest reset link in this browser');expect(host.textContent).toContain('does not confirm whether an account exists');
 expect(host.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(true);await submit();expect(posts()).toHaveLength(1);
 await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(posts()).toHaveLength(1);expect(host.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(false);await submit();expect(posts()).toHaveLength(2);
});
it('forgot-password rate limits retain a shared mail cooldown across form navigation while login remains available',async()=>{
 vi.useFakeTimers();const fetcher=fixture(async()=>Response.json({error:'private-upstream'},{status:429}));await render('#forgot-password');email();await submit();
 await act(async()=>button('Back to sign in').click());expect(host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(false);
 await act(async()=>button('Resend verification').click());expect(host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(true);
 expect(host.textContent).not.toContain('private-upstream');expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('an unknown recovery email outcome starts a deliberate wait and a late success cannot overwrite the timeout',async()=>{
 vi.useFakeTimers();let finish!:(response:Response)=>void;const fetcher=fixture(()=>new Promise(resolve=>{finish=resolve;}));await render('#forgot-password');email();await submit();await act(async()=>vi.advanceTimersByTimeAsync(15001));
 expect(host.textContent).toContain('Connection failed or timed out');expect(host.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(true);
 await act(async()=>finish(Response.json({message:emailNotice})));expect(host.textContent).toContain('Connection failed or timed out');expect(host.textContent).not.toContain('Submitted email');
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it.each(['forgot-password','resend-verification'])('email-only %s validation explains the email rather than absent password fields',action=>{
 expect(authFailure(400,action)).toContain('email address');expect(authFailure(400,action)).not.toContain('password');
});
it('wrong-password sign-in gives neutral actionable help without echoing provider details',async()=>{
 fixture(async()=>Response.json({error:'private-upstream-user-exists'},{status:401}));await render();email();(host.querySelector('input[name="password"]')as HTMLInputElement).value='fixture-password';await submit();
 expect(host.querySelector('#account-auth-feedback')?.textContent).toContain('Check your email and password');expect(host.querySelector('#account-auth-feedback')?.textContent).toContain('Resend verification');expect(host.textContent).not.toContain('private-upstream-user-exists');
});
it('explicit status check preserves the typed email and reads no mail, password or provider endpoint',async()=>{
 const fetcher=fixture();await render('#forgot-password');email();await act(async()=>button('Check sign-in status').click());
 expect(host.textContent).toContain('You are signed out.');expect((host.querySelector('input[name="email"]')as HTMLInputElement).value).toBe('fixture@example.invalid');
 expect(fetcher.mock.calls.filter(([url])=>url==='/api/account/session')).toHaveLength(2);expect(fetcher.mock.calls.every(([,init])=>!init?.method)).toBe(true);
});
it('a login confirmed by POST but not its session can be checked explicitly without repeating credentials',async()=>{
 let reads=0;const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.startsWith('/api/account/password-security?'))return Response.json({accountId:account.userId,passwordRecovery:false,recoveryExpired:false,needsMfa:false,factors:[]});
  if(url==='/api/account/auth-options')return Response.json({google:'disabled'});if(init?.method==='POST')return Response.json({account});
  reads++;return reads<3?Response.json({},{status:reads===1?401:503}):Response.json({account,passwordRecovery:false});
 });vi.stubGlobal('fetch',fetcher);await render();email();(host.querySelector('input[name="password"]')as HTMLInputElement).value='fixture-password';await submit();
 expect(host.textContent).toContain('Account service is unavailable.');await act(async()=>button('Check sign-in status').click());
 expect(host.textContent).toContain('Signed in as');expect(host.textContent).toContain('Your current sign-in is verified.');expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('checking an already verified recovery session retains its reset-only view and completes feedback',async()=>{
 const fetcher=vi.fn(async(url:string,_init?:RequestInit)=>url==='/api/account/auth-options'?Response.json({google:'disabled'}):url.startsWith('/api/account/password-security?')
  ?Response.json({accountId:account.userId,passwordRecovery:true,recoveryExpired:false,needsMfa:false,factors:[]}):Response.json({account,passwordRecovery:true}));vi.stubGlobal('fetch',fetcher);await render('#reset-password');await act(async()=>button('Check sign-in status').click());
 expect(host.textContent).toContain('Password-recovery session verified.');expect(host.textContent).toContain('Choose a new password');expect(host.textContent).not.toContain('Synthetic workspace');expect(fetcher.mock.calls.every(([url,init])=>['/api/account/session','/api/account/auth-options',`/api/account/password-security?expectedAccountId=${account.userId}`].includes(url)&&(!init?.method||init.method==='GET'))).toBe(true);
});
it('expired recovery rejection explains the explicit recovery exit without signing out, updating twice or sending another email',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>url==='/api/account/auth-options'?Response.json({google:'disabled'}):url.startsWith('/api/account/password-security?')
  ?Response.json({accountId:account.userId,passwordRecovery:true,recoveryExpired:false,needsMfa:false,factors:[]}):init?.method==='POST'
  ?Response.json({code:'RECOVERY_SESSION_REQUIRED',error:'private-expired-recovery-details'},{status:403}):Response.json({account,passwordRecovery:true}));vi.stubGlobal('fetch',fetcher);await render('#reset-password');
 (host.querySelector('input[name="password"]')as HTMLInputElement).value='fixture-new-password';await submit();
 expect(host.querySelector('#account-auth-feedback')?.textContent).toContain('latest password-reset email');expect(host.textContent).toContain('sign out of this browser and explicitly request a new password-reset email');
 expect(host.textContent).not.toContain('private-expired-recovery-details');expect(host.textContent).not.toContain('Synthetic workspace');expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/reset-password']);
});
it('the read-only status control cannot bypass a pending sign-in write',async()=>{
 let finish!:(response:Response)=>void;const fetcher=fixture(()=>new Promise(resolve=>{finish=resolve;}));await render();email();(host.querySelector('input[name="password"]')as HTMLInputElement).value='fixture-password';await submit();
 const checks=fetcher.mock.calls.filter(([url])=>url==='/api/account/session').length,check=button('Check sign-in status');expect(check.disabled).toBe(true);await act(async()=>check.click());expect(fetcher.mock.calls.filter(([url])=>url==='/api/account/session')).toHaveLength(checks);
 await act(async()=>finish(Response.json({error:'private-rejection'},{status:401})));expect(button('Check sign-in status').disabled).toBe(false);
});
it('support contact carries no account/query/secret data and opening help sends no requests',async()=>{
 const fetcher=fixture();await render('#signup');const count=fetcher.mock.calls.length,help=host.querySelector('aside[aria-label="Account access help"]')!;
 expect(help.querySelector('a')?.getAttribute('href')).toBe('mailto:clueraaisupport@gmail.com');expect(help.textContent).toContain('Never send passwords, verification codes, email links');
 await act(async()=>{help.querySelector('details')!.open=true;});expect(fetcher).toHaveBeenCalledTimes(count);expect(help.textContent).toContain('same browser');
});
it('a timed-out explicit session read unlocks the form and cannot overwrite a later form result',async()=>{
 vi.useFakeTimers();let reads=0,finish!:(response:Response)=>void;const fetcher=fixture();const original=fetcher.getMockImplementation()!;
 fetcher.mockImplementation(async(url,init)=>{if(url==='/api/account/session'&&++reads===2)return new Promise(resolve=>{finish=resolve;});return original(url,init);});
 await render('#signup');await act(async()=>button('Check sign-in status').click());expect(host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(true);
 await act(async()=>vi.advanceTimersByTimeAsync(15001));expect(host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(false);email();(host.querySelector('input[name="password"]')as HTMLInputElement).value='fixture-password';await submit();
 await act(async()=>finish(Response.json({account,passwordRecovery:false})));expect(host.textContent).toContain('Verification email sent!');expect(host.textContent).not.toContain('Signed in as');
});
