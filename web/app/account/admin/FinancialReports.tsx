'use client';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {financialReportSchema,type FinancialReport} from '../../../lib/payments/cluera/adminReportContracts';

const capability=z.object({code:z.literal('ACTIVE'),viewer:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const price=(paise:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(paise/100);
const dateInput=(at:number)=>new Date(at).toISOString().slice(0,16);
/** Strict bounded same-origin read. No response is retained after cancellation,
 * denial, malformed data or a session/assurance change in the parent gate. */
async function read(path:string,controller:AbortController):Promise<{status:number;data:unknown}>{
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNAVAILABLE'));},8000);});
 const canceled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('CANCELED')),{once:true}));
 const wait=<T,>(value:Promise<T>)=>Promise.race([value,expired,canceled]);
 try{
  if(controller.signal.aborted)throw Error('CANCELED');
  const response=await wait(fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal}));
  if(response.redirected||response.url&&response.url!==new URL(path,window.location.origin).href)throw Error('UNAVAILABLE');
  if(response.status!==200)return{status:response.status,data:null};
  if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'
   ||response.headers.get('cache-control')!=='no-store'||response.headers.get('x-content-type-options')!=='nosniff'||!response.body)throw Error('UNAVAILABLE');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>131072))throw Error('UNAVAILABLE');
  reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  for(;;){const part=await wait(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>131072)throw Error('UNAVAILABLE');parts.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return{status:200,data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
 }finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* Never await cancellation. */}}
}

export function FinancialReports({disabled=false,mode='test'}:{disabled?:boolean;mode?:'test'|'live'}){
 const endpoint=mode==='live'?'/api/account/payments/cluera/live/report':'/api/account/admin/billing/cluera/report';
 const [report,setReport]=useState<FinancialReport|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Refresh to read current recorded payments and unresolved requests.');
 const alive=useRef(true),generation=useRef(0),reading=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;++generation.current;reading.current?.abort();};},[]);
 useEffect(()=>{if(disabled){++generation.current;reading.current?.abort();reading.current=null;setReport(null);setBusy(false);}},[disabled]);
 async function load(filters:{from:string;to:string;subject:string|null},previous?:FinancialReport){
  if(disabled||reading.current)return;
  const controller=new AbortController(),version=++generation.current;reading.current=controller;setBusy(true);setReport(null);setMessage('Verifying current Admin access and reading financial records...');
  const current=()=>alive.current&&version===generation.current;
  try{
   let viewer=previous?.viewer;
   if(!viewer){const access=await read(endpoint,controller);if(access.status!==200){setFailure(access.status,current);return;}viewer=capability.parse(access.data).viewer;}
   if(!current())return;
   const params=new URLSearchParams({viewer,from:filters.from,to:filters.to});if(filters.subject)params.set('subject',filters.subject);
   if(previous?.nextCursor)params.set('cursor',previous.nextCursor);
   const response=await read(`${endpoint}?${params}`,controller);
   if(!current())return;
   if(response.status!==200){setFailure(response.status,current);return;}
   const result=financialReportSchema.parse(response.data);
   if(result.viewer!==viewer||result.from!==filters.from||result.to!==filters.to||result.subject!==filters.subject)throw Error('UNAVAILABLE');
   if(current()){setReport(result);setMessage(`${result.rows.length} records read. Amounts below cover this page only.`);}
  }catch{if(current())setMessage('Financial reports are unavailable. Refresh after access or service availability is restored.');}
  finally{if(version===generation.current){reading.current=null;if(alive.current)setBusy(false);}controller.abort();}
 }
 function setFailure(status:number,current:()=>boolean){if(current())setMessage(status===401||status===403?'Current Admin access and MFA are required. Reverify access before reading reports.'
  :status===400?'Choose a valid UTC range of at most 31 days and a customer UUID, or refresh an expired page.'
  :status===404?'Financial reporting is awaiting read-only database approval.'
  :status===429?'Please wait before refreshing financial reports.':'Financial reports are unavailable.');}
 return <section className="ai-provider-console" aria-label="Cluera financial reports" aria-busy={busy}>
  <p className="account-ui-kicker">READ-ONLY {mode.toUpperCase()} FINANCIAL RECORDS</p><h2>Payments &amp; unresolved requests</h2>
  <p>Choose a purchase-request creation window in UTC, up to 31 days. Each page contains at most 50 records from the pinned Cluera {mode==='live'?'Live':'Test'} ledger.</p>
  <form onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);try{
   const from=new Date(`${String(data.get('from'))}:00Z`).toISOString(),to=new Date(`${String(data.get('to'))}:00Z`).toISOString();
   const subject=String(data.get('subject')??'').trim()||null;void load({from,to,subject});
  }catch{setReport(null);setMessage('Choose a valid UTC time range.');}}}>
   <fieldset disabled={disabled||busy}><legend>Report filters</legend>
    <label>From (UTC, inclusive)<input name="from" type="datetime-local" required defaultValue={dateInput(Date.now()-30*86400000)}/></label>
    <label>Until (UTC, exclusive)<input name="to" type="datetime-local" required defaultValue={dateInput(Date.now())}/></label>
    <label>Customer UUID (optional)<input name="subject" autoComplete="off" spellCheck={false} maxLength={36}/></label>
    <button type="submit">Refresh financial report</button>
   </fieldset>
  </form>
  <p role="status" aria-live="polite">{message}</p>
  {report?<>
   <p>Read at {new Date(report.observedAt).toLocaleString()}. Request creation window: {report.from} to {report.to}.</p>
   <dl><dt>Verified payment records on this page</dt><dd>{report.totals.verifiedCount} · {price(report.totals.verifiedAmountPaise)}</dd>
    <dt>Fully refunded records on this page</dt><dd>{report.totals.refundedCount} · {price(report.totals.refundedAmountPaise)}</dd>
    <dt>Requests without a recorded payment on this page</dt><dd>{report.totals.requestsWithoutPayment}</dd></dl>
   <ul>{report.rows.map(row=><li key={row.payment?.paymentId??row.intentId} style={{overflowWrap:'anywhere'}}>
    <h3>{row.revision.name} · {row.payment?.state??row.intentState}</h3>
    <p>Customer <code>{row.userId}</code> · request <code>{row.intentId}</code> · created {new Date(row.createdAt).toLocaleString()}</p>
    <p>Original revision {row.revision.version} · {row.revision.offerCode} · requested price {price(row.revision.amountPaise)}</p>
    {row.payment?<><p>Recorded payment {price(row.payment.amountPaise)} · <code>{row.payment.paymentId}</code> · order <code>{row.payment.orderId}</code></p>
     {row.payment.invoiceId?<p>Provider invoice reference <code>{row.payment.invoiceId}</code> · subscription <code>{row.payment.subscriptionId}</code> · paid {new Date(row.payment.paidAt!).toLocaleString()}</p>:null}</>
     :<p>No cleared payment amount is included in the totals for this request.</p>}
   </li>)}</ul>
   {report.rows.length===0?<p>No matching records in this window.</p>:null}
   {report.nextCursor?<button type="button" disabled={disabled||busy} onClick={()=>void load({from:report.from,to:report.to,subject:report.subject},report)}>Read next 50 financial records</button>:null}
  </>:null}
  <p>These are current local billing records and page totals. Refunds and newly reconciled payments can change later reads. Settlement, tax invoices and all-time revenue require their own accounting evidence.</p>
 </section>;
}
