// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {emailNotice,resendNotice} from '../lib/accounts/publicAuth';
vi.mock('../app/account/AccountWorkspace',()=>({AccountWorkspace:()=>createElement('p',{},'Synthetic workspace')}));
vi.mock('../app/account/AdminRoleNavigation',()=>({ACCOUNT_SESSION_STORAGE_KEY:'cluera-account-session-change-v1',notifyAccountSessionChanged:vi.fn()}));
const first={userId:'00000000-0000-4000-8000-000000000801',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
const second={...first,userId:'00000000-0000-4000-8000-000000000802',email:'other@example.invalid'};
const factor='00000000-0000-4000-8000-000000000901';let host:HTMLDivElement,root:Root;
const security=(needsMfa=false,recoveryExpired=false,account=first)=>({accountId:account.userId,passwordRecovery:true,recoveryExpired,needsMfa,factors:needsMfa?[{id:factor,type:'totp'}]:[]});
const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(value=>value.textContent===name)!;
const resetForm=()=>button('Update password and sign out').closest('form')!;
const submit=async(form:HTMLFormElement)=>{await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));};
const render=async()=>{await act(async()=>root.render(createElement(AccountPanel)));};
function fixture(handler?:(url:string,init?:RequestInit)=>Promise<Response>|Response){const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
 if(url==='/api/account/auth-options')return Response.json({google:'disabled'});
 if(handler){const value=await handler(url,init);if(value)return value;}
 return url.startsWith('/api/account/password-security?')?Response.json(security()):Response.json({account:first,passwordRecovery:true});
 });vi.stubGlobal('fetch',fetcher);return fetcher;}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);history.replaceState(null,'','/account#reset-password');sessionStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it('reset is blocked until the exact owner/recovery security preflight succeeds, with no automatic mutation',async()=>{
 let finish!:(response:Response)=>void;const fetcher=fixture((url)=>url.startsWith('/api/account/password-security?')?new Promise(resolve=>{finish=resolve;}):undefined as never);await render();
 expect(button('Update password and sign out').disabled).toBe(true);expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
 await act(async()=>finish(Response.json(security())));expect(button('Update password and sign out').disabled).toBe(false);
 expect(fetcher.mock.calls.find(([url])=>url.startsWith('/api/account/password-security?'))?.[0]).toBe(`/api/account/password-security?expectedAccountId=${first.userId}`);
});
it('existing TOTP is verified explicitly, then a fresh security read permits a separate password submit without replay',async()=>{
 let elevated=false;const fetcher=fixture((url,init)=>{
  if(url.startsWith('/api/account/password-security?'))return Response.json(security(!elevated));
  if(url==='/api/account/password-mfa'){elevated=true;return Response.json({ok:true});}
  if(url==='/api/account/reset-password')return Response.json({ok:true,sessionsRevoked:true,message:'Password updated. Sign in again.'});return undefined as never;
 });await render();expect(button('Update password and sign out').disabled).toBe(true);expect(host.textContent).toContain('code from your authenticator app');
 const form=host.querySelector<HTMLFormElement>('form[aria-label="Verify password authenticator"]')!;(form.elements.namedItem('code')as HTMLInputElement).value='123456';await submit(form);
 expect((form.elements.namedItem('code')as HTMLInputElement).value).toBe('');expect(button('Update password and sign out').disabled).toBe(false);expect(host.textContent).toContain('Choose your new password');
 const firstPosts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(firstPosts.map(([url])=>url)).toEqual(['/api/account/password-mfa']);expect(JSON.parse(firstPosts[0][1]!.body as string)).toEqual({expectedAccountId:first.userId,factorId:factor,code:'123456'});
 (resetForm().elements.namedItem('password')as HTMLInputElement).value='fixture-new-password';await submit(resetForm());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts.map(([url])=>url)).toEqual(['/api/account/password-mfa','/api/account/reset-password']);expect(JSON.parse(posts[1][1]!.body as string)).toEqual({expectedAccountId:first.userId,password:'fixture-new-password'});expect(host.textContent).toContain('Password updated. Sign in again.');
});
it('invalid authenticator code retains recovery, clears the code and never sends a password/email or removes a factor',async()=>{
 const fetcher=fixture((url)=>url.startsWith('/api/account/password-security?')?Response.json(security(true)):url==='/api/account/password-mfa'?Response.json({code:'MFA_CODE_INVALID',error:'private-factor-details'},{status:400}):undefined as never);await render();
 const form=host.querySelector<HTMLFormElement>('form[aria-label="Verify password authenticator"]')!;(form.elements.namedItem('code')as HTMLInputElement).value='123456';await submit(form);
 expect(host.textContent).toContain('current six-digit code from your authenticator app');expect(host.textContent).not.toContain('private-factor-details');expect(host.textContent).not.toContain('Synthetic workspace');expect(button('Update password and sign out').disabled).toBe(true);
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/password-mfa']);
});
it('authenticator verification is single-flight and blocks an independently dispatched password or logout while pending',async()=>{
 let finish!:(response:Response)=>void;const fetcher=fixture((url)=>url.startsWith('/api/account/password-security?')?Response.json(security(true)):url==='/api/account/password-mfa'?new Promise(resolve=>{finish=resolve;}):undefined as never);await render();
 const form=host.querySelector<HTMLFormElement>('form[aria-label="Verify password authenticator"]')!;(form.elements.namedItem('code')as HTMLInputElement).value='123456';await submit(form);await submit(form);await submit(resetForm());await act(async()=>button('Sign out of this browser').click());
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);await act(async()=>finish(Response.json({code:'MFA_CODE_INVALID',error:'fixed'},{status:400})));expect(button('Verify authenticator').matches(':disabled')).toBe(false);
});
it('a later insufficient-AAL password rejection opens the authenticator prompt without logout or password replay',async()=>{
 let required=false;const fetcher=fixture((url)=>{
  if(url.startsWith('/api/account/password-security?'))return Response.json(security(required));
  if(url==='/api/account/reset-password'){required=true;return Response.json({code:'MFA_REQUIRED',error:'fixed'},{status:403});}return undefined as never;
 });await render();(resetForm().elements.namedItem('password')as HTMLInputElement).value='fixture-new-password';await submit(resetForm());
 expect(host.querySelector('form[aria-label="Verify password authenticator"]')).not.toBeNull();expect(host.textContent).toContain('Verify your existing authenticator below');expect(button('Update password and sign out').disabled).toBe(true);expect(host.textContent).not.toContain('Synthetic workspace');
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/reset-password']);
});
it('expired recovery requires an explicit local sign-out/restart and never sends another email automatically',async()=>{
 const fetcher=fixture((url)=>url.startsWith('/api/account/password-security?')?Response.json(security(false,true)):url==='/api/account/logout'?Response.json({ok:true}):undefined as never);await render();
 expect(host.textContent).toContain('reset link has expired');expect(host.querySelector('input[name="password"]')).toBeNull();expect(host.textContent).not.toContain('security are verified');expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
 await act(async()=>button('Sign out and restart recovery').click());expect(host.querySelector('h2')?.textContent).toBe('Reset your password');expect(host.querySelector('input[name="email"]')).not.toBeNull();expect(location.hash).toBe('#forgot-password');
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/logout']);
});
it('recovery expiring during authenticator entry re-reads security and hides stale password/MFA forms without replay',async()=>{
 let expired=false;const fetcher=fixture((url)=>{
  if(url.startsWith('/api/account/password-security?'))return Response.json(security(!expired,expired));
  if(url==='/api/account/password-mfa'){expired=true;return Response.json({code:'RECOVERY_SESSION_REQUIRED',error:'fixed'},{status:403});}return undefined as never;
 });await render();const form=host.querySelector<HTMLFormElement>('form[aria-label="Verify password authenticator"]')!;(form.elements.namedItem('code')as HTMLInputElement).value='123456';await submit(form);
 expect(host.textContent).toContain('reset link has expired');expect(host.querySelector('input[name="password"]')).toBeNull();expect(host.querySelector('form[aria-label="Verify password authenticator"]')).toBeNull();expect(button('Sign out and restart recovery')).toBeTruthy();
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/password-mfa']);
});
it.each([[401,'AUTHENTICATION_REQUIRED'],[401,undefined],[503,'PASSWORD_UPDATE_UNCERTAIN']]as const)('reset HTTP%i %s does not claim a password changed or sign out automatically',async(status,code)=>{
 const fetcher=fixture((url)=>url==='/api/account/reset-password'?Response.json({...(code?{code}:{}),error:'private-password-details'},{status}):undefined as never);await render();
 (resetForm().elements.namedItem('password')as HTMLInputElement).value='fixture-new-password';await submit(resetForm());const feedback=host.querySelector('#account-auth-feedback')!.textContent!;
 expect(feedback).not.toContain('Password updated.');expect(feedback).not.toContain('private-password-details');expect(feedback).toMatch(status===401?/no longer valid/:/unconfirmed/);
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/reset-password']);
});
it.each(['owner','recovery','private','missing-factors'])('malformed or mismatched %s security state cannot authorize a password update',async(kind)=>{
 const value:any=security();if(kind==='owner')value.accountId=second.userId;if(kind==='recovery')value.passwordRecovery=false;if(kind==='private')value.accessToken='private-token';if(kind==='missing-factors')value.needsMfa=true;
 const fetcher=fixture(url=>url.startsWith('/api/account/password-security?')?Response.json(value):undefined as never);await render();expect(button('Update password and sign out').disabled).toBe(true);expect(host.textContent).not.toContain('private-token');expect(host.textContent).not.toContain('Synthetic workspace');
 await submit(resetForm());expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('a late MFA result from an old owner cannot change a newer account view or submit a password',async()=>{
 let account=first,finish!:(response:Response)=>void;const fetcher=fixture((url)=>{
  if(url==='/api/account/session')return Response.json({account,passwordRecovery:true});if(url.startsWith('/api/account/password-security?'))return Response.json(security(true,false,account));
  if(url==='/api/account/password-mfa')return new Promise(resolve=>{finish=resolve;});return undefined as never;
 });await render();const form=host.querySelector<HTMLFormElement>('form[aria-label="Verify password authenticator"]')!;(form.elements.namedItem('code')as HTMLInputElement).value='123456';await submit(form);account=second;
 await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:'cluera-account-session-change-v1',newValue:'opaque'})));await act(async()=>finish(Response.json({ok:true})));expect(host.textContent).toContain(second.email);expect(host.textContent).not.toContain('Authenticator verified.');
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/password-mfa']);
});
it('a hung security stream is bounded and leaves password update locked without an email or write',async()=>{
 vi.useFakeTimers();const fetcher=fixture(url=>url.startsWith('/api/account/password-security?')?new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}),{headers:{'content-type':'application/json'}}):undefined as never);await render();await act(async()=>vi.advanceTimersByTimeAsync(10001));
 expect(host.textContent).toContain('Password security is unavailable');expect(button('Update password and sign out').disabled).toBe(true);expect(button('Check password security').disabled).toBe(false);expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('resend receipt is neutral info and points verified users to sign-in/reset without an account lookup or promised delivery',async()=>{
 history.replaceState(null,'','/account#resend-verification');const fetcher=vi.fn(async(url:string,init?:RequestInit)=>url==='/api/account/auth-options'?Response.json({google:'disabled'}):init?.method==='POST'?Response.json({message:emailNotice}):Response.json({},{status:401}));vi.stubGlobal('fetch',fetcher);await render();
 (host.querySelector('input[name="email"]')as HTMLInputElement).value=first.email;await submit(host.querySelector('form')!);const feedback=host.querySelector('#account-auth-feedback')!;
 expect(feedback.textContent).toContain(resendNotice);expect(feedback.className).toContain('account-auth-feedback-success');expect(feedback.textContent).toContain('If your signup needs verification');expect(feedback.textContent).not.toContain('Verification email sent!');expect(button('Back to sign in')).toBeTruthy();expect(host.querySelector('form')).toBeNull();
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([url])=>url)).toEqual(['/api/account/resend-verification']);
});
it.each(['forgot-password','resend-verification'])('%s offers email recovery/resend without an unrelated Google action',async(mode)=>{
 history.replaceState(null,'',`/account#${mode}`);const fetcher=vi.fn(async(url:string)=>url==='/api/account/auth-options'?Response.json({google:'enabled'}):Response.json({},{status:401}));vi.stubGlobal('fetch',fetcher);await render();
 expect(host.querySelector('#account-google-status')).toBeNull();expect(Array.from(host.querySelectorAll('button')).some(value=>value.textContent==='Continue with Google')).toBe(false);expect(button('Back to sign in')).toBeTruthy();expect(fetcher.mock.calls.every(([,init])=>!(init as RequestInit|undefined)?.method)).toBe(true);
});
