// @vitest-environment jsdom
import {act,createElement,useEffect,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('next/link',()=>({default:({href,children,onClick}:{href:string;children:ReactNode;onClick?:()=>void})=>createElement('a',{href,onClick},children)}));
import {AdminRoleProvider,AdminRoleLink,AdminAccessGate,AdminProtectedContent,notifyAccountSessionChanged,ACCOUNT_SESSION_STORAGE_KEY} from '../app/account/AdminRoleNavigation';
let host:HTMLDivElement,root:Root,mounts:number;
const accepted=(tag='a')=>Response.json({admin:true,mfaVerified:true,navigationSession:tag.repeat(64)},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const denied=(status=403)=>Response.json({error:'PRIVATE_NEVER_ECHO'},{status});
const links=()=>host.querySelectorAll('a[href="/account/admin"]');
function Pending(){useEffect(()=>{mounts++;},[]);return createElement('input',{'data-private':'yes',defaultValue:'pending-operation'});}
async function render(gate=false){await act(async()=>root.render(createElement(AdminRoleProvider,null,gate?createElement(AdminAccessGate):[
 createElement(AdminRoleLink,{key:'h'},'Header Admin'),createElement(AdminRoleLink,{key:'f'},'Footer Admin'),createElement(AdminRoleLink,{key:'w'},'Workspace Admin'),createElement(AdminProtectedContent,{key:'p',children:createElement(Pending)}),])));}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');host=document.createElement('div');document.body.append(host);root=createRoot(host);localStorage.clear();mocks.refresh.mockClear();mounts=0;});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
it('one shared role read hides all links and protected content until resolution',async()=>{
 let finish!:(value:Response)=>void;const request=vi.fn((_url:RequestInfo|URL,_init?:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',request);await render();expect(links()).toHaveLength(0);expect(host.querySelector('[data-private]')).toBeNull();expect(request).toHaveBeenCalledOnce();await act(async()=>finish(accepted()));expect(links()).toHaveLength(3);expect(mounts).toBe(1);expect(request.mock.calls[0][0]).toBe('/api/account/admin/access');
});
it.each([401,403,503])('denial/unavailable %s never reveals Admin affordance',async status=>{
 const request=vi.fn(async()=>denied(status));vi.stubGlobal('fetch',request);await render();expect(links()).toHaveLength(0);expect(host.querySelector('[data-private]')).toBeNull();expect(host.textContent).not.toContain('PRIVATE_NEVER_ECHO');expect(request).toHaveBeenCalledOnce();
});
it.each([{admin:false,mfaVerified:true,navigationSession:'a'.repeat(64)},{admin:true,mfaVerified:'true',navigationSession:'a'.repeat(64)},{admin:true,mfaVerified:true,navigationSession:'a'.repeat(64),email:'PRIVATE_NEVER_ECHO'}])('malformed or extra role fields fail closed',async body=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json(body,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})));await render();expect(links()).toHaveLength(0);expect(host.querySelector('[data-private]')).toBeNull();
});
it('same-session focus and temporary outage retain unknown operations hidden/inert; changed session resets them',async()=>{
 let finish!:(value:Response)=>void;const request=vi.fn().mockResolvedValueOnce(accepted()).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;})).mockResolvedValueOnce(accepted('b')).mockResolvedValueOnce(denied());vi.stubGlobal('fetch',request);await render();const input=host.querySelector<HTMLInputElement>('[data-private]')!;input.value='original-unknown-operation';await act(async()=>window.dispatchEvent(new Event('focus')));expect(links()).toHaveLength(0);expect(input.parentElement?.hidden).toBe(true);expect(input.parentElement?.hasAttribute('inert')).toBe(true);expect(mounts).toBe(1);await act(async()=>finish(denied(503)));expect(input.isConnected).toBe(true);expect(input.value).toBe('original-unknown-operation');expect(input.parentElement?.hidden).toBe(true);await act(async()=>window.dispatchEvent(new Event('focus')));expect(mounts).toBe(2);expect(host.querySelector<HTMLInputElement>('[data-private]')?.value).toBe('pending-operation');await act(async()=>window.dispatchEvent(new Event('focus')));expect(host.querySelector('[data-private]')).toBeNull();
});
it('explicit Auth change immediately unmounts and fences stale role results',async()=>{
 let finish!:(value:Response)=>void;const request=vi.fn().mockResolvedValueOnce(accepted()).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;})).mockResolvedValueOnce(denied());vi.stubGlobal('fetch',request);await render();await act(async()=>notifyAccountSessionChanged());expect(host.querySelector('[data-private]')).toBeNull();await act(async()=>notifyAccountSessionChanged());await act(async()=>finish(accepted()));expect(links()).toHaveLength(0);expect(host.querySelector('[data-private]')).toBeNull();expect(request.mock.calls[1][1].signal.aborted).toBe(true);
});
it('cross-tab payload cannot supply role or identity',async()=>{
 const request=vi.fn().mockResolvedValueOnce(accepted()).mockResolvedValueOnce(denied());vi.stubGlobal('fetch',request);await render();await act(async()=>window.dispatchEvent(new StorageEvent('storage',{key:ACCOUNT_SESSION_STORAGE_KEY,newValue:'admin=true;PRIVATE_IDENTITY'})));expect(links()).toHaveLength(0);expect(host.textContent).not.toContain('PRIVATE_IDENTITY');expect(host.querySelector('[data-private]')).toBeNull();
});
it('neutral restoration refreshes server only after actual role acceptance',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>accepted()));await render(true);expect(mocks.refresh).toHaveBeenCalledOnce();expect(host.querySelector('[data-private]')).toBeNull();
});
it('bounded role read settles even when transport ignores abort, without polling/retry',async()=>{
 vi.useFakeTimers();const request=vi.fn((_url:string,_init:RequestInit)=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',request);await render();await act(async()=>vi.advanceTimersByTimeAsync(8000));expect(links()).toHaveLength(0);expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
});
