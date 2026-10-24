'use client';
import {useEffect,useRef,useState} from 'react';
import {metadataListSchema,metadataSchema,type Metadata} from '../../../lib/aiProviders/publicMetadata';
import {ProviderUsage} from './ProviderUsage';
import type {ModelPolicy} from './ModelPolicyEditor';

const endpoint='/api/account/admin/ai-providers';
const labels={gemini:'Google Gemini',deepgram:'Deepgram Flux',openai:'OpenAI',anthropic:'Anthropic Claude'};
type Provider=keyof typeof labels;
type Factor={id:string;status:string};
export function AiProviders({disabled=false,models}:{disabled?:boolean;models?:ModelPolicy[]}){
 const [rows,setRows]=useState<Metadata[]>([]),[message,setMessage]=useState('Refresh to inspect the vault. No background polling.'),[busy,setBusy]=useState(false),[available,setAvailable]=useState(false),[factors,setFactors]=useState<Factor[]>([]),[pending,setPending]=useState<string|null>(null);
 const [actions,setActions]=useState<Partial<Record<Provider,string>>>({});
 const alive=useRef(true),running=useRef(false),controller=useRef<AbortController|null>(null),uncertain=useRef<string|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 const perform=async(work:(signal:AbortSignal)=>Promise<void>)=>{
  if(running.current||disabled)return;running.current=true;setBusy(true);const abort=new AbortController();controller.current=abort;
  let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;abort.abort();reject(Error());},15000);});
  try{await Promise.race([work(abort.signal),deadline]);}
  catch{if(alive.current&&(!abort.signal.aborted||timedOut)){setAvailable(false);setMessage(uncertain.current?'The result is unknown. Your key and code were cleared for privacy. Use Verify pending change; do not submit the key again.':'Provider administration is unavailable. Refresh to check again. No automatic retry or provider fallback was attempted.');}}
  finally{clearTimeout(timer);if(controller.current===abort)controller.current=null;running.current=false;if(alive.current)setBusy(false);}
 };
 const refresh=()=>perform(async signal=>{
  setAvailable(false);
  const response=await fetch(endpoint,{cache:'no-store',signal});
  if(signal.aborted)return;
  if(!response.ok){if(alive.current){setAvailable(false);setRows([]);setMessage(response.status===503?'Vault bootstrap is not complete. Infrastructure, encryption keyring and approved schema are required.':'Verified Admin session and MFA are required.');}return;}
  const data=metadataListSchema.parse(await response.json());
  if(signal.aborted)return;
  // Existing verified factors only. This UI never creates or changes MFA.
  if(alive.current){setRows(data.providers);setAvailable(true);setMessage('Credential values are write-only. Saved keys are never returned. Refresh is explicit.');}
 });
 const submit=(provider:Provider,form:HTMLFormElement)=>{
  if(running.current||disabled||uncertain.current||!available)return;
  const values=new FormData(form),action=String(values.get('action')),operationId=crypto.randomUUID();
  const body:Record<string,unknown>={action,provider,operationId,revision:rows.find(r=>r.provider===provider)?.revision??0,factorId:String(values.get('factor')),code:String(values.get('code'))};
  if(action==='REPLACE')body.apiKey=String(values.get('key'));
  if(action==='CONFIGURE'){
   body.enabled=values.get('enabled')==='on';body.defaultModel=String(values.get('model')??'')||null;body.fallback='NONE';
   if(body.enabled&&!rows.find(r=>r.provider===provider)?.models.some(m=>m.runtimeCompatible&&m.id===body.defaultModel)){
    setMessage('Choose a compatible default model before enabling this provider. No change was submitted.');
    (form.elements.namedItem('model') as HTMLSelectElement|null)?.focus();return;
   }
  }
  // Clear entry controls immediately; never keep keys/codes in React state,
  // browser storage, URL, history, console or a retained retry body.
  for(const name of ['key','code']){const field=form.elements.namedItem(name);if(field instanceof HTMLInputElement)field.value='';}
  uncertain.current=operationId;setPending(operationId);
  setMessage(`${action==='REPLACE'?'Saving encrypted key':action==='TEST'?'Checking provider metadata':'Saving provider settings'}… Your key and code are cleared for privacy; wait for the result below.`);
  void perform(async signal=>{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
   if(signal.aborted)return;
   if(!response.ok){
    if(response.status===409){
     const rejection=await response.json();if(signal.aborted)return;
     // Only the server's exact, definitive refusal DTO can release this lock.
     // Transport failures, malformed responses and late bodies remain uncertain.
     if(rejection&&Object.keys(rejection).length===1&&(rejection.error==='CONFLICT'||rejection.error==='CHANGE_REJECTED')){
      uncertain.current=null;if(alive.current){setPending(null);setAvailable(false);setMessage(rejection.error==='CONFLICT'
       ?'Nothing was saved: provider settings changed. Click Refresh vault, review the latest settings and submit your change with a fresh code.'
       :'Nothing was saved: enablement requires a selected compatible default and a complete metadata test within the last 15 minutes. Click Refresh vault, check these settings and use a fresh code.');}return;
     }
    }
    if([400,401,403,429].includes(response.status)){uncertain.current=null;if(alive.current)setPending(null);}
    if(alive.current)setMessage(response.status===403?'Authentication was rejected before saving. Check your Admin session and enter a fresh authenticator code.':response.status===400?'The request was rejected before saving. Check the selected action and required fields, then enter a fresh code.':response.status===429?'Too many requests. Wait before entering a fresh code.':response.status===401?'Sign in to Admin again before making a change.':'Change rejected or outcome unknown. Verify this operation before submitting another change.');return;
   }
   const data=await response.json();if(data?.code!=='APPLIED')throw Error();const row=metadataSchema.parse(data.metadata);
   if(signal.aborted)return;
   uncertain.current=null;if(alive.current){setPending(null);setRows(previous=>[...previous.filter(r=>r.provider!==row.provider),row]);setMessage(action==='REPLACE'?'Encrypted key saved. Next choose Test metadata access / discover models with a fresh code.':action==='TEST'?(row.probeStatus==='VERIFIED'&&row.complete?'Metadata check complete. Select a compatible default model, choose Save enablement / default model and enable this provider.':'Metadata check did not approve enablement. Check the provider key permissions and available models; the provider remains unavailable.'):`Provider settings saved: ${row.enabled?'enabled':'disabled'}. Check the desktop model approval below.`);}
  });
 };
 const verify=()=>perform(async signal=>{
  const op=uncertain.current;if(!op)return;
  const response=await fetch(`${endpoint}?operation=${encodeURIComponent(op)}`,{cache:'no-store',signal});if(!response.ok)throw Error();
  const data=await response.json();
  if(signal.aborted)return;
  if(data?.code==='APPLIED'){const row=metadataSchema.parse(data.metadata);uncertain.current=null;if(alive.current){setPending(null);setRows(previous=>[...previous.filter(r=>r.provider!==row.provider),row]);setMessage('Original operation confirmed; no key was resubmitted.');}}
  else if(alive.current)setMessage('Original operation not confirmed. Keep this page locked and investigate; do not replace/retry blindly.');
 });
 const inspectFactors=()=>perform(async signal=>{
  const response=await fetch(`${endpoint}?factors=1`,{cache:'no-store',signal});if(!response.ok)throw Error();const data=await response.json();
  if(signal.aborted)return;
  if(!Array.isArray(data?.factors)||data.factors.some((f:any)=>typeof f.id!=='string'||!/^[a-f0-9-]{36}$/.test(f.id)||f.status!=='verified'))throw Error();
  if(alive.current){setFactors(data.factors);setMessage(data.factors.length?'Authenticator loaded. Enter provider keys only in the password fields below. Each change needs a fresh six-digit code.':'No verified authenticator was returned. Verify your existing Admin authenticator first.');}
 });
 return <div className="ai-provider-console" aria-busy={busy}>
  <p className="account-ui-kicker">SERVER-OWNED AI CONTROL</p><h2>AI Providers &amp; Models</h2>
  <p>Encrypted credentials · fresh authenticator approval · immutable audit. Customer BYOK is disabled. OpenAI and Claude generation are not integrated or enabled.</p>
  <p>Configure Gemini and Deepgram once here for signed-in desktop users. Access still requires an active account and remaining trial or paid time. The original trial is 15 minutes total per account.</p>
  <ol><li>Refresh vault and load your existing authenticator.</li><li>Save each key, check metadata, then select and enable its compatible default model.</li><li>Enable the same models in <a href="#account-admin-models">AI model registry</a>. Keep Gemini text and image support and Deepgram audio support.</li><li>Restart the desktop app to refresh approved models, then create a session. Provider configuration does not resolve pending payments.</li></ol>
  <p role="status">{message}</p><div className="ai-provider-actions"><button disabled={disabled||busy} onClick={()=>void refresh()}>Refresh vault</button><button disabled={!available||disabled||busy||Boolean(pending)} onClick={()=>void inspectFactors()}>Load existing authenticators</button>{pending?<button disabled={disabled||busy} onClick={()=>void verify()}>Verify pending change</button>:null}</div>
  <div className="ai-provider-grid">{(Object.keys(labels) as Provider[]).map(provider=>{const row=rows.find(r=>r.provider===provider),compatible=row?.models.filter(m=>m.runtimeCompatible)??[],action=actions[provider]??'REPLACE';
   const policy=models?.find(m=>m.provider===provider&&m.modelId===row?.defaultModel);
   const approved=policy?.enabled&&policy.health!=='UNAVAILABLE'&&policy.isDefault&&policy.capabilities.includes(provider==='deepgram'?'audio':'text')&&(provider!=='gemini'||policy.capabilities.includes('image'));
   const verified=row?.probeStatus==='VERIFIED'&&row.complete&&compatible.length>0;
   return <article className="ai-provider-card" key={provider}>
   <header><h3>{labels[provider]}</h3><span>{row?.enabled?'Enabled':row?.credentialPresent?'Key saved · disabled':'Not configured'}</span></header>
   <p>Metadata access: {row?.probeStatus??'UNVERIFIED'}{row?.probeAt?` · ${new Date(row.probeAt).toLocaleString()}`:''}</p>
   <p>{provider==='openai'||provider==='anthropic'?'Future generation adapter; no automatic use.':'Preserves the existing managed transport and shared usage ledger.'}</p>
   {(provider==='gemini'||provider==='deepgram')&&available?<p>Desktop setup: {!row?.credentialPresent?'save a key first.':!verified?'complete metadata discovery with a compatible model.':!row.enabled||!row.defaultModel?'select and enable the provider default.':models===undefined?'refresh account administration to check model approval.':!approved?'model approval required in AI model registry.':'provider and model settings are enabled in the displayed snapshots. Real text/audio still needs device verification.'}</p>:null}
   <form onSubmit={event=>{event.preventDefault();submit(provider,event.currentTarget);}}>
    <fieldset disabled={disabled||busy||!available||Boolean(pending)||!factors.length}>
     <legend>Write-only configuration</legend>
     <label>Action<select name="action" value={action} onChange={event=>{const field=event.currentTarget.form?.elements.namedItem('key');if(field instanceof HTMLInputElement)field.value='';setActions(previous=>({...previous,[provider]:event.target.value}));}}><option value="REPLACE">Add / replace key (disables provider)</option><option value="TEST" disabled={!row?.credentialPresent}>Test metadata access / discover models</option><option value="CONFIGURE" disabled={!row?.credentialPresent}>Save enablement / default model</option></select></label>
     <label>New API key (replacement only)<input name="key" type="password" autoComplete="off" minLength={20} maxLength={4096} spellCheck={false} required={action==='REPLACE'} disabled={action!=='REPLACE'}/></label>
     <label>Compatible default model<select name="model" disabled={action!=='CONFIGURE'} defaultValue={row?.defaultModel??''} key={row?.revision??0}><option value="">No model selected</option>{compatible.map(m=><option key={m.id} value={m.id}>{m.id}</option>)}</select></label>
     <label><input name="enabled" type="checkbox" defaultChecked={row?.enabled??false} key={`enabled:${row?.revision??0}`} disabled={action!=='CONFIGURE'||(!row?.enabled&&!verified)||provider==='openai'||provider==='anthropic'}/> Enable this provider</label>
     <label>Existing authenticator<select name="factor" required><option value="">Choose authenticator</option>{factors.map((factor,i)=><option key={factor.id} value={factor.id}>Authenticator {i+1}</option>)}</select></label>
     <label>Fresh six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>
     <button>{busy?'Working…':'Confirm audited change'}</button>
    </fieldset>
   </form><p>Fallback: none. Discovered models are not automatically approved. Metadata tests do not prove streaming quality, billing permissions or actual availability.</p>
  </article>;})}</div>
  <ProviderUsage disabled={disabled}/>
 </div>;
}
