'use client';
import {useState} from 'react';

/** Label shown next to a model's name in the desktop app picker.
 * Stored text: blank = automatic (Recommended for the default model, Fast/Slow guessed from the name),
 * "-" = no label, anything else is shown exactly as typed. */
export const MODEL_TAG_PRESETS=['Recommended','Fast','Slow','Very slow','New','Best quality','Beta'] as const;
const CUSTOM='__custom__';

export const describeModelTag=(tag:string|undefined)=>!tag?'Automatic':tag==='-'?'No label':tag;

export function ModelTagField({defaultValue='',disabled=false}:{defaultValue?:string;disabled?:boolean}){
 const preset=(MODEL_TAG_PRESETS as readonly string[]).includes(defaultValue)||defaultValue===''||defaultValue==='-';
 const [choice,setChoice]=useState(preset?defaultValue:CUSTOM),[custom,setCustom]=useState(preset?'':defaultValue);
 const value=choice===CUSTOM?custom.trim().slice(0,24):choice;
 return <div className="admin-tag-field">
  <label>Label in the app
   <select value={choice} disabled={disabled} onChange={event=>setChoice(event.target.value)}>
    <option value="">Automatic</option>
    <option value="-">No label</option>
    {MODEL_TAG_PRESETS.map(name=><option key={name} value={name}>{name}</option>)}
    <option value={CUSTOM}>Custom text…</option>
   </select>
  </label>
  {choice===CUSTOM?<label>Custom label<input value={custom} maxLength={24} disabled={disabled} placeholder="e.g. Best for coding" onChange={event=>setCustom(event.target.value.replace(/[<>]/g,''))}/></label>:null}
  <input type="hidden" name="tag" value={value}/>
 </div>;
}
