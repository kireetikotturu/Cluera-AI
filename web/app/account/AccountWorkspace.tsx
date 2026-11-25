'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {usageDuration} from '../../lib/usage/display';
import {AdminRoleLink} from './AdminRoleNavigation';
import styles from '../cluera-commerce.module.css';
interface Workspace {
 displayName:string;
 balance:{availableMilliseconds:number;reservedMilliseconds:number;spentMilliseconds:number};
 balances:Partial<Record<'TRIAL'|'RECURRING'|'PACK',number>>;
 plans:Array<{tier:string;state:string;endsAt:string|null;remainingMilliseconds:number|null;paymentState:string;cancelFuture:boolean;graceUntil:string|null}>;
 sessions:Array<{startedAt:string;state:string}>;
 documents:Array<{id:string;name:string;kind:string;bytes:number}>;
}
const minutes=usageDuration;
const nice=(value:string)=>value.toLowerCase().replace(/_/g,' ').replace(/^./,letter=>letter.toUpperCase());
const kindName:Record<string,string>={RESUME:'Résumé',JOB_DESCRIPTION:'Job description',SUPPORTING:'Supporting context',INSTRUCTIONS:'Instructions'};
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
 return <div className={`${styles.dashboard} acct-dash`} aria-busy={busy||loading}>
  <p role="status" className="acct-status" data-empty={!(loading||message)||undefined}>{loading?'Loading account details…':message}</p>
  {loading&&!data?<div className="acct-skeleton" aria-hidden="true"><span/><span/><span/></div>:null}
  {pending?<div className="acct-notice" role="alert"><p>A change is awaiting confirmation. Other edits are paused.</p><button type="button" className="acct-btn" disabled={busy} onClick={()=>void submit(pending)}>Retry the same change</button></div>:null}
  {data?<>
  <a className="acct-live mobile-only" href="/account/live"><span><strong>Start a live session</strong><small>Answers on this phone. The microphone listens and answers by itself.</small></span><em aria-hidden="true">›</em></a>
  <section className="acct-hero" aria-label="Your time">
   <div className="acct-hero-top"><h3>Your Cluera account</h3>
    <button type="button" className="acct-ghost" disabled={locked} onClick={()=>void refresh()}><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>Refresh balance and account</button></div>
   <dl className="acct-stats">
    <div className="acct-stat acct-stat-main"><dt>Remaining time</dt><dd>{minutes(data.balance.availableMilliseconds)}</dd><small>Shared across all your devices</small></div>
    {data.balance.reservedMilliseconds>0?<div className="acct-stat"><dt>Reserved for active sessions</dt><dd>{minutes(data.balance.reservedMilliseconds)}</dd></div>:null}
    <div className="acct-stat"><dt>Used</dt><dd>{minutes(data.balance.spentMilliseconds)}</dd></div>
   </dl>
   {(data.balances.TRIAL??0)+(data.balances.RECURRING??0)+(data.balances.PACK??0)>0?<div className="acct-sources" aria-label="Where your time comes from">
    {(data.balances.TRIAL??0)>0?<span>Free trial · {minutes(data.balances.TRIAL??0)}</span>:null}
    {(data.balances.RECURRING??0)>0?<span>Monthly plan · {minutes(data.balances.RECURRING??0)}</span>:null}
    {(data.balances.PACK??0)>0?<span>Time packs · {minutes(data.balances.PACK??0)}</span>:null}
   </div>:null}
   <nav className="acct-actions" aria-label="Billing shortcuts"><a className="acct-primary" href="/account/checkout?offer=cluera_pack_3h_v2">Buy more time</a><a className="acct-secondary" href="/pricing">Compare plans</a><a className="acct-secondary" href="/account/checkout#billing-history">Billing history</a><a className="acct-secondary" href="/account/download">Download Cluera AI for Windows</a></nav>
  </section>
  <div className="acct-grid">
   <section className="acct-card" aria-label="Profile">
    <h3>Profile</h3>
    <form onSubmit={event=>{event.preventDefault();void submit({body:{action:'PROFILE',displayName:String(new FormData(event.currentTarget).get('name')??'')}});}}>
     <label>Display name<input name="name" defaultValue={data.displayName} maxLength={80} disabled={locked} placeholder="Your name"/></label><button className="acct-btn" disabled={locked}>Save profile</button>
    </form>
   </section>
   <section className="acct-card" aria-label="Your plan">
    <h3>Your plan</h3>
    {data.plans.length?<ul className="acct-rows">{data.plans.map((plan,i)=><li key={i}><span><strong>{nice(plan.tier)}</strong><small>{plan.endsAt?`Until ${new Date(plan.endsAt).toLocaleDateString()}`:'No end date'}{plan.cancelFuture?' · renewal stopped':''}{plan.state==='PAUSED'?` · ${minutes(plan.remainingMilliseconds??0)} of access time kept`:''}</small></span><em>{nice(plan.state)}</em></li>)}</ul>
     :<p className="acct-empty">Pay as you go. Your free trial and time packs appear above, and packs never expire.</p>}
    <p className="acct-hint">Paid but your time has not arrived? <a href="/account/checkout">Check your payment</a>.</p>
   </section>
   <section className="acct-card" aria-label="Recent sessions">
    <h3>Recent sessions</h3>
    {data.sessions.length?<ul className="acct-rows">{data.sessions.map((session,i)=><li key={i}><span><strong>{new Date(session.startedAt).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</strong><small>{new Date(session.startedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</small></span><em>{nice(session.state)}</em></li>)}</ul>
     :<p className="acct-empty">No sessions yet. Open the Windows app and start one when your interview begins.</p>}
   </section>
  </div>
  <section className="acct-card acct-wide" aria-label="Résumé and notes">
   <h3>Résumé and notes</h3>
   <p className="acct-hint">Save your résumé, the job description and any notes here. In the Windows app you choose which ones to use for your answers. Text only, up to 120 KB each.</p>
   <form onSubmit={event=>{event.preventDefault();if(pendingRef.current||active.current||request.current)return;const form=event.currentTarget,values=new FormData(form);void submit({body:{action:'SAVE_CONTEXT',operationId:crypto.randomUUID(),id:crypto.randomUUID(),kind:String(values.get('kind')),name:String(values.get('name')),body:String(values.get('body'))},form});}}>
    <div className="acct-form-row"><label>Category<select name="kind" disabled={locked}><option value="RESUME">Résumé</option><option value="JOB_DESCRIPTION">Job description</option><option value="SUPPORTING">Supporting context</option><option value="INSTRUCTIONS">Instructions</option></select></label>
    <label>Name<input name="name" required maxLength={120} disabled={locked} placeholder="For example: My résumé"/></label></div>
    <label>Text<textarea name="body" required maxLength={120000} rows={5} disabled={locked} placeholder="Paste the text here"/></label>
    <button className="acct-btn acct-btn-primary" disabled={locked}>Save private context</button>
   </form>
   {data.documents.length?<ul className="acct-rows acct-docs">{data.documents.map(doc=><li key={doc.id}><span><strong>{doc.name}</strong><small>{kindName[doc.kind]??nice(doc.kind)} · {Math.max(1,Math.round(doc.bytes/1024))} KB</small></span><button type="button" className="acct-danger" disabled={locked} onClick={()=>void submit({body:{action:'DELETE_CONTEXT',operationId:crypto.randomUUID(),id:doc.id}})}>Delete</button></li>)}</ul>:null}
  </section>
  <p className="acct-foot"><AdminRoleLink>Cluera administration</AdminRoleLink></p>
 </>:!loading?<div className="acct-card acct-empty-state"><p>No verified account snapshot is available.</p><p><a href="/account">Return to sign in</a> or press the button below to try again.</p><button type="button" className="acct-btn" disabled={locked} onClick={()=>void refresh()}>Refresh balance and account</button></div>:null}</div>;
}
