'use client';
import {useEffect,useRef,useState} from 'react';
import type {ProviderStatus as Snapshot} from '../../../lib/accountRelay/providerMetadata';

/** Explicit admin-only snapshot. No polling and never infer configuration from
 * a reachable health check or from a locally selected model. */
export function ProviderStatus(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
 const active=useRef<AbortController|null>(null);
 useEffect(()=>()=>{active.current?.abort();active.current=null;},[]);
 async function refresh(){
  if(active.current)return;
  const controller=new AbortController();active.current=controller;setBusy(true);setSnapshot(null);setFailed(false);
  try{
   const response=await fetch('/api/account/admin?providers=1',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
   if(!response.ok)throw new Error();const result=await response.json();
   // MFA responses must never be mistaken for a successful metadata read.
   if(!result.providerStatus?.observedAt||!Array.isArray(result.providerStatus.providers)||result.providerStatus.providers.length!==2)throw new Error();
   if(active.current===controller&&!controller.signal.aborted)setSnapshot(result.providerStatus);
  }catch{if(active.current===controller&&!controller.signal.aborted)setFailed(true);}
  finally{if(active.current===controller){active.current=null;setBusy(false);}}
 }
 return <section aria-labelledby="provider-status-heading" aria-busy={busy}>
  <h2 id="provider-status-heading">Managed provider configuration</h2>
  <p>Credentials stay in Render private environment. This read-only status does not test provider access or spend account time.</p>
  <button disabled={busy} onClick={()=>void refresh()}>{busy?'Checking configuration…':'Check provider configuration'}</button>
  <p role="status">{failed?'Configuration unknown: the authenticated relay snapshot is unavailable. No status was inferred.':snapshot?`Relay snapshot: ${snapshot.observedAt}`:'Configuration has not been checked.'}</p>
  {snapshot?.providers.map(item=><div key={item.provider}>
   <h3>{item.provider==='gemini'?'Gemini':'Deepgram (internal audio)'}</h3>
   <p>{item.configured?'Configured':'Not configured'} · {item.enabled?'Relay enabled':'Relay disabled'} · Provider health not verified</p>
   <p>Safe credential fingerprint: {item.fingerprint??'Unavailable'} · Last rotation: unknown</p>
  </div>)}
  <p>Model availability is controlled separately in the model registry. “Configured” confirms loaded configuration, not key validity, quota or a successful provider call. Fingerprints change if the shared signing secret changes.</p>
  <button disabled>Rotate credentials — owner-managed only</button>
  <p>Automatic rotation is not connected. Privately replace keys in Render → cluera-ai-relay-staging → Environment and redeploy. Never paste keys into this page.</p>
 </section>;
}
