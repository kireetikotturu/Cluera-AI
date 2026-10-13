'use client';
import {useEffect,useRef,useState} from 'react';
import {metadataListSchema,metadataSchema,type Metadata} from '../../../lib/aiProviders/publicMetadata';

const endpoint='/api/account/admin/ai-providers';
const labels={gemini:'Google Gemini',deepgram:'Deepgram Flux',openai:'OpenAI',anthropic:'Anthropic Claude'};
type Provider=keyof typeof labels;
type Factor={id:string;status:string};
export function AiProviders({disabled=false}:{disabled?:boolean}){
 const [rows,setRows]=useState<Metadata[]>([]),[message,setMessage]=useState('Refresh to inspect the vault. No background polling.'),[busy,setBusy]=useState(false),[available,setAvailable]=useState(false),[factors,setFactors]=useState<Factor[]>([]),[pending,setPending]=useState<string|null>(null);
 const alive=useRef(true),running=useRef(false),controller=useRef<AbortController|null>(null),uncertain=useRef<string|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 const perform=async(work:(signal:AbortSignal)=>Promise<void>)=>{
  if(running.current||disabled)return;running.current=true;setBusy(true);const abort=new AbortController();controller.current=abort;
  try{await work(AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]));}
  catch{if(alive.current&&!abort.signal.aborted){setAvailable(false);setMessage('Provider administration is unavailable. No automatic retry or provider fallback was attempted.');}}
  finally{if(controller.current===abort)controller.current=null;running.current=false;if(alive.current)setBusy(false);}
 };
 const refresh=()=>perform(async signal=>{
  setAvailable(false);
  const response=await fetch(endpoint,{cache:'no-store',signal});
  if(!response.ok){if(alive.current){setAvailable(false);setRows([]);setMessage(response.status===503?'Vault bootstrap is not complete. Infrastructure, encryption keyring and approved schema are required.':'Verified Admin session and MFA are required.');}return;}
  const data=metadataListSchema.parse(await response.json());
  // Existing verified factors only. This UI never creates or changes MFA.
  if(alive.current){setRows(data.providers);setAvailable(true);setMessage('Credential values are write-only. Saved keys are never returned. Refresh is explicit.');}
 });
 const submit=(provider:Provider,form:HTMLFormElement)=>{
  if(running.current||disabled||uncertain.current||!available)return;
  const values=new FormData(form),action=String(values.get('action')),operationId=crypto.randomUUID();
  const body:Record<string,unknown>={action,provider,operationId,revision:rows.find(r=>r.provider===provider)?.revision??0,factorId:String(values.get('factor')),code:String(values.get('code'))};
  if(action==='REPLACE')body.apiKey=String(values.get('key'));
  if(action==='CONFIGURE'){body.enabled=values.get('enabled')==='on';body.defaultModel=String(values.get('model'))||null;body.fallback='NONE';}
  // Clear entry controls immediately; never keep keys/codes in React state,
  // browser storage, URL, history, console or a retained retry body.
  for(const name of ['key','code']){const field=form.elements.namedItem(name);if(field instanceof HTMLInputElement)field.value='';}
  uncertain.current=operationId;setPending(operationId);
  void perform(async signal=>{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
   if(!response.ok){
    if([400,401,403,429].includes(response.status)){uncertain.current=null;if(alive.current)setPending(null);}
    if(alive.current)setMessage('Change rejected or outcome unknown. Verify this operation before submitting another change.');return;
   }
   const data=await response.json();if(data?.code!=='APPLIED')throw Error();const row=metadataSchema.parse(data.metadata);
   uncertain.current=null;if(alive.current){setPending(null);setRows(previous=>[...previous.filter(r=>r.provider!==row.provider),row]);setMessage('Audited change confirmed. A replacement key remains disabled until tested and deliberately enabled.');}
  });
 };
 const verify=()=>perform(async signal=>{
  const op=uncertain.current;if(!op)return;
  const response=await fetch(`${endpoint}?operation=${encodeURIComponent(op)}`,{cache:'no-store',signal});if(!response.ok)throw Error();
  const data=await response.json();
  if(data?.code==='APPLIED'){const row=metadataSchema.parse(data.metadata);uncertain.current=null;if(alive.current){setPending(null);setRows(previous=>[...previous.filter(r=>r.provider!==row.provider),row]);setMessage('Original operation confirmed; no key was resubmitted.');}}
  else if(alive.current)setMessage('Original operation not confirmed. Keep this page locked and investigate; do not replace/retry blindly.');
 });
 const inspectFactors=()=>perform(async signal=>{
  const response=await fetch(`${endpoint}?factors=1`,{cache:'no-store',signal});if(!response.ok)throw Error();const data=await response.json();
  if(!Array.isArray(data?.factors)||data.factors.some((f:any)=>typeof f.id!=='string'||!/^[a-f0-9-]{36}$/.test(f.id)||f.status!=='verified'))throw Error();
  if(alive.current)setFactors(data.factors);
 });
 return <div className="ai-provider-console" aria-busy={busy}>
  <p className="account-ui-kicker">SERVER-OWNED AI CONTROL</p><h2>AI Providers &amp; Models</h2>
  <p>Encrypted credentials · fresh authenticator approval · immutable audit. Customer BYOK is disabled. OpenAI and Claude generation are not integrated or enabled.</p>
  <p role="status">{message}</p><div className="ai-provider-actions"><button disabled={disabled||busy} onClick={()=>void refresh()}>Refresh vault</button><button disabled={!available||disabled||busy||Boolean(pending)} onClick={()=>void inspectFactors()}>Load existing authenticators</button>{pending?<button disabled={disabled||busy} onClick={()=>void verify()}>Verify pending change</button>:null}</div>
  <div className="ai-provider-grid">{(Object.keys(labels) as Provider[]).map(provider=>{const row=rows.find(r=>r.provider===provider),compatible=row?.models.filter(m=>m.runtimeCompatible)??[];return <article className="ai-provider-card" key={provider}>
   <header><h3>{labels[provider]}</h3><span>{row?.enabled?'Enabled':row?.credentialPresent?'Key saved · disabled':'Not configured'}</span></header>
   <p>Metadata access: {row?.probeStatus??'UNVERIFIED'}{row?.probeAt?` · ${new Date(row.probeAt).toLocaleString()}`:''}</p>
   <p>{provider==='openai'||provider==='anthropic'?'Future generation adapter; no automatic use.':'Preserves the existing managed transport and shared usage ledger.'}</p>
   <form onSubmit={event=>{event.preventDefault();submit(provider,event.currentTarget);}}>
    <fieldset disabled={disabled||busy||!available||Boolean(pending)||!factors.length}>
     <legend>Write-only configuration</legend>
     <label>Action<select name="action"><option value="REPLACE">Add / replace key (disables provider)</option><option value="TEST">Test metadata access / discover models</option><option value="CONFIGURE">Save enablement / default model</option></select></label>
     <label>New API key (replacement only)<input name="key" type="password" autoComplete="off" maxLength={4096} spellCheck={false}/></label>
     <label>Compatible default model<select name="model" defaultValue={row?.defaultModel??''} key={row?.revision??0}><option value="">No model selected</option>{compatible.map(m=><option key={m.id} value={m.id}>{m.id}</option>)}</select></label>
     <label><input name="enabled" type="checkbox" defaultChecked={row?.enabled??false} key={`enabled:${row?.revision??0}`} disabled={provider==='openai'||provider==='anthropic'}/> Enable this provider</label>
     <label>Existing authenticator<select name="factor" required><option value="">Choose authenticator</option>{factors.map((factor,i)=><option key={factor.id} value={factor.id}>Authenticator {i+1}</option>)}</select></label>
     <label>Fresh six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>
     <button>Confirm audited change</button>
    </fieldset>
   </form><p>Fallback: none. Discovered models are not automatically approved. Metadata tests do not prove streaming quality, billing permissions or actual availability.</p>
  </article>;})}</div>
  <p>Usage/cost telemetry: not activated. No estimated invoice total or zero-cost claim is shown. Prices, balances and payment controls are unchanged.</p>
 </div>;
}
