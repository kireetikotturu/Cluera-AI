import {useEffect,useRef,useState} from 'react';
import type {ContextDocument,ContextSnapshot} from '../../shared/accountContext';

/** Account-only, explicit synchronization. No background fetch or browser token. */
export function AccountContextSection():JSX.Element {
 const [snapshot,setSnapshot]=useState<ContextSnapshot|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [editing,setEditing]=useState<ContextDocument|null>(null),[uncertain,setUncertain]=useState(false);
 const [editorVersion,setEditorVersion]=useState(0);
 const mounted=useRef(false),active=useRef(false);
 async function run(work:()=>Promise<ContextSnapshot|null>,write=false){
  if(active.current)return;active.current=true;setBusy(true);setMessage('');
  try{const result=await work();if(mounted.current&&result){setSnapshot(result);setUncertain(result.pending);if(write&&!result.pending){setEditing(null);setEditorVersion(value=>value+1);}}}
  catch{if(mounted.current){if(write)setUncertain(true);setMessage(write?'Change not confirmed. Refresh its status or retry the same change; do not create another copy.':'Context unavailable. Refresh when online.');}}
  finally{active.current=false;if(mounted.current)setBusy(false);}
 }
 useEffect(()=>{mounted.current=true;void run(()=>window.accountAPI!.context.list());return()=>{mounted.current=false;};},[]);
 const locked=busy||uncertain||!snapshot;
 return <section className="settings-section"><h2>Selected account context</h2>
  <p>Upload a résumé, job description or supporting document, or save instructions. Only checked documents contribute relevant excerpts to new answers. Selections apply to this app run and reset when it closes.</p>
  <p className="muted">PDF, DOCX, TXT, MD / Markdown up to 20 MB; extracted text up to 120 KB each, 20 documents. Extraction happens on this PC. Only extracted text and its name/category are synchronized, not the original file. Refresh to see changes from another device.</p>
  <button className="ghost" disabled={busy} onClick={()=>void run(()=>window.accountAPI!.context.list())}>Refresh context</button>
  {uncertain?<button className="ghost" disabled={busy} onClick={()=>void run(()=>window.accountAPI!.context.retry(),true)}>Retry the same context change</button>:null}
  <p role="status">{message}</p>
  <ul>{snapshot?.documents.map(document=><li key={document.id}>
   <label><input type="checkbox" disabled={locked} checked={snapshot.selectedIds.includes(document.id)} onChange={event=>{
    const ids=event.target.checked?[...snapshot.selectedIds,document.id]:snapshot.selectedIds.filter(id=>id!==document.id);
    void run(()=>window.accountAPI!.context.select(ids));
   }}/>{document.name} · {document.kind} · {document.bytes} bytes</label>
   <button className="ghost" disabled={locked} onClick={()=>{if(active.current)return;active.current=true;setBusy(true);
    void window.accountAPI!.context.read(document.id).then(value=>{if(mounted.current)setEditing(value);},()=>{if(mounted.current)setMessage('Document unavailable. Refresh context.');})
     .finally(()=>{active.current=false;if(mounted.current)setBusy(false);});}}>Edit</button>
   <button className="ghost danger" disabled={locked} onClick={()=>void run(()=>window.accountAPI!.context.change({action:'DELETE',operationId:crypto.randomUUID(),id:document.id}),true)}>Delete</button>
  </li>)}</ul>
  <p className="muted">Select at most eight documents. Deleted cloud content is removed from future answers after server confirmation; previously generated history is not retroactively rewritten.</p>
  <form key={`${editing?.id??'new'}-${editorVersion}`} onSubmit={event=>{event.preventDefault();if(active.current||locked)return;
   const values=new FormData(event.currentTarget),body=String(values.get('body')??'');
   if(new TextEncoder().encode(body).length>120000){setMessage('Use up to 120 KB of extracted text.');return;}
   void run(()=>window.accountAPI!.context.change({action:'SAVE',id:editing?.id??crypto.randomUUID(),operationId:crypto.randomUUID(),
    kind:String(values.get('kind')) as ContextDocument['kind'],name:String(values.get('name')),body}),true);
  }}>
   <label>Category<select name="kind" defaultValue={editing?.kind??'RESUME'} disabled={locked}><option value="RESUME">Résumé</option><option value="JOB_DESCRIPTION">Job description</option><option value="SUPPORTING">Supporting context</option><option value="INSTRUCTIONS">Instructions</option></select></label>
   <label>Name<input name="name" required maxLength={120} defaultValue={editing?.name??''} disabled={locked}/></label>
   <label>Text<textarea name="body" required maxLength={120000} rows={5} defaultValue={editing?.body??''} disabled={locked}/></label>
   <button className="primary" disabled={locked}>{editing?'Update context':'Save text context'}</button>
   {editing?<button type="button" className="ghost" disabled={locked} onClick={()=>setEditing(null)}>Cancel editing</button>:null}
   {!editing?<button type="button" className="ghost" disabled={locked} onClick={event=>{
    const form=event.currentTarget.form;if(!form)return;const kind=String(new FormData(form).get('kind')) as ContextDocument['kind'];
    void run(()=>window.accountAPI!.context.importFile(kind),true);
   }}>Upload document</button>:null}
  </form>
 </section>;
}
