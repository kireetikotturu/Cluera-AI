import {
  ArrowLeft, ArrowRight, FileText,
  Plus, Shrink, Trash2, Upload, Video, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DocumentRecord, ExtractedDocument, LibraryFile, LibraryFileCategory, SessionInput } from '../../shared/types';
import { useAppStore } from '../stores/appStore';
import { requireSessionProviderSetup } from '../services/providerSetup';

const defaults: SessionInput = {
  title: '', role: '', company: '', interviewType: 'mixed', language: 'English',
  answerStyle: 'Natural and confident', answerLength: 'medium', jobDescription: '', resumeText: '',
  instructions: '',
  selectedModel: '', autoAnswer: false, saveTranscript: false, interviewUrl: '', resumeFileName: '',
};

const SUPPORTING_CONTEXT_NAME = 'Session supporting context';

interface SessionEditorPageProps { onCollapse(): void; account?: boolean }

export function SessionEditorPage({ onCollapse, account = false }: SessionEditorPageProps): JSX.Element {
  const activeId = useAppStore((state) => state.activeSessionId);
  const provider = useAppStore((state) => state.providerStatus);
  const editing = Boolean(activeId);
  const [form, setForm] = useState<SessionInput>(defaults);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [resumeFileName, setResumeFileName] = useState('');
  const [supportingText, setSupportingText] = useState('');
  const [originalSupportingText, setOriginalSupportingText] = useState('');
  const [supportingTextDocumentId, setSupportingTextDocumentId] = useState<string | null>(null);
  const [pendingSupportingFiles, setPendingSupportingFiles] = useState<ExtractedDocument[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'resume' | 'supporting' | null>(null);
  const [error, setError] = useState('');
  const operation = useRef(false), epoch = useRef(0), mounted = useRef(true);
  const [removing, setRemoving] = useState(false);
  const locked = saving || uploading !== null || removing;
  useEffect(() => { mounted.current = true; ++epoch.current; return () => { mounted.current = false; ++epoch.current; }; }, [activeId]);
  const setSessions = useAppStore((state) => state.setSessions);
  const setActive = useAppStore((state) => state.setActiveSession);
  const setPage = useAppStore((state) => state.setPage);

  const refreshLibrary = async (): Promise<void> => {
    const version = epoch.current, files = await window.electronAPI.listLibraryFiles();
    if (mounted.current && version === epoch.current) setLibraryFiles(files);
  };
  useEffect(() => {
    let disposed = false;
    void window.electronAPI.listLibraryFiles()
      .then((files) => { if (!disposed) setLibraryFiles(files); })
      .catch(() => { /* Upload remains available when the library cannot be listed. */ })
      .finally(() => { if (!disposed) setLibraryLoading(false); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!activeId) {
      const enabledDefault = provider?.modelOptions?.some((model) => model.modelId === provider.defaultGeminiModel)
        ? provider.defaultGeminiModel : '';
      setForm({ ...defaults, selectedModel: enabledDefault ?? '' }); setDocuments([]); setResumeFileName(''); setSupportingText('');
      setOriginalSupportingText(''); setSupportingTextDocumentId(null); setPendingSupportingFiles([]); setLoading(false); return;
    }
    let disposed = false;
    setLoading(true);
    void window.electronAPI.getSession(activeId).then((detail) => {
      if (disposed) return;
      if (!detail) { setError('This session could not be found.'); setLoading(false); return; }
      const session = detail.session;
      setForm({
        id: session.id, title: session.title, role: session.role, company: session.company,
        interviewType: session.interviewType, language: session.language, answerStyle: session.answerStyle,
        answerLength: session.answerLength, jobDescription: session.jobDescription, resumeText: session.resumeText,
        instructions: session.instructions, selectedModel: session.selectedModel,
        autoAnswer: session.autoAnswer ?? false, saveTranscript: session.saveTranscript ?? true,
        interviewUrl: session.interviewUrl ?? '', resumeFileName: session.resumeFileName ?? '',
      });
      const typedContext = detail.documents.find((document) => document.type === 'supporting' && document.name === SUPPORTING_CONTEXT_NAME);
      setResumeFileName(session.resumeFileName || (session.resumeText.trim() ? 'Resume on file' : ''));
      setSupportingText(typedContext?.text ?? '');
      setOriginalSupportingText(typedContext?.text ?? '');
      setSupportingTextDocumentId(typedContext?.id ?? null);
      setDocuments(detail.documents.filter((document) => document.type === 'supporting' && document.name !== SUPPORTING_CONTEXT_NAME));
      setPendingSupportingFiles([]);
      setLoading(false);
    }).catch((reason) => {
      if (!disposed) { setError(reason instanceof Error ? reason.message : 'Could not load the session.'); setLoading(false); }
    });
    return () => { disposed = true; };
  }, [activeId]);

  // A catalog refresh must not reload or erase an in-progress local draft.
  // Fill only an empty model choice; never replace a customer's selection.
  useEffect(() => {
    if (!activeId && provider?.modelOptions?.some(model => model.modelId === provider.defaultGeminiModel)) {
      setForm(current => current.selectedModel ? current : { ...current, selectedModel: provider.defaultGeminiModel ?? '' });
    }
  }, [activeId, provider?.defaultGeminiModel, provider?.modelOptions]);

  const models = provider?.modelOptions ?? [];
  const selectedModelEnabled = models.some((model) => model.modelId === form.selectedModel);
  const update = <K extends keyof SessionInput>(key: K, value: SessionInput[K]): void => setForm((old) => ({ ...old, [key]: value }));
  const back = (): void => setPage(editing ? 'copilot' : 'home');
  const validationError = (): string => {
    if (form.title.trim().length < 2 || form.company.trim().length < 2 || form.role.trim().length < 2) return 'Add a session name, company, and job role (at least two characters each).';
    if (!form.resumeText.trim()) return 'Upload a resume to continue.';
    if (!form.jobDescription.trim()) return 'Add the interview description to continue.';
    if (!supportingText.trim() && documents.length === 0 && pendingSupportingFiles.length === 0) return 'Add supporting context or at least one supporting file.';
    if (!models.length) return 'No enabled AI models are available. Connect to Cluera and try again.';
    if (!form.selectedModel) return 'Choose an enabled AI model.';
    if (!selectedModelEnabled) return 'The selected AI model is no longer enabled. Choose another model.';
    return '';
  };
  const chooseFile = async (target: 'resume' | 'supporting'): Promise<void> => {
    if (operation.current) return;
    operation.current = true; const version = epoch.current;
    setUploading(target); setError('');
    try {
      const document = await window.electronAPI.uploadLibraryFile(target);
      if (!mounted.current || version !== epoch.current) return;
      if (!document) return;
      if (target === 'resume') {
        if (document.text.length > 100_000) throw new Error('The resume is too long. Use a file with up to 100,000 extracted characters.');
        update('resumeText', document.text);
        setResumeFileName(document.name);
      } else setPendingSupportingFiles((current) => current.some((item) => item.libraryFileId === document.libraryFileId) ? current : [...current, document]);
      await refreshLibrary();
    } catch (reason) { if (mounted.current && version === epoch.current) setError(reason instanceof Error ? reason.message : 'Could not read the selected document.'); }
    finally { operation.current = false; if (mounted.current && version === epoch.current) setUploading(null); }
  };
  const chooseSavedFile = async (target: LibraryFileCategory, id: string): Promise<void> => {
    if (!id || operation.current) return;
    operation.current = true; const version = epoch.current;
    setUploading(target); setError('');
    try {
      const document = await window.electronAPI.getLibraryFile(id);
      if (!mounted.current || version !== epoch.current) return;
      if (target === 'resume') {
        if (document.category !== 'resume') throw new Error('Select a saved resume.');
        if (document.text.length > 100_000) throw new Error('The resume is too long. Use a file with up to 100,000 extracted characters.');
        update('resumeText', document.text);
        setResumeFileName(document.name);
      } else {
        if (document.category !== 'supporting') throw new Error('Select a saved supporting file.');
        setPendingSupportingFiles((current) => current.some((item) => item.libraryFileId === document.libraryFileId) ? current : [...current, document]);
      }
    } catch (reason) { if (mounted.current && version === epoch.current) setError(reason instanceof Error ? reason.message : 'Could not use the saved file.'); }
    finally { operation.current = false; if (mounted.current && version === epoch.current) setUploading(null); }
  };
  const removeDocument = async (id: string): Promise<void> => {
    if (operation.current) return;
    operation.current = true; const version = epoch.current; setRemoving(true); setError('');
    try {
      await window.electronAPI.removeDocument(id);
      if (mounted.current && version === epoch.current) setDocuments(current => current.filter(document => document.id !== id));
    } catch (reason) {
      if (mounted.current && version === epoch.current) setError(reason instanceof Error ? reason.message : 'Could not remove the document.');
    } finally { operation.current = false; if (mounted.current && version === epoch.current) setRemoving(false); }
  };
  const save = async (): Promise<void> => {
    if (operation.current || locked) return;
    const validation = validationError();
    if (validation) { setError(validation); return; }
    operation.current = true; const version = epoch.current;
    const current = () => mounted.current && version === epoch.current;
    setSaving(true); setError('');
    try {
      await requireSessionProviderSetup(form.selectedModel);
      if (!current()) return;
      const session = await window.electronAPI.saveSession({ ...form, resumeFileName });
      if (!current()) return;
      setForm((current) => ({ ...current, id: session.id }));
      if (supportingText.trim() !== originalSupportingText.trim()) {
        const replacement = supportingText.trim()
          ? await window.electronAPI.addTextDocument({ sessionId: session.id, type: 'supporting', name: SUPPORTING_CONTEXT_NAME, text: supportingText })
          : null;
        if (!current()) return;
        if (supportingTextDocumentId) await window.electronAPI.removeDocument(supportingTextDocumentId);
        if (!current()) return;
        setSupportingTextDocumentId(replacement?.id ?? null);
        setOriginalSupportingText(supportingText.trim());
      }
      for (const document of pendingSupportingFiles) {
        await window.electronAPI.addExtractedDocument({ sessionId: session.id, type: 'supporting', document });
        if (!current()) return;
        // A later failure must not reattach files already saved successfully.
        setPendingSupportingFiles(files => files.filter(item => item !== document));
      }
      setPendingSupportingFiles([]);
      const sessions = await window.electronAPI.listSessions();
      if (!current()) return;
      setSessions(sessions);
      setActive(session.id);
      setPage('copilot');
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Could not save the session.'); }
    finally { operation.current = false; if (current()) setSaving(false); }
  };
  const tutorial = async (): Promise<void> => {
    try { await window.electronAPI.openExternal('tutorial'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open the tutorial.'); }
  };
  const adjustZoom = async (direction: 'in' | 'out'): Promise<void> => {
    try { await window.electronAPI.adjustZoom(direction); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not adjust zoom.'); }
  };
  const savedResumes = libraryFiles.filter((file) => file.category === 'resume');
  const savedSupportingFiles = libraryFiles.filter((file) => file.category === 'supporting');

  if (loading) return <main className="session-wizard"><div className="wizard-loading">Loading session...</div></main>;
  const actions = <footer className="wizard-actions">
    {account ? <div><span>{locked ? 'Please wait for the current operation…' : 'Your setup is saved with this session'}</span>
      <small>Saving opens the workspace. Its audio device check uses your account time.</small></div> : <span>Your setup is saved with this session</span>}
    <button className="dashboard-create" disabled={locked} onClick={() => void save()}>{saving ? 'Saving...' : editing ? 'Save Session' : 'Create Session'}<ArrowRight size={16}/></button>
  </footer>;
  return <main className={`session-wizard session-create${account ? ' account-session' : ''}`} aria-busy={locked}>
    <header className="wizard-header">
      <button className="wizard-back" aria-label="Back" disabled={locked} onClick={back}><ArrowLeft size={16}/>Back</button>
      <h1 className="session-create-title">{editing ? 'Edit Session' : 'Create Session'}</h1>
      <div className="wizard-header-actions">
        <div className="wizard-zoom-controls" role="group" aria-label="Zoom controls">
          <button aria-label="Zoom out" title="Zoom out" onClick={() => void adjustZoom('out')}><ZoomOut size={14}/></button>
          <button aria-label="Zoom in" title="Zoom in" onClick={() => void adjustZoom('in')}><ZoomIn size={14}/></button>
        </div>
        <button className="wizard-collapse" aria-label="Collapse Cluera AI" title="Collapse to floating logo" onClick={onCollapse}><Shrink size={16}/></button>
        <button className="wizard-close" aria-label="Close Cluera AI" onClick={() => void window.electronAPI.closeWindow()}><X size={17}/></button>
      </div>
    </header>

    <section className="wizard-content">
      {account && <div className="account-session-intro"><p>PREPARE YOUR WORKSPACE</p><h2>{editing ? 'Refine your session.' : 'A better interview starts here.'}</h2><span>Add your context, choose an approved model and make it yours.</span></div>}
      <div className="session-tutorial-top">
        <button type="button" className="session-tutorial" onClick={() => void tutorial()}><Video size={14}/>Video Tutorial</button>
      </div>
      <fieldset className="wizard-step" disabled={locked} style={{border:0,margin:0,padding:0,minWidth:0}}>
        <div className="session-type-line"><span>Session type</span><strong>Interview</strong></div>
        <div className="wizard-fields details-fields">
          <label className="wide"><span className="field-label">Session name</span><input autoFocus value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="Frontend interview at Acme"/></label>
          <label><span className="field-label">Company name</span><input value={form.company} onChange={(event) => update('company', event.target.value)} placeholder="Acme Inc."/></label>
          <label><span className="field-label">Job role / title</span><input value={form.role} onChange={(event) => update('role', event.target.value)} placeholder="Software Engineer"/></label>
          <section className="context-upload upload-wide" aria-label="Resume upload">
            <div><span><FileText size={15}/><strong>Resume / CV</strong><small className="field-required">Required</small></span><small>PDF, DOCX, TXT, MD · saved to Files</small></div>
            <div className="context-upload-actions"><button disabled={uploading !== null} onClick={() => void chooseFile('resume')}><Upload size={14}/>{uploading === 'resume' ? 'Reading...' : resumeFileName ? 'Replace file' : 'Upload resume'}</button><select aria-label="Choose saved resume" value="" disabled={uploading !== null || libraryLoading || savedResumes.length === 0} onChange={(event) => void chooseSavedFile('resume', event.target.value)}><option value="">{libraryLoading ? 'Loading saved resumes...' : savedResumes.length ? 'Choose saved resume...' : 'No saved files'}</option>{savedResumes.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}</select></div>
            {resumeFileName && <div className="selected-context-file"><FileText size={13}/><span>{resumeFileName}</span><small>Ready for AI context</small><button aria-label="Remove resume" title="Remove resume" onClick={() => { update('resumeText', ''); setResumeFileName(''); }}><Trash2 size={13}/></button></div>}
          </section>
          <label className="context-field wide"><span><FileText size={15}/>Interview description / JD <small className="field-required">Required</small></span><textarea value={form.jobDescription} onChange={(event) => update('jobDescription', event.target.value)} placeholder="Paste or type the job description..."/></label>
          <section className="context-field context-composer wide" aria-label="Supporting context">
            <div className="context-composer-heading"><span><FileText size={15}/>Supporting context <small className="field-required">Required</small></span><div className="context-composer-actions"><button type="button" disabled={uploading !== null} onClick={() => void chooseFile('supporting')} aria-label="Upload supporting file" title="Upload supporting file"><Plus size={14}/><span>{uploading === 'supporting' ? 'Reading...' : 'Upload file'}</span></button><select aria-label="Choose saved supporting file" value="" disabled={uploading !== null || libraryLoading || savedSupportingFiles.length === 0} onChange={(event) => void chooseSavedFile('supporting', event.target.value)}><option value="">{libraryLoading ? 'Loading saved files...' : savedSupportingFiles.length ? 'Choose saved file...' : 'No saved files'}</option>{savedSupportingFiles.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}</select></div></div>
            <textarea aria-label="Supporting context text" value={supportingText} onChange={(event) => setSupportingText(event.target.value)} placeholder="Type context or attach a PDF, DOCX, TXT, or Markdown file..."/>
            <small className="context-requirement">Type context or attach at least one supporting file.</small>
          </section>
        </div>
        {(documents.length > 0 || pendingSupportingFiles.length > 0) && <div className="supporting-files">
          {documents.map((document) => <div key={document.id}><FileText size={13}/><span>{document.name}</span><small>{Math.max(1, Math.ceil(document.sizeBytes / 1024))} KB</small><button aria-label={`Remove ${document.name}`} onClick={() => void removeDocument(document.id)}><Trash2 size={13}/></button></div>)}
          {pendingSupportingFiles.map((document, index) => <div className="pending" key={`${document.name}-${index}`}><FileText size={13}/><span>{document.name}</span><small>Ready to save</small><button aria-label={`Remove ${document.name}`} onClick={() => setPendingSupportingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13}/></button></div>)}
        </div>}
      </fieldset>

      <fieldset className="wizard-step preferences-step" disabled={locked} style={{border:0,margin:0,padding:0,minWidth:0}}>
        <h2 className="session-section-label">Output settings</h2>
        <div className="wizard-fields">
          <label className="model-field compact-select-field"><span className="field-label">AI model</span><div className="model-select-row"><select value={form.selectedModel} onChange={(event) => update('selectedModel', event.target.value)}><option value="">{models.length ? 'Choose an AI model' : 'No enabled AI models available'}</option>{form.selectedModel && !selectedModelEnabled && <option value={form.selectedModel}>{form.selectedModel} · unavailable</option>}{models.map((model) => <option value={model.modelId} key={model.modelId}>{model.displayName === model.modelId ? model.modelId : `${model.displayName} · ${model.modelId}`}</option>)}</select></div></label>
          <label className="compact-select-field"><span className="field-label">Answer language</span><input list="answer-languages" value={form.language} onChange={(event) => update('language', event.target.value)} aria-label="Answer language"/><datalist id="answer-languages">{['English', 'Hindi', 'Spanish', 'French', 'German', 'Telugu'].map((language) => <option value={language} key={language}/>)}</datalist></label>
        </div>
        <h2 className="session-section-label">Behavior</h2>
        <div className="session-behavior">
          <label><input type="checkbox" checked={form.autoAnswer ?? false} onChange={(event) => update('autoAnswer', event.target.checked)}/><span><span>Auto Answer <span className="beta-badge">Beta</span></span><small>Automatically answer completed interviewer questions after Start.</small></span></label>
          <label><input type="checkbox" checked={form.saveTranscript ?? true} onChange={(event) => update('saveTranscript', event.target.checked)}/><span>Save Transcript<small>Save spoken turns in History. When off, speech is live context only; AI questions and answers are still saved.</small></span></label>
        </div>
      </fieldset>

      {!account && error && <div role="alert" className="form-error wizard-error">{error}</div>}
      {!account && actions}
    </section>
    {account && error && <div role="alert" className="form-error account-session-error">{error}</div>}
    {account && actions}
  </main>;
}
