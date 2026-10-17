'use client';
import {useEffect,useRef,useState} from 'react';
import type {ProviderStatus as Snapshot} from '../../../lib/accountRelay/providerMetadata';

/** Explicit admin-only snapshot. No polling and never infer configuration from
 * a reachable health check or from a locally selected model. */
export function ProviderStatus(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
 const active=useRef<AbortController|null>(null);
 const vaultMode=snapshot?.bootstrapMode==='admin-vault',authOnly=snapshot?.bootstrapMode==='auth-only';
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
  <h2 id="provider-status-heading">Legacy relay configuration snapshot</h2>
  <p>This authenticated read describes legacy environment configuration, not the current encrypted provider vault. It does not test provider access or spend account time. Never enter credentials in this status panel.</p>
  <button disabled={busy} onClick={()=>void refresh()}>{busy?'Checking configuration…':'Check provider configuration'}</button>
  <p role="status">{failed?'Configuration unknown: the authenticated relay snapshot is unavailable. No status was inferred.':snapshot?`Relay snapshot: ${snapshot.observedAt}`:'Configuration has not been checked.'}</p>
  {vaultMode?<p>Admin-vault mode is selected. This legacy snapshot does not report current vault credentials or enablement. Use <a href="#account-admin-providers">AI Providers &amp; Models</a> for explicit vault metadata and audited controls. Provider health is not verified by this snapshot.</p>:authOnly?<p>Auth-only bootstrap is active; AI START remains blocked. Use <a href="#account-admin-providers">AI Providers &amp; Models</a> only after the separate secure vault bootstrap. No current vault state is inferred here.</p>:null}
  {!vaultMode&&!authOnly?snapshot?.providers.map(item=><div key={item.provider}>
   <h3>{item.provider==='gemini'?'Gemini':'Deepgram (internal audio)'}</h3>
   <p>{item.configured?'Configured':'Not configured'} · {item.enabled?'Relay enabled':'Relay disabled'} · Provider health not verified</p>
   <p>Safe credential fingerprint: {item.fingerprint??'Unavailable'} · Last rotation: unknown</p>
  </div>):null}
  <p>Model availability is controlled separately in the model registry. Legacy "Configured" confirms loaded environment configuration only, not vault state, key validity, quota or a successful provider call. Legacy fingerprints change if the shared signing secret changes.</p>
  {!vaultMode&&!authOnly?<><button disabled>Rotate credentials - owner-managed only</button><p>Automatic environment-key rotation is not connected. Do not replace or migrate credentials from a status observation; follow the approved custody procedure. Encrypted provider management belongs in <a href="#account-admin-providers">AI Providers &amp; Models</a>.</p></>:null}
 </section>;
}
