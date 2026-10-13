'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {usageDuration} from '../../lib/usage/display';
interface Workspace {
 displayName:string;
 balance:{availableMilliseconds:number;reservedMilliseconds:number;spentMilliseconds:number};
 balances:Partial<Record<'TRIAL'|'RECURRING'|'PACK',number>>;
 plans:Array<{tier:string;state:string;endsAt:string|null;remainingMilliseconds:number|null;paymentState:string;cancelFuture:boolean;graceUntil:string|null}>;
 sessions:Array<{startedAt:string;state:string}>;
 documents:Array<{id:string;name:string;kind:string;bytes:number}>;
}
const minutes=usageDuration;
type Change = {action:'PROFILE';displayName:string}
 | {action:'SAVE_CONTEXT';operationId:string;id:string;kind:string;name:string;body:string}
 | {action:'DELETE_CONTEXT';operationId:string;id:string};
interface PendingChange {body:Change;form?:HTMLFormElement;uncertain?:boolean}
export function AccountWorkspace(){
 const [data,setData]=useState<Workspace|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [pending,setPending]=useState<PendingChange|null>(null),[loading,setLoading]=useState(true);
 const active=useRef(false),mounted=useRef(false),pendingRef=useRef<PendingChange|null>(null);
 const request=useRef<AbortController|null>(null),version=useRef(0);
 const refresh=useCallback(async()=>{
  if(active.current||pendingRef.current)return;
  request.current?.abort();const controller=new AbortController(),current=++version.current;
  request.current=controller;setLoading(true);setMessage('');
  try{
   const response=await fetch('/api/account/workspace',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
   if(!response.ok)throw new Error();const body=await response.json();
   if(mounted.current&&version.current===current&&!controller.signal.aborted)setData(body.workspace);
  }catch{
   if(mounted.current&&version.current===current&&!controller.signal.aborted){setData(null);setMessage('Account details are unavailable. Sign in or refresh when online.');}
  }finally{if(version.current===current){request.current=null;if(mounted.current)setLoading(false);}}
 },[]);
 useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;++version.current;request.current?.abort();request.current=null;};},[refresh]);
 async function submit(change:PendingChange){
  if(active.current||request.current||(pendingRef.current&&pendingRef.current!==change))return;
  active.current=true;pendingRef.current=change;setPending(change);setBusy(true);setMessage('');
  const controller=new AbortController(),current=++version.current;request.current=controller;
  try{
   const response=await fetch('/api/account/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(change.body),
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
   // A definite rejection proves only this attempt did not write; it cannot
   // resolve an earlier lost response for the same operation.
   if([400,413,429].includes(response.status)){
    if(mounted.current&&version.current===current&&!controller.signal.aborted){
     if(change.uncertain)setMessage('Earlier save still needs confirmation. Wait, then retry the same change.');
     else{pendingRef.current=null;setPending(null);setMessage('Change rejected before saving. Check the input size or wait before trying again.');}
    }
    return;
   }
   // An unknown outcome keeps the exact input/UUID in memory. Retrying a save
   // updates the same owned document rather than creating another document.
   if(!response.ok)throw new Error();const result=await response.json();
   if(!result.workspace?.balance||!Array.isArray(result.workspace.documents)||!Array.isArray(result.workspace.plans)||!Array.isArray(result.workspace.sessions))throw new Error();
   if(!mounted.current||version.current!==current||controller.signal.aborted)return;
   setData(result.workspace);pendingRef.current=null;setPending(null);setMessage('Saved.');
   if(change.form?.isConnected)change.form.reset();
  }catch{
   change.uncertain=true;
   if(mounted.current&&version.current===current&&!controller.signal.aborted)setMessage('Save not confirmed. Retry the same change below; do not create another copy. If you reload, inspect your documents first.');
  }finally{active.current=false;if(version.current===current){request.current=null;if(mounted.current)setBusy(false);}}
 }
 const locked=busy||loading||Boolean(pending);
 return <div aria-busy={busy||loading}><p role="status">{loading?'Loading account details…':message}</p>
  <button type="button" disabled={locked} onClick={()=>void refresh()}>Refresh balance and account</button>
  {pending?<p>A change is awaiting confirmation. Other edits are paused. <button type="button" disabled={busy} onClick={()=>void submit(pending)}>Retry the same change</button></p>:null}
  {data?<>
  <h2>Your Cluera account</h2>
  <p>Remaining {minutes(data.balance.availableMilliseconds)} · Reserved for active sessions {minutes(data.balance.reservedMilliseconds)} · Used {minutes(data.balance.spentMilliseconds)}</p>
  <p>Trial {minutes(data.balances.TRIAL??0)} · Recurring / test allowance {minutes(data.balances.RECURRING??0)} · No-expiry packs {minutes(data.balances.PACK??0)}</p>
  <p>The trial is granted once per account. Active sessions on all devices share this server balance.</p>
  <p>This is a server snapshot, not an offline countdown. Refresh after desktop use; reserved time is already excluded from remaining time.</p>
  <form onSubmit={event=>{event.preventDefault();void submit({body:{action:'PROFILE',displayName:String(new FormData(event.currentTarget).get('name')??'')}});}}>
   <label>Display name<input name="name" defaultValue={data.displayName} maxLength={80} disabled={locked}/></label><button className="button secondary" disabled={locked}>Save profile</button>
  </form>
  <h3>Plans and billing</h3>
  {data.plans.length?data.plans.map((plan,i)=><p key={i}>{plan.tier} · {plan.state} · {plan.paymentState}{plan.endsAt?` · until ${new Date(plan.endsAt).toLocaleDateString()}`:''}{plan.cancelFuture?' · renewal stopped':''}{plan.state==='PAUSED'?` · preserved ${minutes(plan.remainingMilliseconds??0)} of access time`:''}</p>):<p>No recurring paid plan is active. Staging test allowances, if granted, appear in the balance above.</p>}
  <p>Sandbox checkout acceptance is blocked; do not repeat an unresolved payment attempt.</p>
  <h3>Recent AI sessions</h3>
  {data.sessions.length?<ul>{data.sessions.map((session,i)=><li key={i}>{new Date(session.startedAt).toLocaleString()} · {session.state}</li>)}</ul>:<p>No account-managed AI sessions yet.</p>}
  <h3>Private context</h3><p>Save résumé text, a job description, supporting context or instructions. Text only here, up to 120 KB per document and 20 documents. In the account desktop, Settings → Selected account context also imports PDF/DOCX/TXT/Markdown as extracted text. Only documents you explicitly select there contribute bounded excerpts to future answers. Original files are not stored in the cloud.</p>
  <form onSubmit={event=>{event.preventDefault();if(pendingRef.current||active.current||request.current)return;const form=event.currentTarget,values=new FormData(form);void submit({body:{action:'SAVE_CONTEXT',operationId:crypto.randomUUID(),id:crypto.randomUUID(),kind:String(values.get('kind')),name:String(values.get('name')),body:String(values.get('body'))},form});}}>
   <label>Category<select name="kind" disabled={locked}><option value="RESUME">Résumé</option><option value="JOB_DESCRIPTION">Job description</option><option value="SUPPORTING">Supporting context</option><option value="INSTRUCTIONS">Instructions</option></select></label>
   <label>Name<input name="name" required maxLength={120} disabled={locked}/></label><label>Text<textarea name="body" required maxLength={120000} rows={5} disabled={locked}/></label>
   <button className="button secondary" disabled={locked}>Save private context</button>
  </form>
  <ul>{data.documents.map(doc=><li key={doc.id}>{doc.name} · {doc.kind} · {doc.bytes} bytes <button type="button" disabled={locked} onClick={()=>void submit({body:{action:'DELETE_CONTEXT',operationId:crypto.randomUUID(),id:doc.id}})}>Delete</button></li>)}</ul>
  <p><a href="/account/download">Cluera TEST download / updates</a> · <a href="/account/admin">Cluera administration</a></p>
  <p>The Cluera TEST installer has its own installation and update trust. A download is available only after explicit Cluera release approval.</p>
 </>:!loading?<p>No verified account snapshot is available. <a href="/account">Return to sign in</a>.</p>:null}</div>;
}
