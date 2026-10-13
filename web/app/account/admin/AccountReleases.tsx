'use client';
import {useEffect,useRef,useState} from 'react';
import {releaseErrorMessage} from '@/lib/accounts/releaseErrors';
type Release={id:string;version:string;state:string;downloadUrl:string;sha256:string;fileSizeBytes:number;releaseNotes:string};
/** Account-only approval. Unknown mutation outcomes retain the exact UUID/body. */
export function AccountReleases(){
 const [rows,setRows]=useState<Release[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [pending,setPending]=useState<object|null>(null);
 const running=useRef(false),alive=useRef(true),unknown=useRef(false),operation=useRef<object|null>(null);
 const read=useRef<AbortController|null>(null);
 async function refresh(){
  read.current?.abort();const controller=new AbortController();read.current=controller;
  try{const r=await fetch('/api/account/admin?releases=1',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
   if(!r.ok)throw Error();const data=await r.json();if(data.code!=='ACTIVE'||!Array.isArray(data.releases))throw Error();
   if(alive.current&&!controller.signal.aborted)setRows(data.releases);
  }catch{if(alive.current&&!controller.signal.aborted){setRows([]);setMessage('Cluera releases unavailable. Refresh after verifying your admin session.');}}
 }
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;read.current?.abort();};},[]);
 async function execute(body:object){
  if(running.current)return;running.current=true;setBusy(true);setMessage('');read.current?.abort();
  try{const r=await fetch('/api/account/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   const data=await r.json();if(!r.ok||data.code!=='APPLIED'){
    if(!unknown.current&&([400,401,403,413,429].includes(r.status)||(r.status===409&&['RELEASE_DATABASE_INVALID','RELEASE_NOT_FOUND','RELEASE_CONFLICT'].includes(data.error)))){
     operation.current=null;if(alive.current){setPending(null);setMessage(releaseErrorMessage(data.error)??'Release request rejected. Check the form and refresh your Admin session.');}return;
    }throw Error();
   }operation.current=null;unknown.current=false;
   if(alive.current){setPending(null);setMessage('Audited release change confirmed.');await refresh();}
  }catch{unknown.current=true;if(alive.current)setMessage('Result unconfirmed. Retry only the same operation; do not create another draft or approval.');}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 function submit(action:string,input:object,reason:string){
  if(running.current||operation.current)return;
  const body={action,operationId:crypto.randomUUID(),subjectId:null,reason,input};operation.current=body;unknown.current=false;setPending(body);void execute(body);
 }
 return <section><h2>Cluera test releases</h2><p>Separate unsigned TEST product only. Upload the Cluera installer, independently verify its downloaded hash/size, then approve here. No legacy release is modified.</p>
 <p role="status">{message}</p><button disabled={busy} onClick={()=>void refresh()}>Refresh Cluera releases</button>
 {pending?<button disabled={busy} onClick={()=>void execute(pending)}>Verify/retry same release operation</button>:null}
 <fieldset disabled={busy||!!pending}><legend>Create immutable draft</legend><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);submit('RELEASE_DRAFT',{
  version:String(f.get('version')).trim(),minimumSupportedVersion:String(f.get('minimum')).trim(),downloadUrl:String(f.get('url')).trim(),sha256:String(f.get('sha256')).trim().toLowerCase(),
  fileSizeBytes:Number(f.get('size')),updateType:String(f.get('policy')),releaseNotes:String(f.get('notes'))},String(f.get('reason')).trim());}}>
 <label>Cluera version<input name="version" required pattern="[0-9]+\.[0-9]+\.[0-9]+"/></label>
 <label>Minimum Cluera version<input name="minimum" required pattern="[0-9]+\.[0-9]+\.[0-9]+"/></label>
 <label>Cluera installer HTTPS URL<input name="url" type="url" required maxLength={1000}/></label>
 <label>SHA-256<input name="sha256" required pattern="[a-fA-F0-9]{64}"/></label>
 <label>Exact byte size<input name="size" type="number" min={1} max={536870912} required/></label>
 <label>Update policy<select name="policy"><option>OPTIONAL</option><option>RECOMMENDED</option><option>REQUIRED</option></select></label>
 <label>Release notes<textarea name="notes" maxLength={2000}/></label>
 <label>Audit reason<input name="reason" required minLength={10} maxLength={500}/></label><button>Create Cluera draft</button></form></fieldset>
 {rows.map(r=><fieldset key={r.id} disabled={busy||!!pending}><legend>{r.version} — {r.state}</legend><p>{r.downloadUrl}</p><p>{r.sha256} · {r.fileSizeBytes} bytes</p><p>{r.releaseNotes}</p>
 {r.state==='DRAFT'?<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);submit('RELEASE_PUBLISH',{id:r.id,verifiedHostedSha256:String(f.get('hash')).trim().toLowerCase(),verifiedFileSizeBytes:Number(f.get('bytes')),confirmedAccountInstaller:f.get('confirmed')==='on'},String(f.get('reason')).trim());}}>
 <label>Independently downloaded SHA-256<input name="hash" required pattern="[a-fA-F0-9]{64}"/></label><label>Downloaded byte size<input name="bytes" type="number" min={1} required/></label>
 <label><input name="confirmed" type="checkbox" required/> I verified the separate Cluera TEST installer and its identity; it is not a SigmaRound installer.</label>
 <label>Approval reason<input name="reason" required minLength={10} maxLength={500}/></label><button>Publish account TEST release</button></form>:null}
 {r.state==='PUBLISHED'?<form onSubmit={e=>{e.preventDefault();submit('RELEASE_WITHDRAW',{id:r.id},String(new FormData(e.currentTarget).get('reason')));}}><label>Withdrawal reason<input name="reason" required minLength={10} maxLength={500}/></label><button>Withdraw account release</button></form>:null}</fieldset>)}
 <p><a href="/api/cluera/update/test">Cluera signed test feed</a> · <a href="/account/download">Latest approved Cluera test download</a></p></section>;
}
