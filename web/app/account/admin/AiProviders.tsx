'use client';
import {useEffect,useRef,useState} from 'react';
import {metadataListSchema,metadataSchema,operationStatusSchema,type Metadata,type PendingOperation} from '../../../lib/aiProviders/publicMetadata';
import {ProviderUsage} from './ProviderUsage';
import type {ModelPolicy} from './ModelPolicyEditor';

const endpoint='/api/account/admin/ai-providers';
const labels={gemini:'Google Gemini',deepgram:'Deepgram Flux',openai:'OpenAI',anthropic:'Anthropic Claude'};
type Provider=keyof typeof labels;
type Factor={id:string;status:string};
export function AiProviders({disabled=false,models}:{disabled?:boolean;models?:ModelPolicy[]}){
 const [rows,setRows]=useState<Metadata[]>([]),[message,setMessage]=useState('Refresh to inspect the vault. No background polling.'),[busy,setBusy]=useState(false),[available,setAvailable]=useState(false),[factors,setFactors]=useState<Factor[]>([]),[pending,setPending]=useState<PendingOperation|null>(null),[retryAllowed,setRetryAllowed]=useState(false);
 const [actions,setActions]=useState<Partial<Record<Provider,string>>>({});
 const alive=useRef(true),running=useRef(false),controller=useRef<AbortController|null>(null),uncertain=useRef<PendingOperation|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{if(disabled){controller.current?.abort();setFactors([]);setRetryAllowed(false);setAvailable(false);}},[disabled]);
 const perform=async(work:(signal:AbortSignal)=>Promise<void>)=>{
  if(running.current||disabled)return;running.current=true;setBusy(true);const abort=new AbortController();controller.current=abort;
  let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;abort.abort();reject(Error());},15000);});
  try{await Promise.race([work(abort.signal),deadline]);}
  catch{if(alive.current&&(!abort.signal.aborted||timedOut)){setAvailable(false);setRetryAllowed(false);setMessage(uncertain.current?'The result is unknown: the request or verification did not complete. Use Verify pending change to read its status. No automatic retry was made; do not submit the key again.':'Provider administration is unavailable. Refresh to check again. No automatic retry or provider fallback was attempted.');}}
  finally{clearTimeout(timer);if(controller.current===abort)controller.current=null;running.current=false;if(alive.current)setBusy(false);}
 };
 const refresh=()=>uncertain.current?verify():perform(async signal=>{
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
  const operation:PendingOperation={operationId,provider,revision:Number(body.revision),...(action==='CONFIGURE'?{action:'CONFIGURE' as const,enabled:body.enabled as boolean,defaultModel:body.defaultModel as string|null,fallback:'NONE' as const}:{action:action as 'REPLACE'|'TEST'})};
  uncertain.current=operation;setPending(operation);setRetryAllowed(false);
  setMessage(`${action==='REPLACE'?'Saving encrypted key':action==='TEST'?'Checking provider metadata':'Saving provider settings'}… Your key and code are cleared for privacy; wait for the result below.`);
  sendChange(body,action,provider);
 };
 const sendChange=(body:Record<string,unknown>,action:string,provider:Provider,recovering=false)=>{
  void perform(async signal=>{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
   if(signal.aborted)return;
   if(!response.ok){
    if(recovering){
     setRetryAllowed(false);
     if([401,403].includes(response.status))setFactors([]);
     setMessage([401,403].includes(response.status)?'Fresh authentication was rejected. The original operation is still pending verification. Check your Admin session, verify the pending change, load authenticators and use a fresh code.':response.status===429?'Too many requests. Wait, then verify the original operation before another deliberate retry.':'Retry did not confirm the original operation. Use Verify pending change to read its current status; no new operation was created.');return;
    }
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
   const data=await response.json();
   if(recovering){if(signal.aborted)return;acceptStatus(data,true);return;}
   if(data?.code!=='APPLIED')throw Error();const row=metadataSchema.parse(data.metadata);if(row.provider!==provider)throw Error();
   if(signal.aborted)return;
   uncertain.current=null;if(alive.current){setPending(null);setRows(previous=>[...previous.filter(r=>r.provider!==row.provider),row]);setMessage(action==='REPLACE'?'Encrypted key saved. Next choose Test metadata access / discover models with a fresh code.':action==='TEST'?(row.probeStatus==='VERIFIED'&&row.complete?'Metadata check complete. Select a compatible default model, choose Save enablement / default model and enable this provider.':'Metadata check did not approve enablement. Check the provider key permissions and available models; the provider remains unavailable.'):`Provider settings saved: ${row.enabled?'enabled':'disabled'}. Check the desktop model approval below.`);}
  });
 };
 const acceptStatus=(value:unknown,fromRetry=false)=>{
  const op=uncertain.current;if(!op)return;
  const data=operationStatusSchema.parse(value);
  if(data.operationId!==op.operationId||(data.metadata&&data.metadata.provider!==op.provider))throw Error();
  if(data.code==='REJECTED'&&(!fromRetry||op.action!=='CONFIGURE'||data.metadata.revision!==op.revision))throw Error();
  if(data.code==='NOT_RECORDED'&&(data.metadata?.revision??0)!==op.revision)throw Error();
  if((data.code==='SUPERSEDED'||data.code==='APPLIED')&&data.metadata.revision<=op.revision)throw Error();
  if(!alive.current)return;
  if(data.metadata)setRows(previous=>[...previous.filter(r=>r.provider!==op.provider),data.metadata!]);
  if(data.code==='REJECTED'){
   setAvailable(true);setRetryAllowed(true);
   setMessage('This settings retry was rejected. Enablement needs a compatible default and a complete metadata test within 15 minutes. The original operation is still unconfirmed. Use Run new metadata check below with a fresh code to refresh metadata and supersede the old settings revision safely.');return;
  }
  if(data.code==='NOT_RECORDED'){
   setAvailable(true);setRetryAllowed(op.action!=='REPLACE'&&Boolean(data.metadata));
   setMessage(op.action==='TEST'&&data.metadata
    ?'No completed audit record exists for this metadata check. It may have stopped before saving or still be running. Retry metadata check below reuses this operation reference and requires a fresh authenticator code; the saved key is preserved.'
    :op.action==='CONFIGURE'&&data.metadata?'No completed audit record exists for this settings change. Review the original settings below. Retry provider settings requires fresh MFA and reuses this operation reference; it never replaces the saved key.'
    :'No completed audit record exists for this operation. Absence does not prove failure. Keep the operation reference for investigation; verify again before any key replacement or settings change.');return;
  }
  uncertain.current=null;setPending(null);setRetryAllowed(false);setAvailable(true);
  setMessage(data.code==='APPLIED'?'Original operation confirmed. Current saved settings are displayed; no key was resubmitted.':'Provider settings advanced beyond this request. Its old revision can no longer apply. Current settings are displayed; review them before a new change with fresh MFA.');
 };
 const verify=()=>perform(async signal=>{
  const op=uncertain.current;if(!op)return;
  setRetryAllowed(false);setMessage('Checking the original operation audit and current saved settings…');
  const query=new URLSearchParams({operation:op.operationId,provider:op.provider,revision:String(op.revision)});
  const response=await fetch(`${endpoint}?${query}`,{cache:'no-store',signal});
  if(signal.aborted)return;
  if(!response.ok){
   if([401,403].includes(response.status)){setFactors([]);setAvailable(false);}
   setMessage([401,403].includes(response.status)?'Operation verification requires an active Admin session and MFA. Sign in or verify Admin again, then check the same operation reference. No provider change was submitted.':response.status===429?'Operation verification is rate limited. Wait before checking again; the original operation reference is retained.':'Operation verification is temporarily unavailable. Check again using this operation reference. No key was resubmitted or provider change retried.');return;
  }
  const data=await response.json();
  if(signal.aborted)return;
  acceptStatus(data);
 });
 const retryOriginal=(form:HTMLFormElement,newMetadata=false)=>{
  const op=uncertain.current;
  if(running.current||disabled||!retryAllowed||!op||op.action==='REPLACE')return;
  const values=new FormData(form),factorId=String(values.get('factor')),code=String(values.get('code'));
  if(!factors.some(f=>f.id===factorId)||!/^\d{6}$/.test(code)){setMessage('Choose your verified authenticator and enter a fresh six-digit code. No retry was submitted.');return;}
  (form.elements.namedItem('code') as HTMLInputElement).value='';setRetryAllowed(false);
  if(newMetadata){
   if(op.action!=='CONFIGURE')return;
   // A separately approved TEST, not a replay of settings under a new ID. Both
   // operations target the same revision, so at most one can advance it. If the
   // settings win, this TEST is refused and an explicit refresh shows the result.
   const next:PendingOperation={operationId:crypto.randomUUID(),provider:op.provider,revision:op.revision,action:'TEST'};
   uncertain.current=next;setPending(next);setMessage('Checking metadata with fresh MFA. This creates a new metadata revision only if the original settings have not already changed it. No key replacement or enablement is requested.');
   sendChange({...next,factorId,code},'TEST',op.provider);return;
  }
  setMessage('Retrying only the displayed original action with fresh MFA… The saved key will not be replaced.');
  sendChange({...op,factorId,code,retry:true},op.action,op.provider,true);
 };
 const inspectFactors=()=>perform(async signal=>{
  const response=await fetch(`${endpoint}?factors=1`,{cache:'no-store',signal});if(!response.ok)throw Error();const data=await response.json();
  if(signal.aborted)return;
  if(!Array.isArray(data?.factors)||data.factors.some((f:any)=>typeof f.id!=='string'||!/^[a-f0-9-]{36}$/.test(f.id)||f.status!=='verified'))throw Error();
  if(alive.current){setFactors(data.factors);setMessage(data.factors.length?(uncertain.current?'Authenticator loaded. Review the original action and settings before any explicitly offered retry; enter a fresh code below.':'Authenticator loaded. Enter provider keys only in the password fields below. Each change needs a fresh six-digit code.'):'No verified authenticator was returned. Verify your existing Admin authenticator first.');}
 });
 return <div className="ai-provider-console" aria-busy={busy}>
  <p className="account-ui-kicker">SERVER-OWNED AI CONTROL</p><h2>AI Providers &amp; Models</h2>
  <p>Encrypted credentials · fresh authenticator approval · immutable audit. Customer BYOK is disabled. OpenAI and Claude generation are not integrated or enabled.</p>
  <p>Configure Gemini and Deepgram once here for signed-in desktop users. Access still requires an active account and remaining trial or paid time. The original trial is 15 minutes total per account.</p>
  <ol><li>Refresh vault and load your existing authenticator.</li><li>Save each key, check metadata, then select and enable its compatible default model.</li><li>Enable the same models in <a href="#account-admin-models">AI model registry</a>. Keep Gemini text and image support and Deepgram audio support.</li><li>Restart the desktop app to refresh approved models, then create a session. Provider configuration does not resolve pending payments.</li></ol>
  <p role="status">{message}</p><div className="ai-provider-actions"><button disabled={disabled||busy} onClick={()=>void refresh()}>Refresh vault</button><button disabled={(!available&&!pending)||disabled||busy} onClick={()=>void inspectFactors()}>Load existing authenticators</button>{pending?<button disabled={disabled||busy} onClick={()=>void verify()}>Verify pending change</button>:null}</div>
  {pending?<div className="ai-provider-card">
   <p>Pending operation: {labels[pending.provider]} · {pending.action==='TEST'?'Metadata check':pending.action==='REPLACE'?'Key save':'Provider settings'} · submitted revision {pending.revision}</p>
   <p>Operation reference: <code style={{overflowWrap:'anywhere'}}>{pending.operationId}</code></p>
   {retryAllowed&&pending.action!=='REPLACE'?<form aria-label={pending.action==='TEST'?'Retry original metadata check':'Retry original provider settings'} onSubmit={event=>{event.preventDefault();retryOriginal(event.currentTarget);}}>
    <fieldset disabled={disabled||busy||!factors.length}><legend>Retry original {pending.action==='TEST'?'metadata check':'provider settings'}</legend>
     {pending.action==='TEST'?<p>This retries metadata discovery only. It uses the same operation reference and saved key. It cannot select a default or enable a disabled provider.</p>:<p>Original settings: provider {pending.enabled?'enabled':'disabled'}; default model {pending.defaultModel??'none'}; fallback none. A fresh code approves only these settings using the same operation reference. The saved key is preserved.</p>}
     <label>Existing authenticator<select name="factor" required><option value="">Choose authenticator</option>{factors.map((factor,i)=><option key={factor.id} value={factor.id}>Authenticator {i+1}</option>)}</select></label>
     <label>Fresh six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>
     <button>{pending.action==='TEST'?'Retry metadata check':'Retry provider settings'}</button>
     {pending.action==='CONFIGURE'?<><p>If the original settings need a new metadata test, this separate action checks the saved key with fresh MFA. It advances the revision only if the old settings have not already applied; then review the current default and enablement separately.</p><button type="button" onClick={event=>{if(event.currentTarget.form)retryOriginal(event.currentTarget.form,true);}}>Run new metadata check</button></>:null}
    </fieldset>
   </form>:null}
  </div>:null}
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
