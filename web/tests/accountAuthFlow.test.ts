// @vitest-environment jsdom
import {act,createElement,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {replaceAccountLocation,selectedPlanReturn} from '../lib/accounts/browserNavigation';
import {emailNotice} from '../lib/accounts/publicAuth';
vi.mock('../app/account/AccountWorkspace',()=>({AccountWorkspace:()=>createElement('p',{},'Synthetic current account workspace')}));
vi.mock('../app/account/AdminRoleNavigation',()=>({ACCOUNT_SESSION_STORAGE_KEY:'cluera-account-session-change-v1',notifyAccountSessionChanged:vi.fn()}));
vi.mock('../lib/accounts/browserNavigation',async original=>({...await original<typeof import('../lib/accounts/browserNavigation')>(),replaceAccountLocation:vi.fn()}));
const first={userId:'00000000-0000-4000-8000-000000000801',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
const second={...first,userId:'00000000-0000-4000-8000-000000000802',email:'other@example.invalid'};
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);sessionStorage.clear();vi.mocked(replaceAccountLocation).mockClear();history.replaceState(null,'','/account');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
function fixture(handler:(url:string,init?:RequestInit)=>Promise<Response>|Response,google='disabled',passwordRecovery=false){
 const request=vi.fn(async(url:unknown,init?:RequestInit)=>String(url)==='/api/account/auth-options'?Response.json({google}):String(url).startsWith('/api/account/password-security?')
  ?Response.json({accountId:new URL(String(url),'http://localhost').searchParams.get('expectedAccountId'),passwordRecovery,recoveryExpired:false,needsMfa:false,factors:[]}):handler(String(url),init));vi.stubGlobal('fetch',request);return request;
}
const session=(account=first,passwordRecovery=false)=>Response.json({account,passwordRecovery});
async function render(){await act(async()=>root.render(createElement(AccountPanel)));}
async function submit(form:HTMLFormElement){await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
function securityForm(){return host.querySelector<HTMLFormElement>('form[aria-label="Change password"]')!;}
function loginFields(){(host.querySelector('input[name="email"]') as HTMLInputElement).value=first.email;(host.querySelector('input[name="password"]') as HTMLInputElement).value='synthetic-passphrase';}
it('ordinary verified session opens workspace rather than recovery and security is optional',async()=>{
 fixture(()=>session());await render();expect(host.textContent).toContain('Synthetic current account workspace');expect(host.querySelector('h2')?.textContent).toBe('Your workspace');expect(host.querySelector('details')?.open).toBe(false);
});
it('recovery never exposes workspace or selected purchase continuation',async()=>{
 history.replaceState(null,'','/account?offer=cluera_pack_3h_v2');fixture(()=>session(first,true),'disabled',true);await render();expect(host.textContent).toContain('Choose a new password');expect(securityForm()).toBeNull();expect(host.textContent).not.toContain('Synthetic current account workspace');expect(replaceAccountLocation).not.toHaveBeenCalled();
});
it('login DTO alone cannot enter workspace or checkout without cookie session proof',async()=>{
 history.replaceState(null,'','/account?offer=cluera_pack_3h_v2');const request=fixture((_url,init)=>init?.method==='POST'?Response.json({account:first}):Response.json({},{status:401}));await render();loginFields();await submit(host.querySelector('form')!);
 expect(request.mock.calls.filter(([url])=>url==='/api/account/session')).toHaveLength(2);expect(host.textContent).not.toContain('Signed in as');expect(replaceAccountLocation).not.toHaveBeenCalled();expect(host.textContent).toContain('Sign-in could not be confirmed');
});
it('verified login returns only to selected plan without any billing request',async()=>{
 history.replaceState(null,'','/account?offer=cluera_pack_3h_v2');let loggedIn=false;const request=fixture((_url,init)=>{if(init?.method==='POST'){loggedIn=true;return Response.json({account:first});}return loggedIn?session():Response.json({},{status:401});});await render();loginFields();await submit(host.querySelector('form')!);
 expect(replaceAccountLocation).toHaveBeenCalledExactlyOnceWith('/account/checkout?offer=cluera_pack_3h_v2');expect(sessionStorage.getItem('cluera.checkout-selection.v1')).toBeNull();expect(location.search).toBe('');expect(request.mock.calls.every(([url])=>['/api/account/session','/api/account/auth-options','/api/account/login'].includes(String(url))||String(url)===`/api/account/password-security?expectedAccountId=${first.userId}`)).toBe(true);
});
it('login-session identity mismatch cannot display another customer or navigate',async()=>{
 let loggedIn=false;fixture((_url,init)=>{if(init?.method==='POST'){loggedIn=true;return Response.json({account:first});}return loggedIn?session(second):Response.json({},{status:401});});await render();loginFields();await submit(host.querySelector('form')!);expect(host.textContent).toContain('signed-in account changed');expect(host.textContent).not.toContain(second.email);expect(replaceAccountLocation).not.toHaveBeenCalled();
});
it.each(['disabled','unavailable'])('Google %s stays closed while email works',async google=>{
 const request=fixture(()=>Response.json({},{status:401}),google);await render();const button=Array.from(host.querySelectorAll('button')).find(value=>value.textContent==='Continue with Google')!;expect(button.disabled).toBe(true);await act(async()=>button.click());expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);expect(host.querySelector('input[name="email"]')).not.toBeNull();
});
it('rejected password update retains session and clears submitted secret fields',async()=>{
 const request=fixture((_url,init)=>init?.method==='POST'?Response.json({code:'SAME_PASSWORD',error:'PRIVATE_UPSTREAM'},{status:400}):session());await render();const form=securityForm();(form.elements.namedItem('password') as HTMLInputElement).value='synthetic-passphrase';(form.elements.namedItem('currentPassword') as HTMLInputElement).value='synthetic-old-password';await submit(form);
 expect(host.textContent).toContain('Signed in as');expect(host.textContent).not.toContain('PRIVATE_UPSTREAM');expect((form.elements.namedItem('password') as HTMLInputElement).value).toBe('');expect((form.elements.namedItem('currentPassword') as HTMLInputElement).value).toBe('');expect(request.mock.calls.filter(([url])=>url==='/api/account/logout')).toHaveLength(0);
});
it('known password success with remote-revoke uncertainty never retries or misreports failure',async()=>{
 const request=fixture((_url,init)=>init?.method==='POST'?Response.json({ok:true,message:'fixed',sessionsRevoked:false}):session());await render();const form=securityForm();(form.elements.namedItem('password') as HTMLInputElement).value='synthetic-passphrase';await submit(form);expect(host.textContent).toContain('Your password was changed');expect(host.textContent).toContain('Do not repeat');expect(host.textContent).not.toContain('Signed in as');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('reauthentication is explicit, single-flight and rate-backed-off without automatic resend',async()=>{
 vi.useFakeTimers();const request=fixture((_url,init)=>init?.method==='POST'?Response.json({ok:true,message:emailNotice}):session());await render();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);const button=Array.from(host.querySelectorAll('button')).find(value=>value.textContent==='Email a reauthentication code')!;await act(async()=>{button.click();button.click();});expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(button.disabled).toBe(true);await act(async()=>vi.advanceTimersByTimeAsync(60000));expect(button.disabled).toBe(false);expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('cross-tab switch fences late password success from previous owner',async()=>{
 let active=first,finish!:(response:Response)=>void;fixture((_url,init)=>init?.method==='POST'?new Promise<Response>(resolve=>{finish=resolve;}):session(active));await render();const form=securityForm();(form.elements.namedItem('password') as HTMLInputElement).value='synthetic-passphrase';await submit(form);active=second;await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:'cluera-account-session-change-v1',newValue:'opaque'})));expect(host.textContent).toContain(second.email);await act(async()=>finish(Response.json({ok:true,message:'fixed',sessionsRevoked:true})));expect(host.textContent).toContain(second.email);expect(host.textContent).not.toContain('Password updated. Sign in again.');
});
it('StrictMode cleanup cannot block the second session restore',async()=>{
 fixture(()=>session());await act(async()=>root.render(createElement(StrictMode,null,createElement(AccountPanel))));expect(host.textContent).toContain('Synthetic current account workspace');
});
it('same-account focus preserves unsent fields; changed owner remounts security fields',async()=>{
 vi.useFakeTimers();let active=first;const request=fixture(()=>session(active));await render();(securityForm().elements.namedItem('password') as HTMLInputElement).value='first-unsubmitted';await act(async()=>vi.advanceTimersByTimeAsync(5001));await act(async()=>window.dispatchEvent(new Event('focus')));expect((securityForm().elements.namedItem('password') as HTMLInputElement).value).toBe('first-unsubmitted');active=second;await act(async()=>vi.advanceTimersByTimeAsync(5001));await act(async()=>window.dispatchEvent(new Event('focus')));expect(host.textContent).toContain(second.email);expect((securityForm().elements.namedItem('password') as HTMLInputElement).value).toBe('');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it.each(['link_invalid','cancelled','PRIVATE_UPSTREAM','link_invalid&authError=PRIVATE_UPSTREAM'])('fixed callback %s never reflects text or sends/returns automatically',async error=>{
 history.replaceState(null,'','/account?offer=cluera_pack_3h_v2&authError='+error+'#login');const request=fixture(()=>session());await render();expect(host.textContent).not.toContain('PRIVATE_UPSTREAM');expect(replaceAccountLocation).not.toHaveBeenCalled();expect(location.search).not.toContain('authError');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('selection cannot authorize another desktop customer, recovery or an arbitrary target',()=>{
 expect(selectedPlanReturn({offerCode:'cluera_pack_3h_v2',desktopAccount:null},first.userId,false)).toBe('/account/checkout?offer=cluera_pack_3h_v2');expect(selectedPlanReturn({offerCode:'cluera_pack_3h_v2',desktopAccount:second.userId},first.userId,false)).toBeNull();expect(selectedPlanReturn({offerCode:'cluera_pack_3h_v2',desktopAccount:null},first.userId,true)).toBeNull();expect(()=>selectedPlanReturn({offerCode:'https://attacker.invalid',desktopAccount:null} as never,first.userId,false)).toThrow();
});
