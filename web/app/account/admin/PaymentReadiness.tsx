'use client';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';

const reportSchema=z.object({readiness:z.object({
 mode:z.enum(['test','live']),ready:z.boolean(),audience:z.enum(['nobody','listed accounts','every verified customer']),
 items:z.array(z.object({id:z.string().max(40),area:z.enum(['Website','Razorpay','Database','Catalog','Buyers']),label:z.string().max(200),ok:z.boolean(),fix:z.string().max(700)}).strict()).max(30),
}).strict()}).strict();
type Report=z.infer<typeof reportSchema>['readiness'];

/** Read-only checklist. It explains why customers can or cannot buy and never changes billing. */
export function PaymentReadiness({disabled=false}:{disabled?:boolean}){
 const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Press the button to find out whether customers can pay right now.');
 const alive=useRef(true),running=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function check(){
  if(running.current||disabled)return;running.current=true;setBusy(true);
  try{
   const response=await fetch('/api/account/payments/cluera/admin?readiness=1',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Object.assign(Error(),{status:response.status});
   const data=reportSchema.parse(await response.json());
   if(alive.current){setReport(data.readiness);setMessage('');}
  }catch(error){
   if(alive.current){setReport(null);setMessage((error as {status?:number}).status===403||(error as {status?:number}).status===401?'Sign in as Admin with your authenticator, then press the button again.':'The check could not run just now. Wait a minute and press the button again.');}
  }finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const missing=report?.items.filter(item=>!item.ok).length??0;
 return <section className="ai-provider-console" aria-labelledby="payment-readiness-heading">
  <p className="account-ui-kicker">PAYMENTS</p><h2 id="payment-readiness-heading">Are payments ready?</h2>
  <p>Press the button to see, in plain words, whether customers can pay you right now and what is still missing. Nothing is charged or changed by this check.</p>
  <div className="ai-provider-actions"><button type="button" disabled={disabled||busy} onClick={()=>void check()}>{busy?'Checking…':'Check if payments are ready'}</button></div>
  {message?<p role="status">{message}</p>:null}
  {report?<>
   <p role="status" className={report.ready?'payments-ready':'payments-not-ready'}><strong>{report.ready?`✅ Payments are ready. ${report.mode==='live'?'Real payments':'Test payments'} are open to ${report.audience}.`:`❌ Payments are not ready yet. ${missing} thing${missing===1?'':'s'} still need${missing===1?'s':''} your attention.`}</strong> {report.mode==='live'?'This is Live mode (real money).':'This is Test mode (no real money).'}</p>
   {report.ready?null:<p>Do the items marked ❌ from top to bottom. Each one says what to do next.</p>}
   <ul style={{listStyle:'none',padding:0}}>{report.items.map(item=><li key={item.id} style={{margin:'0.5rem 0'}}>
    <span aria-hidden="true">{item.ok?'✅':'❌'}</span> <strong>{item.area}:</strong> {item.label}{item.ok?'':<><br/><small>{item.fix}</small></>}
   </li>)}</ul>
  </>:null}
 </section>;
}
