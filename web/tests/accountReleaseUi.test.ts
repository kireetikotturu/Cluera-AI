// @vitest-environment jsdom
import {act,createElement,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountReleases} from '../app/account/admin/AccountReleases';
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(v=>v.textContent===text)!;
it('does no idle polling and serializes uncertain writes with the identical operation',async()=>{
 const f=vi.fn(async()=>Response.json({},{status:503}));vi.stubGlobal('fetch',f);
 await act(async()=>root.render(createElement(StrictMode,null,createElement(AccountReleases))));expect(f).not.toHaveBeenCalled();
 const form=host.querySelector('form')!;
 await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(f).toHaveBeenCalledTimes(1);expect(host.querySelector('fieldset')?.disabled).toBe(true);
 await act(async()=>button('Verify/retry same release operation').click());expect(f).toHaveBeenCalledTimes(2);
 expect((f.mock.calls as unknown as [string,RequestInit][])[0][1].body).toBe((f.mock.calls as unknown as [string,RequestInit][])[1][1].body);
});
it('does not render publication controls before explicit refresh or fabricate approval confirmation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'ACTIVE',releases:[{id:'test',version:'1.0.8',state:'DRAFT',downloadUrl:'https://example.invalid',sha256:'a'.repeat(64),fileSizeBytes:12,releaseNotes:'test'}]})));
 await act(async()=>root.render(createElement(AccountReleases)));expect(host.querySelector('[name="confirmed"]')).toBeNull();
 await act(async()=>button('Refresh Cluera releases').click());expect((host.querySelector('[name="confirmed"]') as HTMLInputElement).checked).toBe(false);
 expect((host.querySelector('[name="hash"]') as HTMLInputElement).value).toBe('');
});
it('shows only allowlisted corrective error codes and unlocks a definitely rejected first request',async()=>{
 const f=vi.fn(async()=>Response.json({error:'RELEASE_MINIMUM_INVALID',message:'synthetic-private-SQL-token'},{status:400}));vi.stubGlobal('fetch',f);
 await act(async()=>root.render(createElement(AccountReleases)));
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).toContain('[RELEASE_MINIMUM_INVALID]');expect(host.textContent).toContain('no newer than');
 expect(host.textContent).not.toContain('synthetic-private');expect(host.querySelector('fieldset')?.disabled).toBe(false);
 expect(button('Verify/retry same release operation')).toBeUndefined();
 f.mockResolvedValueOnce(Response.json({error:'synthetic-private-error'},{status:403}));
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.textContent).not.toContain('synthetic-private');expect(host.textContent).toContain('Release request rejected');
});
it('retains an uncertain operation even when its retry receives a specific rejection',async()=>{
 const f=vi.fn().mockRejectedValueOnce(Error('synthetic-network-error')).mockResolvedValueOnce(Response.json({error:'RELEASE_DATABASE_INVALID'},{status:409}));vi.stubGlobal('fetch',f);
 await act(async()=>root.render(createElement(AccountReleases)));
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>button('Verify/retry same release operation').click());
 expect(host.querySelector('fieldset')?.disabled).toBe(true);expect(host.textContent).toContain('Result unconfirmed');
 expect(f.mock.calls[0][1].body).toBe(f.mock.calls[1][1].body);
});
