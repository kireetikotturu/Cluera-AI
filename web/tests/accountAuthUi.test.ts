// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {emailNotice,resendNotice} from '../lib/accounts/publicAuth';
import {resolveCheckoutSelection} from '../lib/cluera/checkoutJourney';
import {replaceAccountLocation} from '../lib/accounts/browserNavigation';
vi.mock('../lib/accounts/browserNavigation',async original=>({...await original<typeof import('../lib/accounts/browserNavigation')>(),replaceAccountLocation:vi.fn()}));
vi.mock('../app/account/AccountWorkspace',()=>({AccountWorkspace:()=>createElement('p',{},'Synthetic account workspace')}));
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.mocked(replaceAccountLocation).mockClear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);sessionStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account');vi.stubGlobal('fetch',vi.fn(async()=>Response.json({},{status:401})));});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
const requestedSignupNotice='Verification email sent! Please check your inbox and click the verification link to activate your Cluera AI account.';
function fillSignup(email='synthetic@example.invalid',password='12345678'){
 (host.querySelector('input[name="email"]') as HTMLInputElement).value=email;
 (host.querySelector('input[name="password"]') as HTMLInputElement).value=password;
}
async function sendForm(){await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});}
it.each([['#signup','Create an account'],['#forgot-password','Reset your password'],['#unknown','Sign in']])('honors only allowlisted non-secret browser handoff %s',async(hash,title)=>{
 history.replaceState(null,'',`/account${hash}`);await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.querySelector('h2')?.textContent).toBe(title);expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('preserves signup password policy, shows password accessibly and submits only once',async()=>{
 history.replaceState(null,'','/account#signup');const fetcher=vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401}));vi.stubGlobal('fetch',fetcher);
 await act(async()=>root.render(createElement(AccountPanel)));
 const password=host.querySelector('input[name="password"]') as HTMLInputElement;expect(password.minLength).toBe(8);expect(password.maxLength).toBe(128);
 await act(async()=>(host.querySelector('[aria-label="Show password"]') as HTMLButtonElement).click());expect(password.type).toBe('text');
 (host.querySelector('input[name="email"]') as HTMLInputElement).value='synthetic@example.invalid';password.value='synthetic-password';
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(posts[0][1]?.signal).toBeInstanceOf(AbortSignal);expect(password.value).toBe('');expect(host.textContent).toContain(requestedSignupNotice);
});
it('keeps qualified signup success beside the form, masks the submitted address and retains feedback after clearing the password',async()=>{
 history.replaceState(null,'','/account#signup');
 vi.stubGlobal('fetch',vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401})));
 await act(async()=>root.render(createElement(AccountPanel)));
 const region=host.querySelector<HTMLElement>('#account-auth-feedback');expect(region).not.toBeNull();
 expect(region!.getAttribute('aria-live')).toBe('polite');expect(region!.getAttribute('aria-atomic')).toBe('true');
 fillSignup('synthetic@example.invalid');await sendForm();
 expect(region!.textContent).toContain(requestedSignupNotice);expect(region!.textContent).toMatch(/eligible/i);
 expect(region!.textContent).toMatch(/does not confirm.*account/i);expect(region!.textContent).toContain('s***@example.invalid');
 expect(region!.textContent).not.toContain('synthetic@example.invalid');
 expect(host.querySelector('form')!.nextElementSibling).toBe(region);
 expect(document.activeElement).toBe(region);expect((host.querySelector('input[name="password"]') as HTMLInputElement).value).toBe('');
 (host.querySelector('input[name="email"]') as HTMLInputElement).value='other@example.invalid';
 await act(async()=>window.dispatchEvent(new Event('resize')));expect(region!.textContent).toContain('s***@example.invalid');
 expect(region!.classList.contains('account-auth-feedback')).toBe(true);expect(region!.classList.contains('account-auth-feedback-success')).toBe(true);
});
it('never treats malformed or extra-field success responses as proof that a verification email was sent',async()=>{
 history.replaceState(null,'','/account#signup');vi.stubGlobal('fetch',vi.fn(async(_url:any,init?:RequestInit)=>
  init?.method==='POST'?Response.json({message:emailNotice,token:'PRIVATE_UPSTREAM_DETAILS'}):Response.json({},{status:401})));
 await act(async()=>root.render(createElement(AccountPanel)));fillSignup();await sendForm();
 expect(host.textContent).not.toContain(requestedSignupNotice);expect(host.textContent).not.toContain('PRIVATE_UPSTREAM_DETAILS');
 expect(host.querySelector('#account-auth-feedback')?.textContent).toMatch(/failed|unavailable|timed out/i);
});
it.each([400,401,403,429,503])('shows a persistent safe inline error for rejected signup HTTP%s and does not reflect upstream text',async status=>{
 history.replaceState(null,'','/account#signup');vi.stubGlobal('fetch',vi.fn(async(_url:any,init?:RequestInit)=>
  init?.method==='POST'?Response.json({error:'PRIVATE_UPSTREAM_DETAILS'},{status}):Response.json({},{status:401})));
 await act(async()=>root.render(createElement(AccountPanel)));fillSignup();await sendForm();
 const feedback=host.querySelector<HTMLElement>('#account-auth-feedback')!;expect(feedback).not.toBeNull();
 expect(feedback.classList.contains('account-auth-feedback-error')).toBe(true);expect(feedback.textContent).toBeTruthy();
 expect(host.textContent).not.toContain('PRIVATE_UPSTREAM_DETAILS');expect(host.textContent).not.toContain(requestedSignupNotice);
 expect((host.querySelector('input[name="password"]') as HTMLInputElement).value).toBe('');
});
it('holds a second signup while pending and shows loading without storing a password in feedback',async()=>{
 history.replaceState(null,'','/account#signup');let finish!:(value:Response)=>void;
 const request=vi.fn((_url:any,init?:RequestInit)=>init?.method==='POST'?new Promise<Response>(resolve=>{finish=resolve;}):Promise.resolve(Response.json({},{status:401})));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));fillSignup('synthetic@example.invalid','private-password-fixture');await sendForm();
 expect(host.textContent).toMatch(/Sending verification email/i);expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
 expect((host.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
 expect(host.textContent).not.toContain('private-password-fixture');await sendForm();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 await act(async()=>finish(Response.json({message:emailNotice})));expect(host.textContent).toContain(requestedSignupNotice);
});
it.each(['reject','401'])('does not let a late initial-session %s erase later signup feedback',async outcome=>{
 vi.useFakeTimers();history.replaceState(null,'','/account#signup');let finish!:(value:Response)=>void,reject!:(reason:Error)=>void;
 vi.stubGlobal('fetch',vi.fn((_url:any,init?:RequestInit)=>_url==='/api/account/auth-options'?Promise.resolve(Response.json({google:'disabled'})):init?.method==='POST'?Promise.resolve(Response.json({message:emailNotice})):
  new Promise<Response>((resolve,fail)=>{finish=resolve;reject=fail;})));
 await act(async()=>root.render(createElement(AccountPanel)));await act(async()=>{await vi.advanceTimersByTimeAsync(15001);});
 fillSignup();await sendForm();expect(host.textContent).toContain(requestedSignupNotice);
 await act(async()=>{if(outcome==='reject')reject(new Error('PRIVATE_UPSTREAM_DETAILS'));else finish(Response.json({},{status:401}));});
 expect(host.textContent).toContain(requestedSignupNotice);expect(host.textContent).not.toContain('Account service is unavailable.');
});
it('requires an explicit resend click after a sixty-second cooldown, without automatic requests or signup repetition',async()=>{
 vi.useFakeTimers();history.replaceState(null,'','/account#signup');const request=vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));fillSignup();await sendForm();
 const resend=host.querySelector<HTMLButtonElement>('[data-resend-verification]')!;expect(resend).not.toBeNull();expect(resend.disabled).toBe(true);expect(resend.textContent).toContain('60');
 await act(async()=>{resend.click();await vi.advanceTimersByTimeAsync(59000);});expect(resend.disabled).toBe(true);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(resend.disabled).toBe(false);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 await act(async()=>resend.click());const posts=request.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(2);
 expect(posts[1][0]).toBe('/api/account/resend-verification');expect(JSON.parse(posts[1][1]?.body as string)).toEqual({email:'synthetic@example.invalid'});
 expect(resend.disabled).toBe(true);
});
it('applies the resend cooldown after rate limiting, including mode changes, without weakening server errors',async()=>{
 vi.useFakeTimers();history.replaceState(null,'','/account#resend-verification');const request=vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({error:'raw upstream'},{status:429}):Response.json({},{status:401}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));(host.querySelector('input[name="email"]') as HTMLInputElement).value='synthetic@example.invalid';await sendForm();
 const button=host.querySelector<HTMLButtonElement>('form button[type="submit"]')!;expect(button.disabled).toBe(true);expect(host.textContent).toMatch(/too many|wait/i);
 await sendForm();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 await act(async()=>{Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Create account')!.click();});
 await act(async()=>{Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Resend verification')!.click();});
 expect((host.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect((host.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('uses the same eight-to128-character frontend policy for reset passwords',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({account:syntheticAccount,passwordRecovery:true})));
 await act(async()=>root.render(createElement(AccountPanel)));const password=host.querySelector<HTMLInputElement>('input[name="password"]')!;
 expect(password.minLength).toBe(8);expect(password.maxLength).toBe(128);
});
it('updates an existing browser page for a new handoff and clears the previous password',async()=>{
 await act(async()=>root.render(createElement(AccountPanel)));
 (host.querySelector('input[name="password"]') as HTMLInputElement).value='synthetic-old-password';
 await act(async()=>{history.replaceState(null,'','/account#signup');window.dispatchEvent(new HashChangeEvent('hashchange'));});
 expect(host.querySelector('h2')?.textContent).toBe('Create an account');expect((host.querySelector('input[name="password"]') as HTMLInputElement).value).toBe('');
 await act(async()=>{history.replaceState(null,'','/account#forgot-password');window.dispatchEvent(new HashChangeEvent('hashchange'));});
 expect(host.querySelector('h2')?.textContent).toBe('Reset your password');expect(host.querySelector('input[name="password"]')).toBeNull();expect(vi.mocked(fetch).mock.calls.filter(([url])=>url==='/api/account/session')).toHaveLength(1);
});
it('clears a remembered resend recipient on mode navigation without bypassing its backoff',async()=>{
 history.replaceState(null,'','/account#signup');
 const request=vi.fn(async(_url:any,init?:RequestInit)=>init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));
 (host.querySelector('input[name="email"]') as HTMLInputElement).value='fixture@example.invalid';(host.querySelector('input[name="password"]') as HTMLInputElement).value='Synthetic-password';
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.querySelector('[data-resend-verification]')).not.toBeNull();
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Back to sign in')!.click());
 expect(host.querySelector('[data-resend-verification]')).toBeNull();
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Create account')!.click());
 expect((host.querySelector('form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
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
 await act(async()=>root.render(createElement(AccountPanel)));expect(host.querySelector('h2')?.textContent).toBe('Resend verification');expect(host.querySelector('input[name="password"]')).toBeNull();expect(fetcher.mock.calls.filter(([url])=>url==='/api/account/session')).toHaveLength(1);
 (host.querySelector('input[name="email"]') as HTMLInputElement).value='fixture@example.invalid';await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 const post=fetcher.mock.calls.find(([,init])=>init?.method==='POST')!;expect(post[0]).toBe('/api/account/resend-verification');expect(JSON.parse(post[1]!.body as string)).toEqual({email:'fixture@example.invalid'});expect(host.textContent).toContain(resendNotice);
});
it('retains the selected plan through signup and email/Google return without requesting payment',async()=>{
 history.replaceState(null,'','/account?offer=cluera_monthly_100h_v2#signup');
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.textContent).toContain('Selected plan: Cluera Pro 100 Hours');
 expect(sessionStorage.getItem('cluera.checkout-selection.v1')).toContain('cluera_monthly_100h_v2');
 expect(vi.mocked(fetch).mock.calls.every(([url,init])=>['/api/account/session','/api/account/auth-options'].includes(String(url))&&!init?.method)).toBe(true);
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Back to sign in')!.click());
 expect(location.search).toBe('?offer=cluera_monthly_100h_v2');
});
const syntheticAccount={userId:'00000000-0000-4000-8000-000000000801',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
it('a restored verified session returns only to the remembered plan without starting a purchase',async()=>{
 resolveCheckoutSelection('?offer=cluera_monthly_40h_v2',sessionStorage);
 const request=vi.fn(async(url:unknown)=>String(url).startsWith('/api/account/password-security?')?Response.json({accountId:syntheticAccount.userId,passwordRecovery:false,recoveryExpired:false,needsMfa:false,factors:[]}):Response.json({account:syntheticAccount,passwordRecovery:false}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(replaceAccountLocation).toHaveBeenCalledExactlyOnceWith('/account/checkout?offer=cluera_monthly_40h_v2');
 expect(sessionStorage.getItem('cluera.checkout-selection.v1')).toBeNull();expect(request.mock.calls.every(([url,init])=>['/api/account/session','/api/account/auth-options',`/api/account/password-security?expectedAccountId=${syntheticAccount.userId}`].includes(String(url))&&(!init?.method||init.method==='GET'))).toBe(true);expect(host.querySelector('script')).toBeNull();
});
it('password recovery cannot expose the plan continuation and logout clears both selection storage and query',async()=>{
 history.replaceState(null,'','/account?offer=cluera_pack_3h_v2');
 const request=vi.fn(async(_url:unknown,init?:RequestInit)=>String(_url).startsWith('/api/account/password-security?')?Response.json({accountId:syntheticAccount.userId,passwordRecovery:true,recoveryExpired:false,needsMfa:false,factors:[]})
  :init?.method==='POST'?Response.json({ok:true}):Response.json({account:syntheticAccount,passwordRecovery:true}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(AccountPanel)));
 expect(host.querySelector('a[href*="checkout"]')).toBeNull();
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Sign out of this browser')!.click());
 expect(sessionStorage.getItem('cluera.checkout-selection.v1')).toBeNull();expect(location.search).toBe('');expect(host.textContent).not.toContain('Selected plan');
});
