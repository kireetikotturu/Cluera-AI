'use client';
import {useState} from 'react';
import type {ModelPolicy} from './ModelPolicyEditor';

type Provider=ModelPolicy['provider'];
const providers:{id:Provider;name:string;example:string;help:string}[]=[
 {id:'gemini',name:'Google Gemini',example:'gemini-3.5-flash',help:'Answers'},
 {id:'openai',name:'ChatGPT (OpenAI)',example:'gpt-5-mini',help:'Answers'},
 {id:'anthropic',name:'Claude (Anthropic)',example:'claude-haiku-5-5',help:'Answers'},
 {id:'deepgram',name:'Deepgram',example:'flux-general-en',help:'Live transcription (Flux models)'},
];
const label=(id:Provider)=>providers.find(p=>p.id===id)!.name;
type Props={models:ModelPolicy[];disabled:boolean;onSave:(model:ModelPolicy,reason:string)=>void;onDelete:(modelId:string,reason:string)=>void};

/** Simple model manager. Every change is audited; the Cluera desktop app sees the
 * enabled models within about a minute (answer models from every provider appear together). */
export function AiModels({models,disabled,onSave,onDelete}:Props){
 const [editing,setEditing]=useState<string|null>(null),[adding,setAdding]=useState(false),[provider,setProvider]=useState<Provider>('gemini');
 const [confirmDelete,setConfirmDelete]=useState<string|null>(null);
 const save=(model:ModelPolicy,what:string)=>onSave(model,`Admin: ${what} ${model.modelId}`.slice(0,500));
 const answerDefault=models.find(m=>m.provider!=='deepgram'&&m.isDefault)?.modelId;
 const groups=providers.map(p=>({...p,rows:models.filter(m=>m.provider===p.id).sort((a,b)=>a.priority-b.priority||a.modelId.localeCompare(b.modelId))}));
 return <section className="admin-models" aria-labelledby="admin-models-heading">
  <div className="admin-panel-head"><div><p className="account-ui-kicker">AI MODELS</p><h2 id="admin-models-heading">Models in the Cluera app</h2>
   <p>Turn models on or off, rename them, choose the default, add new ones (for example a new Gemini, ChatGPT or Claude model) or delete them. Changes reach the desktop app within about a minute.</p></div>
   <button className="button" type="button" disabled={disabled} onClick={()=>{setAdding(!adding);setEditing(null);}}>{adding?'Close':'+ Add a model'}</button></div>
  {adding?<form className="admin-model-form" onSubmit={event=>{event.preventDefault();if(disabled)return;const v=new FormData(event.currentTarget);
    const modelId=String(v.get('modelId')).trim(),makeDefault=v.get('default')==='on';
    save({provider,modelId,displayName:String(v.get('name')).trim(),enabled:true,isDefault:makeDefault,priority:Number(v.get('priority')||100),
     capabilities:provider==='deepgram'?['audio']:v.get('image')==='on'?['text','image']:['text'],health:'UNVERIFIED'},'added model');
    setAdding(false);}}>
   <h3>Add a model</h3>
   <label>Provider<select value={provider} onChange={event=>setProvider(event.target.value as Provider)}>{providers.map(p=><option key={p.id} value={p.id}>{p.name} · {p.help}</option>)}</select></label>
   <label>Model ID (exactly as the provider names it)<input name="modelId" required maxLength={100} pattern={provider==='deepgram'?'flux-[a-z0-9-]{1,60}':'[A-Za-z0-9][A-Za-z0-9._-]{1,99}'} placeholder={providers.find(p=>p.id===provider)!.example} autoComplete="off" spellCheck={false}/></label>
   <label>Name shown in the app<input name="name" required minLength={2} maxLength={80} placeholder="e.g. Gemini 3.8 Flash"/></label>
   <label>Order (lower shows first)<input name="priority" type="number" min={0} max={1000} defaultValue={100}/></label>
   {provider!=='deepgram'?<label className="admin-check"><input name="image" type="checkbox" defaultChecked/> Can read screenshots</label>:null}
   <label className="admin-check"><input name="default" type="checkbox"/> Make this the default {provider==='deepgram'?'transcription':'answer'} model</label>
   <p className="admin-note">Connect the provider's API key in <a href="#admin-ai-keys">AI keys</a> first. A wrong model ID only affects that model.</p>
   <button className="button" disabled={disabled}>Add model</button>
  </form>:null}
  <div className="admin-model-groups">{groups.map(group=><div key={group.id} className="admin-model-group">
   <h3>{group.name}<span>{group.help}</span></h3>
   {group.rows.length?<ul>{group.rows.map(model=><li key={model.modelId} className={model.enabled?'on':'off'}>
    {editing===model.modelId?<form className="admin-model-edit" onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);
      save({...model,displayName:String(v.get('name')).trim(),priority:Number(v.get('priority')),
       capabilities:model.provider==='deepgram'?['audio']:v.get('image')==='on'?['text','image']:['text']},'edited model');setEditing(null);}}>
      <label>Name<input name="name" defaultValue={model.displayName} required minLength={2} maxLength={80}/></label>
      <label>Order<input name="priority" type="number" min={0} max={1000} defaultValue={model.priority}/></label>
      {model.provider!=='deepgram'?<label className="admin-check"><input name="image" type="checkbox" defaultChecked={model.capabilities.includes('image')}/> Screenshots</label>:null}
      <div className="admin-row-actions"><button className="button small" disabled={disabled}>Save</button><button type="button" onClick={()=>setEditing(null)}>Cancel</button></div>
     </form>:<>
     <div className="admin-model-main"><strong>{model.displayName}</strong><code>{model.modelId}</code>
      <div className="admin-tags">{model.isDefault?<span className="tag-default">Default</span>:null}<span className={model.enabled?'tag-on':'tag-off'}>{model.enabled?'On':'Off'}</span>
       {model.capabilities.includes('image')?<span>Screenshots</span>:null}</div></div>
     <div className="admin-row-actions">
      <button type="button" disabled={disabled||(model.isDefault&&model.enabled)} title={model.isDefault?'Choose another default first':undefined}
       onClick={()=>save({...model,enabled:!model.enabled,isDefault:model.enabled?false:model.isDefault},model.enabled?'turned off':'turned on')}>{model.enabled?'Turn off':'Turn on'}</button>
      {!model.isDefault?<button type="button" disabled={disabled} onClick={()=>save({...model,enabled:true,isDefault:true,health:model.health==='UNAVAILABLE'?'UNVERIFIED':model.health},'made default')}>Make default</button>:null}
      <button type="button" disabled={disabled} onClick={()=>{setEditing(model.modelId);setAdding(false);}}>Edit</button>
      {confirmDelete===model.modelId?<><button type="button" className="danger" disabled={disabled} onClick={()=>{onDelete(model.modelId,`Admin: deleted model ${model.modelId}`);setConfirmDelete(null);}}>Yes, delete</button><button type="button" onClick={()=>setConfirmDelete(null)}>Keep</button></>
       :<button type="button" className="danger" disabled={disabled||(model.isDefault&&(model.provider==='deepgram'||model.modelId===answerDefault))} title={model.isDefault?'Choose another default first':undefined} onClick={()=>setConfirmDelete(model.modelId)}>Delete</button>}
     </div></>}
   </li>)}</ul>:<p className="admin-empty">No {label(group.id)} models yet.</p>}
  </div>)}</div>
 </section>;
}
