'use client';
import {useEffect,useRef,useState} from 'react';
import {metadataListSchema,type Metadata} from '../../../lib/aiProviders/publicMetadata';
import type {ModelPolicy} from './ModelPolicyEditor';

const endpoint='/api/account/admin/ai-providers';
const providers=[
 {id:'gemini' as const,name:'Google Gemini',model:'gemini-3.5-flash',purpose:'Answers and screenshot understanding',hint:'Create the key in Google AI Studio.'},
 {id:'deepgram' as const,name:'Deepgram',model:'flux-general-en',purpose:'Live speech-to-text',hint:'Create the key in the Deepgram console.'},
];
type Id=typeof providers[number]['id'];
type Factor={id:string};
const stopMessages:Record<string,string>={
 KEY_REJECTED:'The provider rejected this key. Check that you copied the whole key and that it is active, then try again.',
 PROVIDER_UNAVAILABLE:'The provider did not return a complete answer. The key is saved; wait a minute and run setup again with a fresh code.',
 CONFLICT:'Settings changed while you were working. Nothing more was applied. Click Check status, then run setup again.',
 CHANGE_REJECTED:'The change was refused by a safety check. Click Check status to see what was saved, then run setup again.',
};
export function AiQuickSetup({disabled=false,models,onApplied}:{disabled?:boolean;models?:ModelPolicy[];onApplied?:()=>void}){
 const [rows,setRows]=useState<Metadata[]|null>(null),[factors,setFactors]=useState<Factor[]>([]),[busy,setBusy]=useState(false);
 const [message,setMessage]=useState('Click Check status to load the current AI setup.'),[failed,setFailed]=useState(false);
 const alive=useRef(true),running=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function read(){
  const [list,auth]=await Promise.all([
   fetch(endpoint,{cache:'no-store',signal:AbortSignal.timeout(15000)}),
   fetch(`${endpoint}?factors=1`,{cache:'no-store',signal:AbortSignal.timeout(15000)}),
  ]);
  if(list.status===503)throw Object.assign(Error(),{notReady:true});
  if(!list.ok||!auth.ok)throw Error();
  const parsed=metadataListSchema.parse(await list.json()),found=await auth.json();
  if(!Array.isArray(found?.factors))throw Error();
  return {providers:parsed.providers,factors:found.factors.filter((f:{id?:unknown})=>typeof f.id==='string').map((f:{id:string})=>({id:f.id}))};
 }
 async function check(note?:string){
  if(running.current||disabled)return;running.current=true;setBusy(true);setFailed(false);
  try{
   const data=await read();if(!alive.current)return;
   setRows(data.providers);setFactors(data.factors);
   setMessage(note??(data.factors.length?'Status loaded. Paste a key below, enter the 6-digit code from your authenticator app and press Save and enable.':'No authenticator is set up for this Admin account. Add one in the Admin sign-in screen first.'));
  }catch(error){
   if(!alive.current)return;setRows(null);setFailed(true);
   setMessage((error as {notReady?:boolean}).notReady?'The encrypted key vault is not switched on for this deployment yet. Follow the "AI provider keys" steps in docs/GO_LIVE_GUIDE.md, then check again.':'Could not load the AI setup. Make sure you are signed in as Admin with your authenticator, then try again.');
  }finally{running.current=false;if(alive.current)setBusy(false);}
 }
 async function setup(id:Id,form:HTMLFormElement){
  if(running.current||disabled||!rows)return;
  const values=new FormData(form),key=String(values.get('key')??'').trim(),code=String(values.get('code')??'').trim(),factorId=String(values.get('factor')??factors[0]?.id??'');
  if(!/^[\x21-\x7e]{20,4096}$/.test(key)){setFailed(true);setMessage('That does not look like a full API key. Paste the whole key without spaces.');return;}
  if(!/^\d{6}$/.test(code)||!factorId){setFailed(true);setMessage('Enter the current 6-digit code from your authenticator app.');return;}
  // Secrets never stay in the page after submission.
  for(const name of ['key','code']){const field=form.elements.namedItem(name);if(field instanceof HTMLInputElement)field.value='';}
  running.current=true;setBusy(true);setFailed(false);
  const provider=providers.find(p=>p.id===id)!;
  setMessage(`Setting up ${provider.name}: saving the key, checking it with the provider and approving it for the desktop app… this can take up to 30 seconds.`);
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(50000),
    body:JSON.stringify({action:'SETUP',provider:id,operationId:crypto.randomUUID(),revision:rows.find(r=>r.provider===id)?.revision??0,apiKey:key,factorId,code})});
   if(!alive.current)return;
   if(response.status===403){setFailed(true);setMessage('The authenticator code was not accepted, or your Admin sign-in expired. Nothing was saved. Wait for a new code and try again.');return;}
   if(response.status===400){setFailed(true);setMessage('The request was refused. Check the key and the 6-digit code, then try again.');return;}
   if(response.status===429){setFailed(true);setMessage('Too many attempts. Wait a minute and try again.');return;}
   if(!response.ok)throw Error();
   const result=await response.json();
   if(result?.code==='SETUP_COMPLETE'){
    running.current=false;
    await check(`${provider.name} is enabled and approved. Restart the Cluera desktop app, sign in, then press Start session.`);
    onApplied?.();return;
   }
   if(result?.code==='SETUP_STOPPED'){
    setFailed(true);
    const needsModel=result.reason==='MODEL_NOT_AVAILABLE';
    running.current=false;
    await check(needsModel?`This key works, but the provider does not list the model Cluera needs (${provider.model}). Use a key from an account with access to that model.`
     :(stopMessages[result.reason]??stopMessages.CHANGE_REJECTED));
    setFailed(true);return;
   }
   throw Error();
  }catch{
   if(!alive.current)return;setFailed(true);
   running.current=false;
   setMessage('The result is unknown because the request did not finish. The key may already be saved. Click Check status to see the current state, then run setup again if needed.');
  }finally{running.current=false;if(alive.current)setBusy(false);}
 }
 return <section className="ai-provider-console" aria-labelledby="ai-quick-setup-heading" aria-busy={busy}>
  <p className="account-ui-kicker">RECOMMENDED</p><h2 id="ai-quick-setup-heading">AI setup in one step</h2>
  <p>Paste each provider key once. Cluera encrypts it, checks it with the provider, turns the provider on and approves the model for the desktop app. Each provider needs one authenticator code. Keys are never shown again.</p>
  <p role="status" aria-live="polite" style={failed?{color:'#fca5a5'}:undefined}>{message}</p>
  <div className="ai-provider-actions"><button type="button" disabled={disabled||busy} onClick={()=>void check()}>Check status</button></div>
  {rows?<div className="ai-provider-grid">{providers.map(provider=>{
   const row=rows.find(r=>r.provider===provider.id),policy=models?.find(m=>m.provider===provider.id&&m.modelId===provider.model);
   const approved=Boolean(policy?.enabled&&policy.isDefault&&policy.health!=='UNAVAILABLE');
   const state=row?.enabled&&row.defaultModel===provider.model?(models===undefined||approved?'Ready':'Enabled · model approval pending'):row?.credentialPresent?'Key saved · not enabled':'Not set up';
   return <article className="ai-provider-card" key={provider.id}>
    <header><h3>{provider.name}</h3><span>{state}</span></header>
    <p>{provider.purpose} · model <code>{provider.model}</code>. {provider.hint}</p>
    <form onSubmit={event=>{event.preventDefault();void setup(provider.id,event.currentTarget);}}>
     <fieldset disabled={disabled||busy||!factors.length}>
      <legend>{row?.credentialPresent?'Replace key and re-enable':'Add key and enable'}</legend>
      <label>{provider.name} API key<input name="key" type="password" autoComplete="off" spellCheck={false} minLength={20} maxLength={4096} required/></label>
      {factors.length>1?<label>Authenticator<select name="factor" required>{factors.map((factor,i)=><option key={factor.id} value={factor.id}>Authenticator {i+1}</option>)}</select></label>:null}
      <label>6-digit authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label>
      <button>{busy?'Working…':'Save and enable'}</button>
     </fieldset>
    </form>
   </article>;})}</div>:null}
 </section>;
}
