'use client';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import type {ResumeList,ResumeRow} from '../../../lib/accounts/adminResumes';
import './ai-costs.css';
import './admin-data.css';

/** The free plan's file storage, for the storage meter. */
const FREE_STORAGE_BYTES=1024*1024*1024;
const KINDS:Record<string,string>={PDF:'PDF',DOCX:'Word',TEXT:'Text',MARKDOWN:'Markdown',TYPED:'Typed text'};
const SOURCES:Record<string,string>={phone:'Phone',windows:'Windows app'};

export function fileSize(bytes:number):string{
 if(bytes<1024)return `${bytes} B`;
 if(bytes<1024*1024)return `${Math.round(bytes/1024)} KB`;
 return `${(bytes/1024/1024).toFixed(bytes<10*1024*1024?1:0)} MB`;
}
/** How much smaller the stored copy of a file is, or nothing when it was kept as it was. */
export function saved(original:number,stored:number):string{
 return original>0&&stored<original*0.99?`${Math.round((1-stored/original)*100)}% smaller than ${fileSize(original)}`:'';
}
const when=(iso:string)=>iso?new Date(iso).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}):'—';

export function ResumeTotals({totals}:{totals:ResumeList['totals']}){
 const share=Math.min(100,totals.fileBytes/FREE_STORAGE_BYTES*100);
 return <div className="ai-tiles">
  <div className="ai-tile"><span>Résumés saved</span><strong>{totals.resumes.toLocaleString('en-IN')}</strong><small>From {totals.customers} {totals.customers===1?'customer':'customers'} · {totals.files} {totals.files===1?'file':'files'}</small></div>
  <div className="ai-tile"><span>File storage used</span><strong>{fileSize(totals.fileBytes)}</strong><div className="data-meter" aria-hidden="true"><span style={{width:totals.fileBytes?`max(3px, ${share}%)`:0}}/></div><small>{share<0.1?'Under 0.1%':`${share.toFixed(1)}%`} of the 1 GB in Supabase’s free plan</small></div>
  <div className="ai-tile"><span>Saved by compression</span><strong>{totals.originalFileBytes>totals.fileBytes?fileSize(totals.originalFileBytes-totals.fileBytes):'0 B'}</strong><small>{totals.originalFileBytes?`Files uploaded: ${fileSize(totals.originalFileBytes)} → stored: ${fileSize(totals.fileBytes)}`:'No files yet'}</small></div>
 </div>;
}

export function ResumeTable({rows,busy,onView,onDownload,onDelete,confirming,onConfirm}:{rows:ResumeRow[];busy:boolean;confirming:string;
 onView(row:ResumeRow):void;onDownload(row:ResumeRow):void;onConfirm(id:string):void;onDelete(row:ResumeRow):void}){
 return <div className="usage-table-wrap"><table className="usage-table data-table"><thead><tr><th>Customer</th><th>Résumé</th><th>Stored size</th><th>Used in</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
  <tbody>{rows.map(row=><tr key={row.id}>
   <td className="wrap">{row.email||'Customer'}</td>
   <td className="wrap"><strong>{row.name}</strong><small>{KINDS[row.kind]??row.kind}</small></td>
   <td>{fileSize(row.storedBytes)}<small>{row.hasFile?saved(row.originalBytes,row.storedBytes)||'Original kept':'Text only'}</small></td>
   <td>{row.sessions} {row.sessions===1?'session':'sessions'}<small>{SOURCES[row.source]??row.source} · {when(row.lastUsedAt)}</small></td>
   <td>{confirming&&confirming===row.id?<div className="data-actions" role="group" aria-label={`Delete ${row.name}?`}><span>Delete for good?</span><button type="button" className="data-danger" disabled={busy} onClick={()=>onDelete(row)}>Delete</button><button type="button" disabled={busy} onClick={()=>onConfirm('')}>Keep</button></div>
    :<div className="data-actions"><button type="button" disabled={busy} onClick={()=>onView(row)}>View text</button><button type="button" disabled={busy} onClick={()=>onDownload(row)}>Download</button><button type="button" className="data-danger" disabled={busy} onClick={()=>onConfirm(row.id)}>Delete</button></div>}</td>
  </tr>)}</tbody></table></div>;
}

/** Saves text the server returned as a file on this computer. */
function saveText(name:string,text:string){
 const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');
 link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1_000);
}

export function AdminData({active,disabled=false}:{active:boolean;disabled?:boolean}){
 const [list,setList]=useState<ResumeList|null>(null),[search,setSearch]=useState(''),[applied,setApplied]=useState('');
 const [message,setMessage]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[confirming,setConfirming]=useState('');
 const [viewing,setViewing]=useState<{row:ResumeRow;text:string}|null>(null),[more,setMore]=useState(false);
 const version=useRef(0),removal=useRef<{id:string;operationId:string}|null>(null);
 const viewer=useRef<HTMLElement>(null);

 const load=useCallback(async(query:string,after?:ResumeRow)=>{
  const mine=++version.current;setLoading(true);
  try{
   const params=new URLSearchParams({data:'resumes'});if(query)params.set('query',query);
   if(after){params.set('before',after.lastUsedAt);params.set('beforeId',after.id);}
   const response=await fetch(`/api/account/admin?${params}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error(String(response.status));
   const data=await response.json() as ResumeList;
   if(mine!==version.current)return;
   if(!data?.totals||!Array.isArray(data.rows))throw new Error('shape');
   setList(current=>after&&current?{totals:data.totals,rows:[...current.rows,...data.rows]}:data);setMore(data.rows.length===50);setMessage('');
  }catch{if(mine===version.current)setMessage('Résumés could not be loaded just now. Press Refresh to try again.');}
  finally{if(mine===version.current)setLoading(false);}
 },[]);
 useEffect(()=>{if(active)void load(applied);},[active,applied,load]);

 const post=async(body:object,opening:boolean)=>{
  const response=await fetch(`/api/account/admin${opening?'?open=resume':''}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(response.status===404?'gone':response.status===429?'busy':'failed');
  return data as {url?:string;text?:string;name?:string;code?:string};
 };
 const explain=(error:unknown)=>error instanceof Error&&error.message==='gone'?'That résumé no longer exists. Press Refresh.':error instanceof Error&&error.message==='busy'?'Too many requests. Wait a few minutes.':'That did not work. Try again.';
 const open=async(row:ResumeRow,mode:'TEXT'|'FILE')=>{
  setBusy(true);setMessage('');
  try{
   const data=await post({action:'RESUME_OPEN',id:row.id,mode},true);
   if(mode==='TEXT'){setViewing({row,text:data.text??''});setTimeout(()=>viewer.current?.focus(),0);}
   else if(data.url){const link=document.createElement('a');link.href=data.url;link.rel='noopener noreferrer';link.click();}
   else saveText(data.name??'resume.txt',data.text??'');
  }catch(error){setMessage(explain(error));}finally{setBusy(false);}
 };
 const remove=async(row:ResumeRow)=>{
  setBusy(true);setMessage('');
  // The same operation id is reused if this delete is retried, so History records it once.
  if(removal.current?.id!==row.id)removal.current={id:row.id,operationId:crypto.randomUUID()};
  try{
   const data=await post({action:'RESUME_DELETE',operationId:removal.current.operationId,subjectId:row.userId,reason:'Deleted from the Admin Data section',input:{id:row.id}},false);
   if(data.code!=='APPLIED')throw new Error('failed');
   removal.current=null;setConfirming('');if(viewing?.row.id===row.id)setViewing(null);
   await load(applied);setMessage(`Deleted “${row.name}”.`);
  }catch(error){setMessage(explain(error));}finally{setBusy(false);}
 };
 const submit=(event:FormEvent)=>{event.preventDefault();const next=search.trim();if(next===applied)void load(next);else setApplied(next);};

 return <section className="account-admin-section admin-data" aria-labelledby="admin-data-heading">
  <div><p className="account-ui-kicker">DATA</p><h2 id="admin-data-heading">Résumés</h2>
   <p>Résumés customers used when creating sessions. Files are compressed and kept in private storage. Every view, download and delete is recorded in History.</p></div>
  {list?<ResumeTotals totals={list.totals}/>:null}
  <form className="data-search" onSubmit={submit} role="search">
   <input type="search" aria-label="Search by customer email or file name" placeholder="Search by customer email or file name" value={search} maxLength={200} onChange={event=>setSearch(event.target.value)}/>
   <button type="submit" disabled={loading}>Search</button>
   <button type="button" disabled={loading} onClick={()=>void load(applied)}>{loading?'Loading…':'Refresh'}</button>
  </form>
  {message?<p role="status" className="data-message">{message}</p>:null}
  {list?list.rows.length?<ResumeTable rows={list.rows} busy={busy||disabled} confirming={confirming} onConfirm={setConfirming}
     onView={row=>void open(row,'TEXT')} onDownload={row=>void open(row,'FILE')} onDelete={row=>void remove(row)}/>
    :<p className="account-admin-empty">{applied?'No résumés match that search.':'No résumés yet. They appear here when customers create sessions with a résumé.'}</p>:null}
  {list&&more?<button type="button" disabled={loading} onClick={()=>void load(applied,list.rows[list.rows.length-1])}>Show more</button>:null}
  {viewing?<article ref={viewer} tabIndex={-1} className="data-viewer" aria-label={`Text of ${viewing.row.name}`}>
   <header><div><strong>{viewing.row.name}</strong><small>{viewing.row.email}</small></div><button type="button" onClick={()=>setViewing(null)}>Close</button></header>
   <pre>{viewing.text||'No text was read from this file.'}</pre>
  </article>:null}
 </section>;
}
