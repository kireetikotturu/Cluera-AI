'use client';
import {useState} from 'react';
import type {z} from 'zod';
import type {accountModelPolicy} from '../../../lib/accounts/modelPolicy';

export type ModelPolicy=z.infer<typeof accountModelPolicy>;
type Props={models:ModelPolicy[];disabled:boolean;onSave:(model:ModelPolicy,reason:string)=>void};
export function ModelPolicyEditor({models,disabled,onSave}:Props){
 const [selected,setSelected]=useState(''),[provider,setProvider]=useState<'gemini'|'deepgram'>('gemini');
 const current=models.find(item=>`${item.provider}:${item.modelId}`===selected);
 // A confirmed policy refresh remounts the form with authoritative values;
 // pending operations are locked by the parent until reconciliation succeeds.
 const formKey=JSON.stringify(current??{provider});
 return <section aria-labelledby="model-policy-heading">
  <h2 id="model-policy-heading">AI model registry</h2>
  <p>Gemini choices are available to customers. Deepgram is internal transcription only. Health is an administrator-declared label, not a live provider test.</p>
  <ul>{models.map(item=><li key={`${item.provider}:${item.modelId}`}>
   <strong>{item.displayName}</strong> · {item.provider} · {item.modelId} · {item.enabled?'enabled':'disabled'}{item.isDefault?' · default':''}
   {' · '}priority {item.priority} · {item.capabilities.join(', ')} · {item.health}
  </li>)}</ul>
  <fieldset disabled={disabled} style={{border:0,padding:0,margin:0}}>
   <label>Model policy<select aria-label="Model policy" value={selected} onChange={event=>{
    const value=event.target.value;setSelected(value);const chosen=models.find(item=>`${item.provider}:${item.modelId}`===value);setProvider(chosen?.provider??'gemini');
   }}><option value="">Add a model</option>{models.map(item=><option key={`${item.provider}:${item.modelId}`} value={`${item.provider}:${item.modelId}`}>{item.displayName} · {item.modelId}</option>)}</select></label>
   <form key={formKey} onSubmit={event=>{
    event.preventDefault();if(disabled)return;
    const values=new FormData(event.currentTarget);
    onSave({provider,modelId:String(values.get('modelId')??''),displayName:String(values.get('displayName')??''),
     enabled:values.get('enabled')==='on',isDefault:values.get('isDefault')==='on',priority:Number(values.get('priority')),
     capabilities:provider==='deepgram'?['audio']:values.get('image')==='on'?['text','image']:['text'],
     health:String(values.get('health')) as ModelPolicy['health']},String(values.get('reason')??''));
   }}>
    <label>Provider<select name="provider" value={provider} disabled={Boolean(current)} onChange={event=>setProvider(event.target.value as 'gemini'|'deepgram')}>
     <option value="gemini">Gemini</option><option value="deepgram">Deepgram (internal)</option>
    </select></label>
    <label>Model ID<input name="modelId" required maxLength={100} pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,99}" defaultValue={current?.modelId??(provider==='deepgram'?'flux-general-en':'')} readOnly={Boolean(current)||provider==='deepgram'}/></label>
    <label>Display name<input name="displayName" required minLength={2} maxLength={80} defaultValue={current?.displayName??''}/></label>
    <label><input name="enabled" type="checkbox" defaultChecked={current?.enabled??false}/> Enabled</label>
    <label><input name="isDefault" type="checkbox" defaultChecked={current?.isDefault??false}/> Default</label>
    {provider==='gemini'?<label><input name="image" type="checkbox" defaultChecked={current?.capabilities.includes('image')??false}/> Supports screenshots/images</label>:<p>Capabilities: audio (internal Flux).</p>}
    <label>Priority<input name="priority" type="number" min={0} max={1000} defaultValue={current?.priority??100} required/></label>
    <label>Declared health<select name="health" defaultValue={current?.health??'UNVERIFIED'}><option>UNVERIFIED</option><option>HEALTHY</option><option>DEGRADED</option><option>UNAVAILABLE</option></select></label>
    <label>Required audit reason<textarea name="reason" required minLength={10} maxLength={500}/></label>
    <p>Choose another available default before disabling the current default. No automatic model or provider fallback is added.</p>
    <button className="button" disabled={disabled}>Save model policy</button>
   </form>
  </fieldset>
 </section>;
}
