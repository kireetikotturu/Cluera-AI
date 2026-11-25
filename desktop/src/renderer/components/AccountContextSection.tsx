import { Briefcase, ClipboardPaste, FileText, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ContextDocument, ContextSnapshot } from '../../shared/accountContext';
import { MAX_DOCUMENTS_IN_USE, useSavedDocuments } from '../services/contextSelection';

type Kind = ContextDocument['kind'];
const KIND_NAME: Record<Kind, string> = { RESUME: 'Résumé', JOB_DESCRIPTION: 'Job description', SUPPORTING: 'Other document', INSTRUCTIONS: 'Instructions' };
const size = (bytes: number): string => (bytes >= 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${bytes} B`);

/** Account documents: three upload buttons and the list. Saved documents are used for answers automatically. */
export function AccountContextSection(): JSX.Element {
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ContextDocument | null>(null), [uncertain, setUncertain] = useState(false);
  const [pasting, setPasting] = useState(false), [uploading, setUploading] = useState<Kind | null>(null), [editorVersion, setEditorVersion] = useState(0);
  const mounted = useRef(false), active = useRef(false);

  async function run(work: () => Promise<ContextSnapshot | null>, write = false, kind?: Kind): Promise<void> {
    if (active.current) return;
    active.current = true; setBusy(true); setMessage(''); if (kind) setUploading(kind);
    try {
      const raw = await work();
      if (mounted.current && raw) {
        const result = await useSavedDocuments(raw, (ids) => window.accountAPI!.context.select(ids));
        if (!mounted.current) return;
        setSnapshot(result); setUncertain(result.pending);
        if (write && !result.pending) { setEditing(null); setPasting(false); setEditorVersion((value) => value + 1); }
      }
    } catch {
      if (mounted.current) {
        if (write) setUncertain(true);
        setMessage(write ? 'That change could not be confirmed. Tap Try again, and do not add the file a second time.' : 'Your documents could not be loaded. Check your connection.');
      }
    } finally { active.current = false; if (mounted.current) { setBusy(false); setUploading(null); } }
  }
  useEffect(() => { mounted.current = true; void run(() => window.accountAPI!.context.list()); return () => { mounted.current = false; }; }, []);

  const locked = busy || uncertain || !snapshot;
  const documents = snapshot?.documents ?? [];
  const upload = (kind: Kind): void => { void run(() => window.accountAPI!.context.importFile(kind), true, kind); };
  const openEditor = (document: ContextDocument): void => {
    if (active.current) return;
    active.current = true; setBusy(true); setMessage('');
    void window.accountAPI!.context.read(document.id)
      .then((value) => { if (mounted.current) { setEditing(value); setPasting(true); } }, () => { if (mounted.current) setMessage('That document could not be opened. Try again.'); })
      .finally(() => { active.current = false; if (mounted.current) setBusy(false); });
  };
  const tile = (kind: Kind, label: string, hint: string, icon: JSX.Element): JSX.Element =>
    <button type="button" className="st-tile" disabled={locked} onClick={() => upload(kind)}>
      <span className="st-tile-icon" aria-hidden="true">{icon}</span>
      <strong>{uploading === kind ? 'Reading…' : label}</strong><small>{hint}</small>
    </button>;

  return <section className="st-card st-docs" aria-labelledby="st-docs-title">
    <div className="st-card-head"><h2 id="st-docs-title">Résumé and documents</h2>
      <p>Saved to your account and used to tailor your answers. They are also ready on your phone.</p></div>
    <div className="st-tiles">
      {tile('RESUME', 'Upload résumé', 'PDF, Word or text', <FileText size={17}/>)}
      {tile('JOB_DESCRIPTION', 'Upload job description', 'PDF, Word or text', <Briefcase size={17}/>)}
      {tile('SUPPORTING', 'Upload other file', 'Notes, projects, anything useful', <Paperclip size={17}/>)}
    </div>
    <p className="st-status" role="status">{message}</p>
    {uncertain && <button type="button" className="st-btn" disabled={busy} onClick={() => void run(() => window.accountAPI!.context.retry(), true)}>Try again</button>}
    {!snapshot && !message ? <div className="st-skeleton" aria-hidden="true"><span/><span/></div> : null}
    {snapshot && !documents.length ? <p className="st-empty">No documents yet. Upload your résumé to get answers that sound like you.</p> : null}
    {documents.length ? <ul className="st-doc-list">{documents.map((document) => <li className="st-doc" key={document.id}>
      <span className="st-doc-icon" aria-hidden="true"><FileText size={15}/></span>
      <div className="st-doc-text"><strong title={document.name}>{document.name}</strong><small>{KIND_NAME[document.kind]} · {size(document.bytes)}</small></div>
      <button type="button" className="st-icon-btn" aria-label={`Edit ${document.name}`} title="Edit text" disabled={locked} onClick={() => openEditor(document)}><Pencil size={14}/></button>
      <button type="button" className="st-icon-btn danger" aria-label={`Delete ${document.name}`} title="Delete" disabled={locked}
        onClick={() => void run(() => window.accountAPI!.context.change({ action: 'DELETE', operationId: crypto.randomUUID(), id: document.id }), true)}><Trash2 size={14}/></button>
    </li>)}</ul> : null}
    {documents.length > MAX_DOCUMENTS_IN_USE ? <p className="st-hint">Answers use your {MAX_DOCUMENTS_IN_USE} newest documents.</p> : null}

    {pasting ? <form className="st-form" key={`${editing?.id ?? 'new'}-${editorVersion}`} onSubmit={(event) => {
      event.preventDefault(); if (active.current || locked) return;
      const values = new FormData(event.currentTarget), body = String(values.get('body') ?? '');
      if (new TextEncoder().encode(body).length > 120000) { setMessage('That text is too long. Keep it under 120 KB.'); return; }
      void run(() => window.accountAPI!.context.change({ action: 'SAVE', id: editing?.id ?? crypto.randomUUID(), operationId: crypto.randomUUID(),
        kind: String(values.get('kind')) as Kind, name: String(values.get('name')), body }), true);
    }}>
      <div className="st-form-row">
        <label>Type<select name="kind" defaultValue={editing?.kind ?? 'RESUME'} disabled={locked}>
          <option value="RESUME">Résumé</option><option value="JOB_DESCRIPTION">Job description</option><option value="SUPPORTING">Other document</option><option value="INSTRUCTIONS">Instructions</option></select></label>
        <label>Name<input name="name" required maxLength={120} defaultValue={editing?.name ?? ''} disabled={locked} placeholder="For example: My résumé"/></label>
      </div>
      <label>Text<textarea name="body" required maxLength={120000} rows={6} defaultValue={editing?.body ?? ''} disabled={locked} placeholder="Paste the text here"/></label>
      <div className="st-form-actions">
        <button type="submit" className="st-btn primary" disabled={locked}>{editing ? 'Save changes' : 'Save'}</button>
        <button type="button" className="st-btn" disabled={busy} onClick={() => { setEditing(null); setPasting(false); }}>Cancel</button>
      </div>
    </form> : <button type="button" className="st-link" disabled={locked} onClick={() => { setEditing(null); setPasting(true); }}><ClipboardPaste size={13}/>Paste text instead</button>}
  </section>;
}
