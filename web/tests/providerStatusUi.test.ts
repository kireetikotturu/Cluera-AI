// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ProviderStatus} from '../app/account/admin/ProviderStatus';
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const snapshot={observedAt:'2026-10-08T00:00:00.000Z',providers:['gemini','deepgram'].map(provider=>({provider,configured:true,enabled:true,fingerprint:'0123456789abcdef',lastRotatedAt:null,health:'UNVERIFIED',rotationAvailable:false}))};
it('reads only after an explicit click, blocks duplicate clicks and keeps rotation disabled',async()=>{
 let resolve!:(r:Response)=>void;const waiting=new Promise<Response>(r=>{resolve=r;});
 const request=vi.fn(()=>waiting);vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(ProviderStatus)));expect(request).not.toHaveBeenCalled();
 await act(async()=>{host.querySelector('button')!.click();host.querySelector('button')!.click();});expect(request).toHaveBeenCalledOnce();
 await act(async()=>resolve(Response.json({providerStatus:snapshot})));
 expect(host.textContent).toContain('Configured');expect(host.textContent).toContain('Provider health not verified');
 expect(host.textContent).toContain('Last rotation: unknown');expect(host.querySelectorAll('button')[1].disabled).toBe(true);
});
it('clears the earlier snapshot when refresh fails or AAL2 is no longer active',async()=>{
 const request=vi.fn().mockResolvedValueOnce(Response.json({providerStatus:snapshot})).mockResolvedValueOnce(Response.json({needsMfa:true}));
 vi.stubGlobal('fetch',request);await act(async()=>root.render(createElement(ProviderStatus)));
 await act(async()=>host.querySelector('button')!.click());expect(host.textContent).toContain('0123456789abcdef');
 await act(async()=>host.querySelector('button')!.click());expect(host.textContent).not.toContain('0123456789abcdef');expect(host.textContent).toContain('Configuration unknown');
});
it('never conflates admin-vault mode with legacy environment booleans',async()=>{
 const request=vi.fn(async()=>Response.json({providerStatus:{...snapshot,bootstrapMode:'admin-vault'}}));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(ProviderStatus)));await act(async()=>host.querySelector('button')!.click());
 expect(host.textContent).toContain('Admin-vault mode is selected');expect(host.textContent).toContain('does not report current vault credentials or enablement');
 expect(host.textContent).not.toContain('Relay enabled');expect(host.textContent).not.toContain('Relay disabled');expect(host.textContent).not.toContain('0123456789abcdef');
 expect(host.textContent).not.toContain('Privately replace keys in Render');expect(host.querySelector('a[href="#account-admin-providers"]')?.textContent).toBe('AI Providers & Models');expect(request).toHaveBeenCalledOnce();
});
it('reports auth-only START blocked without claiming current vault credential state',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({providerStatus:{...snapshot,bootstrapMode:'auth-only'}})));
 await act(async()=>root.render(createElement(ProviderStatus)));await act(async()=>host.querySelector('button')!.click());
 expect(host.textContent).toContain('Auth-only bootstrap is active');expect(host.textContent).toContain('AI START remains blocked');
 expect(host.textContent).toContain('No current vault state is inferred');expect(host.textContent).not.toContain('Relay enabled');expect(host.textContent).not.toContain('0123456789abcdef');
 expect(host.textContent).not.toContain('Privately replace keys in Render');
});
