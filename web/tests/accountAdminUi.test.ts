// @vitest-environment jsdom
import {act,createElement,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountAdmin} from '../app/account/admin/AccountAdmin';
import {AccountReleases} from '../app/account/admin/AccountReleases';
const role=vi.hoisted(()=>({recheck:vi.fn()}));
vi.mock('../app/account/AdminRoleNavigation',()=>({useAdminAccessRecheck:()=>role.recheck}));

const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const users=[{userId:a,email:'a@example.invalid',state:'ACTIVE'},{userId:b,email:'b@example.invalid',state:'ACTIVE'}];
const view=(id?:string)=>({users:id?users.filter(u=>u.userId===id):users,grants:[],models:[],audit:[],testEntitlementsEnabled:true});
let host:HTMLDivElement,root:Root;
beforeEach(()=>{role.recheck.mockClear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(v=>v.textContent===name)!;
const pending=()=>{let resolve!:(r:Response)=>void;const promise=new Promise<Response>(r=>{resolve=r;});return {promise,resolve};};
it('explains denied/expired/invalid/unavailable reads safely without displaying raw API data',async()=>{
 for(const [status,code]of [[401,'ADMIN_SIGN_IN_REQUIRED'],[403,'ADMIN_ACCESS_DENIED'],[400,'ADMIN_QUERY_INVALID'],[429,'ADMIN_RATE_LIMITED'],[503,'ADMIN_SERVICE_UNAVAILABLE']] as const){
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'private SQL/token/body must not be displayed'},{status})));
  await render();
  await act(async()=>button('Refresh account administration').click());
  expect(host.textContent).toContain(`[${code}]`);expect(host.textContent).not.toContain('private SQL');
  expect(host.querySelector('select[name="action"]')).toBeNull();
 }
});
async function render(){await act(async()=>root.render(createElement(AccountAdmin)));}
it('rechecks the protected assurance fence before loading controls after verified MFA',async()=>{
 const factor='00000000-0000-4000-8000-000000000003';let verified=false;
 const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){verified=true;return Response.json({ok:true});}
  if(verified){expect(role.recheck).toHaveBeenCalledOnce();return Response.json(view());}
  return Response.json({needsMfa:true,factors:[{id:factor,status:'verified'}]});
 });
 vi.stubGlobal('fetch',fetcher);await render();
 const select=host.querySelector('select')!;await act(async()=>{select.value=factor;select.dispatchEvent(new Event('change',{bubbles:true}));});
 const form=host.querySelector('form')!;(form.elements.namedItem('code') as HTMLInputElement).value='123456';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(role.recheck).toHaveBeenCalledOnce();expect(host.textContent).toContain('Models in the Cluera app');
});
function submit(){const form=host.querySelector('select[name="action"]')!.closest('form')!;
 (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value='Synthetic staging test reason';
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}

it('ignores older account responses and binds the mutation only to displayed verified selection',async()=>{
 const first=pending(),second=pending(),mutation=pending();
 const fetcher=vi.fn((url:string,init?:RequestInit)=>init?.method==='POST'?mutation.promise:url.includes(a)?first.promise:url.includes(b)?second.promise:Promise.resolve(Response.json(view())));
 vi.stubGlobal('fetch',fetcher);await render();
 await act(async()=>{button(users[0].email).click();button(users[1].email).click();});
 // The session-defaults box also reads the model list once when the page opens.
 const reads=fetcher.mock.calls.filter(([url])=>url!=='/api/account/models');
 expect((reads[1][1] as RequestInit).signal?.aborted).toBe(true);
 await act(async()=>second.resolve(Response.json(view(b))));
 await act(async()=>first.resolve(Response.json(view(a))));
 expect(host.textContent).toContain(users[1].email);expect(host.textContent).not.toContain(users[0].email);
 await act(async()=>submit());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);
 expect(JSON.parse(String(posts[0][1]?.body)).subjectId).toBe(b);
 await act(async()=>mutation.resolve(Response.json({error:'Synthetic failure'},{status:503})));
});
it('blocks stale forms during loading and clears old controls after a failed selection',async()=>{
 const failing=pending(),fetcher=vi.fn((url:string,init?:RequestInit)=>init?.method==='POST'?Promise.resolve(Response.json({})):url.includes(a)?Promise.resolve(Response.json(view(a))):url.includes(b)?failing.promise:Promise.resolve(Response.json(view())));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>{button('Show recent').click();});
 await act(async()=>button(users[1].email).click());
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(true);
 await act(async()=>failing.resolve(Response.json({},{status:401})));
 expect(host.querySelector('select[name="action"]')).toBeNull();expect(button('Refresh account administration')).toBeTruthy();
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
});
it('locks all new mutations after an uncertain write and retries only the identical operation',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({},{status:503}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>{submit();submit();});
 expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(true);expect(button('Show recent').disabled).toBe(true);
 await act(async()=>button('Try again').click());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(2);expect(posts[0][1]?.body).toBe(posts[1][1]?.body);
});
it('ignores the first StrictMode effect response after cleanup',async()=>{
 const stale=pending();let count=0;vi.stubGlobal('fetch',vi.fn(()=>++count===1?stale.promise:Promise.resolve(Response.json(view()))));
 await act(async()=>root.render(createElement(StrictMode,null,createElement(AccountAdmin))));
 await act(async()=>stale.resolve(Response.json({needsMfa:true,factors:[]})));
 expect(host.textContent).toContain('Models in the Cluera app');expect(host.textContent).not.toContain('Enroll authenticator');
});
it('allows correction after a first definitely rejected operation and bounds POST transport',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({code:'INSUFFICIENT_UNUSED'},{status:409}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>submit());
 const first=fetcher.mock.calls.find(([,init])=>init?.method==='POST')!;
 expect(first[1]?.signal).toBeInstanceOf(AbortSignal);expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(false);
 expect(host.textContent).toContain('was not accepted');expect(host.textContent).not.toContain('Saving your change');
 await act(async()=>submit());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(2);
 expect(JSON.parse(String(posts[0][1]?.body)).operationId).not.toBe(JSON.parse(String(posts[1][1]?.body)).operationId);
});
it('retains the same uncertain operation after a later rate-limit or authentication rejection',async()=>{
 let attempts=0;
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({}, {status:++attempts===1?503:attempts===2?429:403}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>submit());
 for(let retry=0;retry<2;retry++)await act(async()=>button('Try again').click());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(3);
 expect(posts[1][1]?.body).toBe(posts[0][1]?.body);expect(posts[2][1]?.body).toBe(posts[0][1]?.body);
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(true);expect(host.textContent).toContain('Saving your change');
});
it('does not treat a malformed success response or timed-out mutation as confirmation',async()=>{
 let attempts=0;
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method!=='POST')return Response.json(view(url.includes(a)?a:undefined));
  if(++attempts===1)throw new DOMException('Synthetic timeout','TimeoutError');
  return Response.json({ok:true});
 });
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>submit());await act(async()=>button('Try again').click());
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(true);
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
});
it('provides anchored navigation and local audit filtering without extra requests or writes',async()=>{
 const fetcher=vi.fn(async()=>Response.json({...view(),audit:[{id:'one',action:'CATALOG',reason:'Synthetic catalog update',createdAt:'2026-10-12T00:00:00Z'},{id:'two',action:'SUSPEND',reason:'Synthetic suspension reason',createdAt:'2026-10-12T00:00:01Z'}]}));
 vi.stubGlobal('fetch',fetcher);await render();
 const links=host.querySelectorAll('nav[aria-label="Admin sections"] button');
 expect([...links].map(link=>link.textContent)).toEqual(['Overview','Plans & pricing','AI models & keys','AI costs','Customers','Data','Payments','App updates','History']);
 const history=links[links.length-1] as HTMLButtonElement;
 await act(async()=>history.click());expect(history.getAttribute('aria-selected')).toBe('true');
 const filter=host.querySelector('#account-admin-audit input[type="search"]') as HTMLInputElement;
 const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
 await act(async()=>{setter.call(filter,'catalog');filter.dispatchEvent(new Event('input',{bubbles:true}));});
 expect(host.querySelector('.account-admin-audit')?.textContent).toContain('CATALOG');expect(host.querySelector('.account-admin-audit')?.textContent).not.toContain('SUSPEND');
 expect((fetcher.mock.calls as unknown as Array<[string]>).map(([url])=>url).filter(url=>url!=='/api/account/models')).toEqual(['/api/account/admin']);
 expect(host.textContent).not.toContain('recurring checkout is unavailable');
 expect(host.querySelector('#account-admin-billing-tools')).toBeNull();
});

it('includes releases in the parent uncertain-operation lock without allocating another mutation',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({},{status:503}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>submit());const releaseForm=host.querySelector('#account-admin-releases form')!;
 expect(releaseForm.closest('fieldset')?.disabled).toBe(true);expect(button('Refresh Cluera releases').disabled).toBe(true);
 const before=fetcher.mock.calls.length;await act(async()=>releaseForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(fetcher).toHaveBeenCalledTimes(before);await act(async()=>button('Try again').click());
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
});

it('fences a release submission in the same event turn before the parent lock has rerendered',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({},{status:503}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());const releaseForm=host.querySelector('#account-admin-releases form')!;
 await act(async()=>{submit();releaseForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(JSON.parse(String(posts[0][1]?.body)).action).toBe('ADD_MINUTES');
});

it('blocks release submissions while a parent Admin read is awaiting authorization',async()=>{
 const read=pending();const fetcher=vi.fn((url:string,init?:RequestInit)=>init?.method==='POST'?Promise.resolve(Response.json({})):url.includes(a)?read.promise:Promise.resolve(Response.json(view())));
 vi.stubGlobal('fetch',fetcher);await render();const releaseForm=host.querySelector('#account-admin-releases form')!;
 await act(async()=>{button(users[0].email).click();releaseForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(releaseForm.closest('fieldset')?.disabled).toBe(true);expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
 await act(async()=>read.resolve(Response.json({},{status:401})));expect(host.querySelector('#account-admin-releases')).toBeNull();
});

it('preserves a child release operation across parent disablement and retries its exact original body',async()=>{
 const fetcher=vi.fn(async()=>Response.json({},{status:503}));vi.stubGlobal('fetch',fetcher);await act(async()=>root.render(createElement(AccountReleases)));
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 const original=(fetcher.mock.calls as unknown as [string,RequestInit][])[0][1].body;
 await act(async()=>root.render(createElement(AccountReleases,{disabled:true})));expect(button('Verify/retry same release operation').disabled).toBe(true);
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>root.render(createElement(AccountReleases,{disabled:false})));await act(async()=>button('Verify/retry same release operation').click());
 expect(fetcher).toHaveBeenCalledTimes(2);expect((fetcher.mock.calls as unknown as [string,RequestInit][])[1][1].body).toBe(original);
});

it('aborts and ignores a stale release read after parent disablement without losing standalone refresh',async()=>{
 const read=pending();const fetcher=vi.fn(()=>read.promise);vi.stubGlobal('fetch',fetcher);await act(async()=>root.render(createElement(AccountReleases)));
 await act(async()=>button('Refresh Cluera releases').click());await act(async()=>root.render(createElement(AccountReleases,{disabled:true})));
 const request=(fetcher.mock.calls as unknown as [string,RequestInit][])[0][1];expect(request.signal?.aborted).toBe(true);
 await act(async()=>read.resolve(Response.json({code:'ACTIVE',releases:[{id:'synthetic',version:'1.0.2',state:'DRAFT',downloadUrl:'https://example.invalid',sha256:'a'.repeat(64),fileSizeBytes:12,releaseNotes:'Synthetic stale release'}]})));
 expect(host.querySelector('[name="confirmed"]')).toBeNull();await act(async()=>root.render(createElement(AccountReleases,{disabled:false})));
 expect(button('Refresh Cluera releases').disabled).toBe(false);expect(fetcher).toHaveBeenCalledTimes(1);
});

it('fences parent mutations while a release outcome is uncertain and keeps the release same-ID retry available',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({},{status:503}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>host.querySelector('#account-admin-releases form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(true);expect(button('Verify/retry same release operation').disabled).toBe(false);
 await act(async()=>submit());expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 await act(async()=>button('Verify/retry same release operation').click());const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');
 expect(posts).toHaveLength(2);expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
});

it('fences parent mutation in the same event as release admission before rendering its lock',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({},{status:503}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());const release=host.querySelector('#account-admin-releases form')!;
 await act(async()=>{release.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));submit();});
 const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(1);expect(JSON.parse(String(posts[0][1]?.body)).action).toBe('RELEASE_DRAFT');
});

it('unlocks parent controls after a definitely rejected first release attempt without losing the form',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({error:'RELEASE_DATABASE_INVALID'},{status:400}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>host.querySelector('#account-admin-releases form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(false);expect(host.querySelector('#account-admin-releases fieldset')?.disabled).toBe(false);
 expect(host.textContent).not.toContain('Result unconfirmed');
});

it('refreshes release rows and unlocks parent controls after confirmed application',async()=>{
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({code:'APPLIED'}):url.includes('releases=1')?Response.json({code:'ACTIVE',releases:[]}):Response.json(view(url.includes(a)?a:undefined)));
 vi.stubGlobal('fetch',fetcher);await render();await act(async()=>button(users[0].email).click());
 await act(async()=>host.querySelector('#account-admin-releases form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(fetcher.mock.calls.some(([url,init])=>url.includes('releases=1')&&init?.method!=='POST')).toBe(true);
 expect(host.querySelector('#account-admin-users fieldset')?.disabled).toBe(false);expect(host.textContent).toContain('Audited release change confirmed');
});

it('gives, replaces and removes unlimited access, and never offers to block the admin\'s own account',async()=>{
 const listed=[{userId:a,email:'a@example.invalid',state:'ACTIVE',unlimited:{endsAt:null}},{userId:b,email:'b@example.invalid',state:'ACTIVE',unlimited:null}];
 const grant=(id:string,kind:string,counted:boolean)=>({id,kind,state:'ACTIVE',grantedMilliseconds:3600000,spentMilliseconds:0,testGrant:false,counted});
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({code:'APPLIED'})
  :Response.json({users:url.includes(a)?[listed[0]]:url.includes(b)?[listed[1]]:listed,grants:url.includes(a)?[grant('g1','UNLIMITED',true),grant('g2','PACK',false)]:[],models:[],audit:[],adminUserId:b}));
 vi.stubGlobal('fetch',fetcher);const confirm=vi.fn(()=>true);vi.stubGlobal('confirm',confirm);window.confirm=confirm;
 await render();expect(host.querySelectorAll('.account-admin-users .unlimited-badge')).toHaveLength(1);
 await act(async()=>button('a@example.invalid').click());
 const form=host.querySelector('.admin-unlimited-form') as HTMLFormElement;
 expect(form.textContent).toContain('No end date');expect(button('Replace unlimited access')).toBeTruthy();
 // Unlimited is not listed as removable minutes, and a test payment says it does not count.
 expect(host.querySelectorAll('.admin-grant')).toHaveLength(1);expect(host.querySelector('.admin-grant')!.textContent).toContain('does not count');
 (form.elements.namedItem('duration') as HTMLSelectElement).value='QUARTER';
 (form.elements.namedItem('reason') as HTMLInputElement).value='Synthetic partner access';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(confirm).toHaveBeenCalledOnce();
 const posts=()=>fetcher.mock.calls.filter(([,init])=>init?.method==='POST').map(([,init])=>JSON.parse(String(init!.body)));
 expect(posts()[0]).toMatchObject({action:'GRANT_UNLIMITED',subjectId:a,input:{duration:'QUARTER'}});
 const remove=[...host.querySelectorAll('form')].find(item=>item.querySelector('button')?.textContent==='Remove unlimited access')!;
 (remove.elements.namedItem('reason') as HTMLInputElement).value='Synthetic end of access';
 await act(async()=>remove.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(posts()[1]).toMatchObject({action:'REVOKE_UNLIMITED',subjectId:a,input:{}});
 await act(async()=>button('Show recent').click());await act(async()=>button('b@example.invalid').click());
 expect(host.textContent).toContain('This is your own Admin account, so it cannot be blocked.');
 expect(button('Block account')).toBeUndefined();expect(button('Give unlimited access')).toBeTruthy();
});
