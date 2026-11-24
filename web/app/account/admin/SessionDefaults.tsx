'use client';
import {useEffect,useState} from 'react';
import type {ModelPolicy} from './ModelPolicyEditor';
import {BUILT_IN_SESSION_DEFAULTS,type SessionDefaults as Defaults} from '../../../lib/accounts/sessionDefaults';

type Props={models:ModelPolicy[];disabled:boolean;/** Changes whenever the admin page reloads, so the saved values are read again. */refreshKey:unknown;
 onSave:(values:Defaults,reason:string)=>void};

/** The starting texts and the recommended model that new sessions in the desktop app begin with. */
export function SessionDefaults({models,disabled,refreshKey,onSave}:Props){
 const [current,setCurrent]=useState<Defaults|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{
  let live=true;
  void fetch('/api/account/models',{cache:'no-store'}).then(response=>response.ok?response.json():Promise.reject(new Error('load')))
   .then((body:{sessionDefaults?:Defaults})=>{if(live&&body.sessionDefaults){setCurrent(body.sessionDefaults);setFailed(false);}})
   .catch(()=>{if(live)setFailed(true);});
  return()=>{live=false;};
 },[refreshKey]);
 const answerModels=models.filter(model=>model.provider!=='deepgram'&&model.enabled);
 const value=current??BUILT_IN_SESSION_DEFAULTS;
 const modelInList=answerModels.some(model=>model.modelId===value.assignmentModel);
 return <section className="admin-session-defaults" aria-labelledby="admin-session-defaults-heading">
  <div className="admin-panel-head"><div><p className="account-ui-kicker">NEW SESSIONS</p><h2 id="admin-session-defaults-heading">Session defaults</h2>
   <p>The text each new session starts with, and the model recommended for assignments. Customers can still change them while creating a session. Changes reach the desktop app within about a minute.</p></div></div>
  {failed&&!current?<p className="admin-note" role="alert">The saved defaults could not be loaded. The built-in text is shown; saving replaces what is stored.</p>:null}
  <form key={JSON.stringify(value)} className="admin-model-form admin-defaults-form" onSubmit={event=>{event.preventDefault();if(disabled)return;
    const v=new FormData(event.currentTarget);
    onSave({interviewContext:String(v.get('interviewContext')??'').trim(),assignmentContext:String(v.get('assignmentContext')??'').trim(),assignmentModel:String(v.get('assignmentModel')??'').trim()},'Admin: updated the starting text and recommended model for new sessions');}}>
   <label className="admin-wide">Interview — starting context
    <textarea name="interviewContext" rows={5} maxLength={4000} defaultValue={value.interviewContext} placeholder="Shown in the Supporting context box when someone creates an interview session"/>
    <button type="button" className="admin-link-button" disabled={disabled} onClick={event=>{const box=event.currentTarget.parentElement?.querySelector('textarea');if(box)box.value=BUILT_IN_SESSION_DEFAULTS.interviewContext;}}>Use the built-in text</button></label>
   <label className="admin-wide">Assignment — starting context
    <textarea name="assignmentContext" rows={5} maxLength={4000} defaultValue={value.assignmentContext} placeholder="Shown in the Assignment context box when someone creates an assignment session"/>
    <button type="button" className="admin-link-button" disabled={disabled} onClick={event=>{const box=event.currentTarget.parentElement?.querySelector('textarea');if(box)box.value=BUILT_IN_SESSION_DEFAULTS.assignmentContext;}}>Use the built-in text</button></label>
   <label>Assignment — recommended model
    <select name="assignmentModel" defaultValue={value.assignmentModel}>
     {!modelInList?<option value={value.assignmentModel}>{value.assignmentModel} (not turned on)</option>:null}
     {answerModels.map(model=><option key={model.modelId} value={model.modelId}>{model.displayName} · {model.modelId}</option>)}
    </select></label>
   <p className="admin-note">Assignments always have Auto Answer on and Save Transcript on by default. Interviews keep Save Transcript on by default and Auto Answer off.</p>
   <button className="button" disabled={disabled}>Save session defaults</button>
  </form>
 </section>;
}
