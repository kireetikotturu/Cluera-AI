'use client';

import {useEffect,useId,useRef,useState} from 'react';
import {z} from 'zod';
import {clueraBillingHistorySchema,type ClueraBillingHistory as History} from '../../../lib/payments/cluera/historyContracts';
import {clueraPrice} from '../../../lib/payments/cluera/publicCatalog';
import {usageDuration} from '../../../lib/usage/display';
import styles from '../../cluera-commerce.module.css';
import SubscriptionCancellation from './SubscriptionCancellation';

const envelope=z.object({history:clueraBillingHistorySchema}).strict();
const endpoint='/api/account/payments/cluera/history';
const states={ACTIVE:'Active',PAST_DUE:'Payment overdue',CANCELED:'Canceled',PAUSED:'Paused'} as const;
const periodStates={ACTIVE:'Paid period',SUSPENDED:'Paused paid period',QUEUED:'Queued paid period',PRESERVED:'Saved Pro access',ENDED:'Ended period',REFUNDED:'Refunded period'}as const;
function accessWindow(milliseconds:number){
 const days=Math.floor(milliseconds/86400000),remaining=milliseconds%86400000;
 return days?`${days} ${days===1?'day':'days'}${remaining>=60000?` ${usageDuration(remaining)}`:''}`:usageDuration(milliseconds);
}

/** Optional automatic GET on a verified parent snapshot; never a mutation. Owner comes from the parent's
 * logged-in credits snapshot, never an editable customer-ID input. */
export default function ClueraBillingHistory({accountId,enabled=false,disabled=false,cancellationEnabled=false,autoLoad=false,refreshKey=0,onLoaded}:{accountId:string|null;enabled?:boolean;disabled?:boolean;cancellationEnabled?:boolean;autoLoad?:boolean;refreshKey?:number;onLoaded?:(history:History)=>void}){
 const statusId=useId(),alive=useRef(false),pending=useRef<AbortController|null>(null);
 const identity=useRef(accountId),availability=useRef(enabled),blocked=useRef(disabled);
 identity.current=accountId;availability.current=enabled;blocked.current=disabled;
 const [result,setResult]=useState<{owner:string;history:History}|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('History is not loaded. Refresh to read the current server records.');
 const validOwner=z.uuid().safeParse(accountId).success;
 useEffect(()=>{
  alive.current=true;pending.current?.abort();pending.current=null;setResult(null);setBusy(false);
  setMessage('History is not loaded. Refresh to read the current server records.');
  return()=>{alive.current=false;pending.current?.abort();pending.current=null;};
 },[accountId,enabled]);
 useEffect(()=>{if(disabled){pending.current?.abort();pending.current=null;setResult(null);setBusy(false);
  setMessage('History is not loaded. Refresh to read the current server records.');}},[disabled]);

 async function refresh(){
  if(!enabled||disabled||!validOwner||!accountId||pending.current)return;
  const owner=accountId,controller=new AbortController();pending.current=controller;setBusy(true);setResult(null);
  const owned=()=>alive.current&&pending.current===controller&&identity.current===owner&&availability.current&&!blocked.current;
  const current=()=>owned()&&!controller.signal.aborted;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let abort=()=>{};
  const expired=new Promise<never>((_,reject)=>{abort=()=>reject(Error('History unavailable.'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(),10000);});
  try{
   const url=endpoint+'?expectedAccountId='+encodeURIComponent(owner),expectedUrl=new URL(url,location.origin).href;
   const response=await Promise.race([fetch(url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Accept:'application/json'}}),expired]);
   if(!current())return;
   if(response.status===401||response.status===403){setMessage('Sign in with the matching verified Cluera account to read its history.');return;}
   if(response.status===429){setMessage('Too many history requests. Please wait before refreshing.');return;}
   if(!response.ok||response.redirected||response.url&&response.url!==expectedUrl||!response.body
    ||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'
    ||response.headers.get('cache-control')!=='no-store'||response.headers.get('x-content-type-options')!=='nosniff')throw Error('History unavailable.');
   const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>131072))throw Error('History unavailable.');
   reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>131072)throw Error('History unavailable.');chunks.push(part.value);}
   const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
   const history=envelope.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body))).history;
   if(!current())return;if(history.userId!==owner)throw Error('History unavailable.');
   setResult({owner,history});setMessage('Your billing history is up to date.');onLoaded?.(history);
  }catch{if(owned())setMessage('Billing history is unavailable. No payment action was taken; refresh later.');}
  finally{
   clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.abort();void reader?.cancel().catch(()=>{});
   try{reader?.releaseLock();}catch{/* Never wait on cancellation. */}
   if(pending.current===controller){pending.current=null;if(alive.current)setBusy(false);}
  }
 }
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 useEffect(()=>{if(autoLoad&&enabled&&!disabled&&validOwner)void refreshRef.current();},[autoLoad,enabled,disabled,validOwner,accountId,refreshKey]);
 const history=enabled&&!disabled&&validOwner&&result?.owner===accountId?result.history:null;
 const notice=!enabled?'Billing history is unavailable while its read-only setup awaits approval.'
  :!validOwner?'Sign in with a verified Cluera account to read its history.'
   :disabled?'Wait for the current account or checkout verification before refreshing history.'
    :busy?'Loading server-confirmed billing history...':message;
 return <section className={styles.history} aria-label="Cluera payment and subscription history" aria-busy={busy}>
  <h3>Cluera payment and subscription history</h3>
  <p>Only verified payments and server-confirmed subscription states from this clean Cluera project are shown. This is not a complete historical provider reconciliation.</p>
  <p id={statusId} role="status" aria-live="polite">{notice}</p>
  <button type="button" disabled={!enabled||disabled||!validOwner||busy} onClick={()=>void refresh()} aria-describedby={statusId}>Refresh billing history</button>
  {history?<>
   <h4>Verified payments</h4>
   {history.payments.length?<ul>{history.payments.map(payment=><li key={payment.paymentId}>
    <strong>{payment.revision.name}</strong> · {clueraPrice(payment.revision.amountPaise)} · {payment.state==='REFUNDED'?'Refunded':'Verified payment'}
    <p>{usageDuration(payment.revision.allowanceSeconds*1000)} · {payment.revision.kind==='PACK'?'One-time pack; no expiry':'Monthly allowance; no rollover'}</p>
    <p>{payment.paidAt?'Paid':'Checkout created'}: <time dateTime={payment.paidAt??payment.intentCreatedAt}>{new Date(payment.paidAt??payment.intentCreatedAt).toLocaleString()}</time></p>
    <p>Payment reference: <code>{payment.paymentId}</code>{payment.invoiceId?<> · Invoice reference: <code>{payment.invoiceId}</code></>:null}</p>
   </li>)}</ul>:<p>No verified payments are recorded in this project snapshot.</p>}
   {history.hasMorePayments?<p>Only the latest 50 payments are shown. Contact support for older records.</p>:null}
   {history.nativeSchedule?<section aria-label="Saved and scheduled monthly access">
    <h4>Saved and scheduled monthly access</h4>
    <p>Access windows measure calendar time. Unused allowance measures session time. Saved and queued periods contribute no spendable time until activated.</p>
    {history.nativeSchedule.terms.length?<ul>{history.nativeSchedule.terms.map(term=><li key={term.invoiceId}>
     <strong>{term.revision.name}</strong> · {periodStates[term.state]}
     <p>Spendable now from this period: {usageDuration(term.spendableMilliseconds)}.</p>
     {term.state==='PRESERVED'||term.state==='QUEUED'?<>
      <p>{term.state==='PRESERVED'?'Saved':'Queued'} access window: {accessWindow(term.savedWallMilliseconds!)}. Unused allowance: {usageDuration(term.remainingAllowanceMilliseconds)}.</p>
      <p>{term.state==='PRESERVED'?'Saved Pro access waits for a verified end of the higher-priority plan. Restoring access does not restart billing.':'This paid period waits behind current access. Its future billing schedule requires verification.'}</p>
     </>:term.startsAt&&term.endsAt?<p>Recorded access window: <time dateTime={term.startsAt}>{new Date(term.startsAt).toLocaleString()}</time> to <time dateTime={term.endsAt}>{new Date(term.endsAt).toLocaleString()}</time>.</p>:null}
     <p>Allowance used: {usageDuration(term.spentMilliseconds)}. Reserved for current sessions: {usageDuration(term.reservedMilliseconds)}.</p>
     {term.state==='SUSPENDED'?<p>This paused period currently contributes no spendable time. Its recorded expiry does not restart on resume.</p>:null}
     <p>Invoice reference: <code>{term.invoiceId}</code></p>
    </li>)}</ul>:<p>No saved or scheduled monthly periods are shown in this snapshot.</p>}
    {history.nativeSchedule.hasMoreTerms?<p>Only the latest 50 monthly periods are shown. Contact support for older records.</p>:null}
   </section>:null}
   <h4>Subscription records</h4>
   <p>A subscription status alone does not prove a paid charge; verified payments determine paid usage.</p>
   {history.subscriptions.length?<ul>{history.subscriptions.map(subscription=><li key={subscription.subscriptionId}>
    <strong>{subscription.revision.name}</strong> · {states[subscription.state]} · {clueraPrice(subscription.revision.amountPaise)} per month
    {subscription.paidThrough?<p>Paid through <time dateTime={subscription.paidThrough}>{new Date(subscription.paidThrough).toLocaleString()}</time>.</p>:null}
    {subscription.graceUntil?<p>Recorded grace ends <time dateTime={subscription.graceUntil}>{new Date(subscription.graceUntil).toLocaleString()}</time>.</p>:null}
    {subscription.cancelFuture?<p>Renewal is stopped in the current server record.</p>:null}
    {cancellationEnabled&&!subscription.cancelFuture&&subscription.state!=='CANCELED'&&accountId?<SubscriptionCancellation accountId={accountId} subscriptionId={subscription.subscriptionId} enabled={cancellationEnabled} disabled={disabled||busy}/>:null}
   </li>)}</ul>:<p>No subscription records are displayed in this project snapshot.</p>}
   {history.hasMoreSubscriptions?<p>Only the latest 50 subscriptions are shown. Contact support for older records.</p>:null}
  </>:null}
  <p>{cancellationEnabled?'Invoice downloads, refunds, pause and plan-change controls are not available here yet.':'Invoice downloads and subscription-change controls are not available here yet.'} Contact <a href="mailto:clueraaisupport@gmail.com">Cluera support</a>; never send card details, passwords or verification codes.</p>
 </section>;
}
