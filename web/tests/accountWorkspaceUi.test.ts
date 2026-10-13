// @vitest-environment jsdom
import {act,createElement,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountWorkspace} from '../app/account/AccountWorkspace';
import {usageDuration} from '../lib/usage/display';

const snapshot=(name='Customer')=>({workspace:{displayName:name,balance:{availableMilliseconds:12300000,reservedMilliseconds:30000,spentMilliseconds:60000},
 balances:{TRIAL:900000},plans:[],sessions:[],documents:[]}});
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(v=>v.textContent===name)!;
const deferred=()=>{let resolve!:(r:Response)=>void;const promise=new Promise<Response>(r=>{resolve=r;});return {promise,resolve};};
async function render(){await act(async()=>root.render(createElement(AccountWorkspace)));}
function contextSubmit(){
 const form=host.querySelector('select[name="kind"]')!.closest('form')!;
 (form.querySelector('[name="name"]') as HTMLInputElement).value='Synthetic CV';
 (form.querySelector('[name="body"]') as HTMLTextAreaElement).value='Synthetic private text';
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
}
it('formats remaining time accurately without a timer, including small and large balances',()=>{
 expect(usageDuration(30000)).toBe('30s');expect(usageDuration(65000)).toBe('1m 5s');
 expect(usageDuration(12300000)).toBe('3h 25m');expect(usageDuration(1080600000)).toBe('300h 10m');
 expect(usageDuration(0)).toBe('0s');expect(usageDuration(NaN)).toBe('Unavailable');expect(usageDuration(-1)).toBe('Unavailable');
});
it('recovers a failed initial load through explicit refresh without polling',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({},{status:503})).mockResolvedValueOnce(Response.json(snapshot()));
 vi.stubGlobal('fetch',fetcher);await render();
 expect(host.textContent).toContain('No verified account snapshot');expect(host.textContent).not.toContain('Loading account details');
 await act(async()=>button('Refresh balance and account').click());
 expect(host.textContent).toContain('Remaining 3h 25m');expect(host.textContent).toContain('Reserved for active sessions 30s');
 expect(fetcher).toHaveBeenCalledTimes(2);
 expect(host.querySelector('a[href="/account/download"]')).not.toBeNull();
 expect(host.querySelector('a[href="/download"]')).toBeNull();
});
it('retries the identical document UUID/body after a lost response and blocks duplicate clicks',async()=>{
 let attempt=0;
 const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{
  if(init?.method!=='POST')return Response.json(snapshot());
  if(++attempt===1)throw new TypeError('Synthetic lost response');return Response.json(snapshot());
 });
 vi.stubGlobal('fetch',fetcher);await render();
 await act(async()=>{contextSubmit();contextSubmit();});
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(button('Save private context').disabled).toBe(true);expect(button('Refresh balance and account').disabled).toBe(true);
 await act(async()=>contextSubmit());
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 await act(async()=>button('Retry the same change').click());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');
 expect(posts).toHaveLength(2);expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
 expect(JSON.parse(String(posts[1][1]?.body)).id).toMatch(/^[a-f\d-]{36}$/);
 expect(button('Save private context').disabled).toBe(false);
 expect((host.querySelector('textarea[name="body"]') as HTMLTextAreaElement).value).toBe('');
});
it('unlocks editing after a definite pre-write input rejection',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({},{status:400}):Response.json(snapshot())));
 await render();await act(async()=>contextSubmit());
 expect(host.textContent).toContain('Change rejected before saving');expect(button('Save private context').disabled).toBe(false);
 expect(host.textContent).not.toContain('Retry the same change');
 expect((host.querySelector('textarea[name="body"]') as HTMLTextAreaElement).value).toBe('Synthetic private text');
});
it('keeps an earlier unknown operation locked after a pre-RPC rate-limited retry',async()=>{
 let attempts=0;const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{
  if(init?.method!=='POST')return Response.json(snapshot());
  if(++attempts===1)throw Error('Synthetic response lost');
  return attempts===2?Response.json({},{status:429}):Response.json(snapshot());
 });
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>contextSubmit());
 await act(async()=>button('Retry the same change').click());
 expect(button('Save private context').disabled).toBe(true);expect(host.textContent).toContain('Earlier save still needs confirmation');
 await act(async()=>button('Retry the same change').click());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([,init])=>init!.body);
 expect(posts).toHaveLength(3);expect(new Set(posts).size).toBe(1);expect(JSON.parse(String(posts[0])).operationId).toMatch(/^[a-f\d-]{36}$/);
 expect(button('Save private context').disabled).toBe(false);
});
it('ignores stale StrictMode reads and clears private data after refresh loses authentication',async()=>{
 const stale=deferred();let reads=0;
 vi.stubGlobal('fetch',vi.fn(()=>++reads===1?stale.promise:reads===2?Promise.resolve(Response.json(snapshot('Verified customer'))):Promise.resolve(Response.json({},{status:401}))));
 await act(async()=>root.render(createElement(StrictMode,null,createElement(AccountWorkspace))));
 await act(async()=>stale.resolve(Response.json(snapshot('Stale customer'))));
 expect((host.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Verified customer');
 await act(async()=>button('Refresh balance and account').click());
 expect(host.querySelector('input[name="name"]')).toBeNull();expect(host.textContent).not.toContain('Remaining 3h');
});
it('blocks mutations during an in-flight refresh and does not accept a malformed save confirmation',async()=>{
 const refresh=deferred();let reads=0;
 const fetcher=vi.fn((_url:string,init?:RequestInit)=>init?.method==='POST'?Promise.resolve(Response.json({})):++reads===1?Promise.resolve(Response.json(snapshot())):refresh.promise);
 vi.stubGlobal('fetch',fetcher);await render();
 await act(async()=>{button('Refresh balance and account').click();contextSubmit();});
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
 await act(async()=>refresh.resolve(Response.json(snapshot())));
 await act(async()=>contextSubmit());
 expect(host.textContent).toContain('Save not confirmed');expect(button('Save private context').disabled).toBe(true);
});
