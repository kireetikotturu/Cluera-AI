'use client';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {adminBoundedRead} from '../../../lib/accounts/adminBoundedRead';
import {nativeCommandsSchema,type NativeCommands} from '../../../lib/payments/cluera/adminNativeCommandContracts';
const endpoint='/api/account/admin/billing/cluera/native-commands';
const capability=z.object({code:z.literal('ACTIVE'),viewer:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const explanations={PENDING:'Awaiting the original command dispatcher.',CLAIMED:'The original command has a durable lease; an expired lease does not authorize replay.',
 ACCEPTED:'Provider request acknowledged; terminal subscription state remains to be observed.',UNCERTAIN:'Original outcome is unknown. Retain it for operator review; do not repeat the request.',
 REVIEW:'Requires operator review. Unsupported rescheduling does not authorize a provider change.'};
export function NativeCommandReview({disabled=false}:{disabled?:boolean}){
 const [report,setReport]=useState<NativeCommands|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Read retained native command states when the separate read capability is available.');
 const alive=useRef(true),generation=useRef(0),reading=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;++generation.current;reading.current?.abort();};},[]);
 useEffect(()=>{if(disabled){++generation.current;reading.current?.abort();reading.current=null;setReport(null);setBusy(false);}},[disabled]);
 async function load(subject:string|null,old?:NativeCommands){
  if(disabled||reading.current)return;
  const controller=new AbortController(),version=++generation.current;reading.current=controller;setBusy(true);setReport(null);setMessage('Verifying Admin access and reading retained commands...');
  const current=()=>alive.current&&version===generation.current;
  const failed=(status:number)=>{if(current())setMessage(status===401||status===403?'Current Admin access and MFA are required.'
   :status===404?'Native command review awaits its separate database/read approval.':status===400?'The customer or page is invalid. Refresh the review.'
   :status===429?'Please wait before reading native command review again.':'Native command review is unavailable.');};
  try{
   let viewer=old?.viewer;if(!viewer){const access=await adminBoundedRead(endpoint,controller);if(access.status!==200){failed(access.status);return;}viewer=capability.parse(access.data).viewer;}
   if(!current())return;
   const query=new URLSearchParams({viewer});if(subject)query.set('subject',subject);if(old?.nextCursor)query.set('cursor',old.nextCursor);
   const response=await adminBoundedRead(`${endpoint}?${query}`,controller);if(!current())return;
   if(response.status!==200){failed(response.status);return;}
   const value=nativeCommandsSchema.parse(response.data);if(value.viewer!==viewer||value.subject!==subject)throw Error('UNAVAILABLE');
   if(current()){setReport(value);setMessage(`${value.rows.length} retained commands read, oldest first.`);}
  }catch{if(current())setMessage('Native command review is unavailable.');}
  finally{if(version===generation.current){reading.current=null;if(alive.current)setBusy(false);}controller.abort();}
 }
 return <section className="ai-provider-console" aria-label="Native recurring command review" aria-busy={busy}>
  <p className="account-ui-kicker">READ-ONLY NATIVE COMMAND REVIEW</p><h2>Retained recurring commands</h2>
  <p>Read up to 50 current retained commands, oldest first. These observations preserve unknown outcomes and do not authorize recovery or a payment change.</p>
  <form onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);void load(String(data.get('subject')??'').trim()||null);}}>
   <fieldset disabled={disabled||busy}><legend>Command review filter</legend><label>Customer UUID (optional)<input name="subject" maxLength={36} autoComplete="off" spellCheck={false}/></label>
    <button type="submit">Read native command review</button></fieldset>
  </form><p role="status" aria-live="polite">{message}</p>
  {report?<><p>Observed {new Date(report.observedAt).toLocaleString()}. Later authoritative observations can change the next read.</p>
   <ul>{report.rows.map(row=><li key={row.id} style={{overflowWrap:'anywhere'}}><h3>{row.kind==='RESCHEDULE'?'Reschedule review':'End-of-cycle cancellation'} · {row.state}</h3>
    <p>{row.state==='CLAIMED'&&(!row.leaseUntil||Date.parse(row.leaseUntil)<=Date.parse(report.observedAt))
     ?'The original lease expired or is unavailable. Its outcome is unknown and requires operator review. Do not repeat the request.':explanations[row.state]}</p><p>Reference <code>{row.id}</code> · customer <code>{row.userId}</code> · subscription <code>{row.subscriptionId}</code></p>
    <p>Retained {new Date(row.createdAt).toLocaleString()}{row.effectiveAt?` · desired time ${new Date(row.effectiveAt).toLocaleString()}`:''}</p>
    {row.observedAt?<p>Last observed {new Date(row.observedAt).toLocaleString()}</p>:null}
   </li>)}</ul>{report.rows.length===0?<p>No retained commands match this selection.</p>:null}
   {report.nextCursor?<button type="button" disabled={disabled||busy} onClick={()=>void load(report.subject,report)}>Read next 50 native commands</button>:null}</>:null}
 </section>;
}
