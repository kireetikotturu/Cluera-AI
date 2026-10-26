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
 const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Press the button to see whether customers can buy right now.');
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
   if(alive.current){setReport(null);setMessage((error as {status?:number}).status===403||(error as {status?:number}).status===401?'Sign in as Admin with your authenticator to see the payment checklist.':'The checklist is unavailable right now. Try again in a moment.');}
  }finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const missing=report?.items.filter(item=>!item.ok).length??0;
 return <section className="ai-provider-console" aria-labelledby="payment-readiness-heading">
  <p className="account-ui-kicker">START HERE</p><h2 id="payment-readiness-heading">Payment setup checklist</h2>
  <p>Shows, in plain words, what is still missing before customers can pay with Razorpay. Nothing is charged or changed by this check.</p>
  <div className="ai-provider-actions"><button type="button" disabled={disabled||busy} onClick={()=>void check()}>{busy?'Checking…':'Check payment setup'}</button></div>
  {message?<p role="status">{message}</p>:null}
  {report?<>
   <p role="status"><strong>{report.ready?`Ready — ${report.mode==='live'?'real payments':'test payments'} are open to ${report.audience}.`:`Not ready — ${missing} item${missing===1?'':'s'} still need attention.`}</strong> Mode: {report.mode==='live'?'Live (real money)':'Test (no real money)'}.</p>
   <ul style={{listStyle:'none',padding:0}}>{report.items.map(item=><li key={item.id} style={{margin:'0.5rem 0'}}>
    <span aria-hidden="true">{item.ok?'✅':'❌'}</span> <strong>{item.area}:</strong> {item.label}{item.ok?'':<><br/><small>{item.fix}</small></>}
   </li>)}</ul>
  </>:null}
 </section>;
}
