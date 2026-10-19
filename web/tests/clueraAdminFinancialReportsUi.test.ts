// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FinancialReports} from '../app/account/admin/FinancialReports';

const viewer='a'.repeat(64),customer='00000000-0000-4000-8000-000000000001';
let host:HTMLDivElement,root:Root;
const safe=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function snapshot(url:string){const params=new URL(url,'http://localhost').searchParams;
 const revision={revisionId:'00000000-0000-4000-8000-000000000101',offerCode:'cluera_pack_3h_v2',version:1,name:'Cluera 3 Hours',kind:'PACK',amountPaise:54900,currency:'INR'};
 return{code:'ACTIVE',viewer,from:params.get('from'),to:params.get('to'),subject:params.get('subject'),observedAt:new Date().toISOString(),nextCursor:null,
  rows:[{intentId:'00000000-0000-4000-8000-000000000201',userId:customer,createdAt:new Date(Date.now()-86400000).toISOString(),intentState:'VERIFIED',revision,
   payment:{paymentId:'pay_report00000001',orderId:'order_report00000001',invoiceId:null,subscriptionId:null,paidAt:null,state:'VERIFIED',amountPaise:54900,currency:'INR'}},
  {intentId:'00000000-0000-4000-8000-000000000202',userId:customer,createdAt:new Date(Date.now()-86400000).toISOString(),intentState:'UNCERTAIN',revision,payment:null}],
  totals:{scope:'CURRENT_PAGE',currency:'INR',verifiedCount:1,verifiedAmountPaise:54900,refundedCount:0,refundedAmountPaise:0,requestsWithoutPayment:1}};
}
const render=async(disabled=false)=>{await act(async()=>root.render(createElement(FinancialReports,{disabled})));};
const submit=async()=>{await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));};
const button=(name:string)=>Array.from(host.querySelectorAll('button')).find(item=>item.textContent===name)!;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});

it('mount/navigation never starts reads, enrollment, provider requests or financial actions',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await render();expect(fetcher).not.toHaveBeenCalled();expect(host.textContent).toContain('page totals');
 expect(button('Refresh financial report').matches(':disabled')).toBe(false);await render(true);expect(button('Refresh financial report').matches(':disabled')).toBe(true);expect(fetcher).not.toHaveBeenCalled();
});
it('explicit same-origin refresh validates viewer then renders actual payments separately from unresolved amounts',async()=>{
 const fetcher=vi.fn(async(url:string)=>safe(url.includes('?')?snapshot(url):{code:'ACTIVE',viewer}));vi.stubGlobal('fetch',fetcher);
 await render();await submit();expect(fetcher).toHaveBeenCalledTimes(2);expect(host.textContent).toContain('2 records');
 expect(host.textContent).toContain('pay_report00000001');expect(host.textContent).toContain('UNCERTAIN');expect(host.textContent).toContain('No cleared payment amount');
 expect(host.textContent).toContain('Settlement, tax invoices');
 for(const[url,init]of fetcher.mock.calls as unknown as Array<[string,RequestInit]>){expect(url.startsWith('/api/account/admin/billing/cluera/report')).toBe(true);
  expect(init).toMatchObject({credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});expect(init.method).toBeUndefined();expect(init.body).toBeUndefined();}
});
it('pagination retains the same viewer, filter window and opaque cursor without automatically traversing more pages',async()=>{
 const fetcher=vi.fn(async(url:string)=>{if(!url.includes('?'))return safe({code:'ACTIVE',viewer});const value=snapshot(url);if(!new URL(url,'http://localhost').searchParams.has('cursor'))value.nextCursor='c2lnbmVk.c3ludGhldGlj' as any;return safe(value);});vi.stubGlobal('fetch',fetcher);
 await render();await submit();expect(fetcher).toHaveBeenCalledTimes(2);await act(async()=>button('Read next 50 financial records').click());expect(fetcher).toHaveBeenCalledTimes(3);
 const first=new URL(fetcher.mock.calls[1][0],'http://localhost'),next=new URL(fetcher.mock.calls[2][0],'http://localhost');
 for(const key of['viewer','from','to'])expect(next.searchParams.get(key)).toBe(first.searchParams.get(key));expect(next.searchParams.get('cursor')).toBe('c2lnbmVk.c3ludGhldGlj');
});
it.each([401,403,404,429,503])('denial/unavailability %i removes earlier records and displays fixed guidance without raw response text',async(status)=>{
 let reject=false;const fetcher=vi.fn(async(url:string)=>reject?safe({error:'raw-provider-secret-never-show'},status):safe(url.includes('?')?snapshot(url):{code:'ACTIVE',viewer}));vi.stubGlobal('fetch',fetcher);
 await render();await submit();expect(host.textContent).toContain('pay_report00000001');reject=true;await submit();expect(host.textContent).not.toContain('pay_report00000001');expect(host.textContent).not.toContain('raw-provider-secret-never-show');
});
it('numeric string amounts, extra raw evidence and viewer changes cannot become displayed money',async()=>{
 for(const change of[(v:any)=>{v.rows[0].payment.amountPaise='54900';},(v:any)=>{v.rows[0].evidence='raw-secret';},(v:any)=>{v.viewer='b'.repeat(64);}]){
  const fetcher=vi.fn(async(url:string)=>{if(!url.includes('?'))return safe({code:'ACTIVE',viewer});const value=snapshot(url);change(value);return safe(value);});vi.stubGlobal('fetch',fetcher);
  await render();await submit();expect(host.textContent).toContain('Financial reports are unavailable');expect(host.textContent).not.toContain('pay_report00000001');expect(host.textContent).not.toContain('raw-secret');
 }
});
it('a parent lock aborts pending reads, clears results and suppresses a late same-origin completion',async()=>{
 let resolve!:(r:Response)=>void;const fetcher=vi.fn(async(url:string)=>url.includes('?')?new Promise<Response>(done=>{resolve=done;}):safe({code:'ACTIVE',viewer}));vi.stubGlobal('fetch',fetcher);
 await render();await submit();expect(fetcher).toHaveBeenCalledTimes(2);await render(true);await act(async()=>resolve(safe(snapshot(fetcher.mock.calls[1][0]))));
 expect(host.textContent).not.toContain('pay_report00000001');expect(button('Refresh financial report').matches(':disabled')).toBe(true);
});
it('hard read deadline rejects an abort-ignoring stream without waiting for its cancellation',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn(async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}),
  {headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}}));vi.stubGlobal('fetch',fetcher);
 await render();await submit();expect(host.getAttribute('aria-busy')).toBeNull();await act(async()=>vi.advanceTimersByTimeAsync(8001));
 expect(host.textContent).toContain('Financial reports are unavailable');expect(button('Refresh financial report').disabled).toBe(false);
});
