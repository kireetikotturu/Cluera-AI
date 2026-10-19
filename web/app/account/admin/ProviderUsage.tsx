'use client';
import {useEffect,useRef,useState} from 'react';
import type {ProviderUsageReport} from '../../../lib/aiProviders/usageMetadata';
import {readProviderUsage} from '../../../lib/aiProviders/readUsage';
export function ProviderUsage({disabled=false}:{disabled?:boolean}){
 const [report,setReport]=useState<ProviderUsageReport|null>(null),[message,setMessage]=useState('Read recorded metadata explicitly. Report access and collection have separate server controls.'),[busy,setBusy]=useState(false);
 const owner=useRef<AbortController|null>(null),alive=useRef(true),generation=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;++generation.current;owner.current?.abort();};},[]);
 useEffect(()=>{if(disabled){++generation.current;owner.current?.abort();owner.current=null;setReport(null);setBusy(false);}},[disabled]);
 async function read(){
  if(disabled||owner.current)return;setBusy(true);setReport(null);
  const controller=new AbortController(),version=++generation.current;owner.current=controller;
  const current=()=>alive.current&&generation.current===version;
  try{
   const result=await readProviderUsage(controller);
   if(!current())return;
   if(result.status!==200||!result.report){setMessage(result.status===503?'Usage reporting is disabled or unavailable. No provider request was started.':'A current verified Admin and MFA session is required.');return;}
   setReport(result.report);setMessage('Latest 50 recorded requests only. Missing terminal receipts remain unconfirmed; these are not invoice totals.');
  }catch{if(current())setMessage('Usage metadata could not be verified. No automatic retry was attempted.');}
  finally{if(owner.current===controller)owner.current=null;if(current())setBusy(false);}
 }
 return <section aria-labelledby="provider-usage-title" aria-busy={busy}>
  <h3 id="provider-usage-title">Provider usage metadata</h3><p role="status">{message}</p>
  <p>Cost unavailable: no verified provider rate or invoice reconciliation is configured. A token count, audio window or missing receipt never means zero cost. Prompts, screenshots, transcripts and credential values are excluded.</p>
  <button disabled={disabled||busy} onClick={()=>void read()}>{busy?'Reading usage…':'Read provider usage'}</button>
  {report&&<div className="account-table-scroll"><table><caption>Latest {report.rows.length} recorded requests, maximum 50</caption><thead><tr><th>Provider / model</th><th>Started</th><th>Outcome</th><th>Reported tokens</th><th>Audio window</th><th>Cost</th></tr></thead><tbody>
   {report.rows.map(row=><tr key={row.operationId}><td>{row.provider} / {row.model}</td><td>{new Date(row.startedAt).toLocaleString()}</td><td>{row.outcome}</td><td>{row.totalTokens===null?'Unavailable':row.totalTokens}</td><td>{row.audioWindowMilliseconds===null?'Unavailable':`${row.audioWindowMilliseconds} ms (not billed duration)`}</td><td>Unavailable</td></tr>)}
  </tbody></table>{report.rows.length===0&&<p>No recorded requests in this view. This does not prove zero provider usage or cost.</p>}</div>}
 </section>;
}
