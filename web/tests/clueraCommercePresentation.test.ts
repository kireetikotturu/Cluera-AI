// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccountPricing} from '../app/AccountPricing';
import ClueraCheckoutClient from '../app/account/checkout/ClueraCheckoutClient';
import type {ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';
const userId='00000000-0000-4000-8000-000000000801';
const codes=['cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2'] as const;
const catalog:ClueraPublicRevision[]=codes.map((offerCode,index)=>({offerCode,revisionId:`00000000-0000-4000-8000-00000000082${index}`,name:['Cluera 3 Hours','Cluera Pro 40 Hours','Cluera Pro 100 Hours','Cluera Enterprise 200 Hours'][index],version:1,amountPaise:[54900,549900,959900,1954900][index],currency:'INR',allowanceSeconds:[10800,144000,360000,720000][index],kind:index?'RECURRING':'PACK',interval:index?'MONTH':null,totalCount:index?120:null,enabled:true,testPlanValidated:true}));
const credits={userId,displayName:'Synthetic Tester',availableMilliseconds:900000,payments:[]};
const available={payment:{userId,code:'AVAILABLE',pending:null,resolvedOrderIds:[],resolvedSubscriptionIds:[]}};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);history.replaceState(null,'','/account/checkout');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();document.querySelectorAll('script[src*="razorpay"]').forEach(script=>script.remove());});
const action=(code:typeof codes[number]=codes[0])=>host.querySelector<HTMLButtonElement>(`button[data-offer-code="${code}"]`)!;
async function render(enabled=true){await act(async()=>root.render(createElement(ClueraCheckoutClient,{enabled})));}
function installReadFixture(rows=catalog,status=available){const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?new Response(null,{status:503}):Response.json(String(url).endsWith('/catalog')?{catalog:rows}:String(url).includes('/checkout?')?status:credits));vi.stubGlobal('fetch',request);return request;}
it('public pricing links to guarded checkout availability instead of dead disabled buttons',()=>{
 host.innerHTML=renderToStaticMarkup(AccountPricing());expect(host.querySelectorAll('article')).toHaveLength(4);
 for(const [index,code] of codes.entries()){
  const link=host.querySelectorAll<HTMLAnchorElement>('article a')[index];
  expect(link?.getAttribute('aria-label')).toBe(`Check availability: ${catalog[index].name}`);
  expect(link?.getAttribute('href')).toBe(`/account/checkout?offer=${code}`);
 }
 for(const amount of ['549','5,499','9,599','19,549'])expect(host.textContent).toContain(`\u20b9${amount}`);
 expect(host.textContent).toContain('Paid plans are not yet available');expect(host.querySelectorAll('article button')).toHaveLength(0);
 expect(host.textContent).toContain('Check availability');expect(host.textContent).not.toMatch(/View availability|Checkout unavailable/);expect(host.querySelector('script,iframe,form')).toBeNull();
});
it('reviewed catalog cards route to guarded checkout without creating orders or loading payment SDK',()=>{
 host.innerHTML=renderToStaticMarkup(AccountPricing({catalog}));expect(host.querySelectorAll('article a')).toHaveLength(4);
 for(const [index,code] of codes.entries()){
  const link=host.querySelectorAll<HTMLAnchorElement>('article a')[index];
  expect(link?.getAttribute('aria-label')).toBe(`${index?'Subscribe':'Buy Now'}: ${catalog[index].name}`);
  expect(link?.getAttribute('href')).toBe(`/account/checkout?offer=${code}`);
 }
 expect(host.querySelectorAll('article button')).toHaveLength(0);expect(host.textContent).not.toMatch(/View availability|Checkout unavailable/);
 expect(host.textContent).toContain('historical prices never change');expect(host.querySelector('script,iframe,form')).toBeNull();
});
it('fresh enabled account and validated revisions get purchase labels without automatic SDK or writes',async()=>{const request=installReadFixture();await render();expect(action().textContent).toBe('Buy Now');for(const code of codes.slice(1))expect(action(code).textContent).toBe('Subscribe');expect(action().getAttribute('aria-label')).toBe('Buy Now: Cluera 3 Hours');const descriptions=action().getAttribute('aria-describedby')!.split(' ').map(id=>document.getElementById(id));expect(descriptions[0]?.getAttribute('role')).toBe('status');expect(descriptions[1]?.textContent).toContain('Razorpay popup');expect(host.querySelectorAll('dl dt')).toHaveLength(2);expect(request.mock.calls.every(([,init])=>!init?.method)).toBe(true);expect(document.querySelector('script[src*="razorpay"]')).toBeNull();});
it.each(['rollout-disabled','catalog-disabled','plan-unvalidated'] as const)('keeps purchase actions disabled with an explanation when %s',async reason=>{const rows=catalog.map(row=>reason==='catalog-disabled'?{...row,enabled:false}:reason==='plan-unvalidated'?{...row,testPlanValidated:false}:row);const request=installReadFixture(rows);await render(reason!=='rollout-disabled');for(const [index,code] of codes.entries()){expect(action(code).disabled).toBe(true);expect(action(code).textContent).toBe(index?'Subscribe':'Buy Now');expect(action(code).getAttribute('aria-label')).toContain(`${index?'Subscribe':'Buy Now'}:`);}expect(host.textContent).toContain(reason==='rollout-disabled'?'Payments are currently paused.':'Subscriptions for this plan are not open yet.');expect(request.mock.calls.every(([,init])=>!init?.method)).toBe(true);});
it('preserves selected offer and same-owner login link on denial',async()=>{history.replaceState(null,'',`/account/checkout?offer=${codes[2]}&desktopAccount=${userId}`);vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:401})));await render(false);expect(host.querySelector('.cluera-plan-selected')?.getAttribute('aria-label')).toBe(catalog[2].name);expect(host.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(`/account?offer=${codes[2]}&desktopAccount=${userId}#login`);expect([...host.querySelectorAll<HTMLButtonElement>('button[data-offer-code]')].every(button=>button.disabled)).toBe(true);});
it('one unknown outcome keeps every CTA disabled and cannot retry on refresh',async()=>{const request=installReadFixture();await render();await act(async()=>{action().click();action().click();});expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);await act(async()=>{[...host.querySelectorAll('button')].find(button=>button.textContent==='Refresh billing status')!.click();});for(const code of codes)expect(action(code).disabled).toBe(true);expect(host.textContent).toContain('See the payment status above');expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(document.querySelector('script[src*="razorpay"]')).toBeNull();});
