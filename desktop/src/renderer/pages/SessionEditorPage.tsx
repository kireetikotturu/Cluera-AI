import {
  ArrowLeft, ArrowRight, FileText, MessageSquareText,
  Plus, Shrink, Trash2, Upload, Video, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentRecord, ExtractedDocument, LibraryFile, LibraryFileCategory, SessionInput } from '../../shared/types';
import { useAppStore } from '../stores/appStore';
import { requireSessionProviderSetup } from '../services/providerSetup';
import { ModelPicker } from '../components/ModelPicker';
import { AnswerPreferencesDialog } from '../components/AnswerPreferencesDialog';
import { DEFAULT_ANSWER_PREFERENCES, normalizeAnswerPreferences } from '../../shared/answerPreferences';
import { ASSIGNMENT_STYLE_DIRECT, ASSIGNMENT_STYLE_EXPLAINED, assignmentModeOf, resolveSessionDefaults, type SessionKind } from '../../shared/sessionKinds';

const defaults: SessionInput = {
  title: '', role: '', company: '', interviewType: 'mixed', language: 'English',
  answerStyle: 'Natural and confident', answerLength: 'medium', jobDescription: '', resumeText: '',
  instructions: '',
  selectedModel: '', autoAnswer: false, saveTranscript: true, interviewUrl: '', resumeFileName: '',
  answerPreferences: DEFAULT_ANSWER_PREFERENCES, kind: 'interview',
};

const SUPPORTING_CONTEXT_NAME = 'Session supporting context';

function answerPreferenceSummary(value: SessionInput['answerPreferences']): string {
  const prefs = normalizeAnswerPreferences(value);
  const formats = [prefs.fullScript && 'Full script', prefs.scriptWithBullets && 'Script + bullets', prefs.bullets && 'Bullet points'].filter(Boolean);
  return `${formats.length ? formats.join(' · ') : 'Script + bullets'}${prefs.fillerWords ? ' · Filler words' : ''}`;
}

interface SessionEditorPageProps { onCollapse(): void; account?: boolean }

export function SessionEditorPage({ onCollapse, account = false }: SessionEditorPageProps): JSX.Element {
  const activeId = useAppStore((state) => state.activeSessionId);
  const provider = useAppStore((state) => state.providerStatus);
  const editing = Boolean(activeId);
  const sessionDefaults = useMemo(() => resolveSessionDefaults(provider?.sessionDefaults), [provider?.sessionDefaults]);
  const [form, setForm] = useState<SessionInput>(defaults);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [resumeFileName, setResumeFileName] = useState('');
  const [supportingText, setSupportingText] = useState('');
  const [originalSupportingText, setOriginalSupportingText] = useState('');
  const [supportingTextDocumentId, setSupportingTextDocumentId] = useState<string | null>(null);
  const [pendingSupportingFiles, setPendingSupportingFiles] = useState<ExtractedDocument[]>([]);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [showPreferences, setShowPreferences] = useState(false);
  const [assignmentContext, setAssignmentContext] = useState('');
  // The starting texts and model come from the Admin; once the customer changes one, it is theirs.
  const interviewContextTouched = useRef(false), assignmentContextTouched = useRef(false), modelTouched = useRef(false);
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
      interviewContextTouched.current = false; assignmentContextTouched.current = false; modelTouched.current = false;
      setForm({ ...defaults, selectedModel: enabledDefault ?? '' }); setDocuments([]); setResumeFileName(''); setSupportingText(sessionDefaults.interviewContext); setAssignmentContext(sessionDefaults.assignmentContext);
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
        answerPreferences: normalizeAnswerPreferences(session.answerPreferences),
        kind: session.kind ?? 'interview',
      });
      if (session.kind === 'assignment') setAssignmentContext(session.instructions);
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

  // Creating a session reloads the model list on the way in. Editing one does not, so reload it here
  // and show the labels and models the Admin has set now. A failure keeps the list already shown.
  useEffect(() => {
    if (!activeId) return undefined;
    let disposed = false;
    void Promise.resolve(window.electronAPI.getProviderStatus?.(true))
      .then((status) => { if (!disposed && status?.modelOptions) useAppStore.getState().setProviderStatus(status); })
      .catch(() => { /* keep the list already on screen */ });
    return () => { disposed = true; };
  }, [activeId]);

  const models = provider?.modelOptions ?? [];
  const selectedModelEnabled = models.some((model) => model.modelId === form.selectedModel);
  const isAssignment = form.kind === 'assignment';
  const assignmentMode = assignmentModeOf(form.answerStyle);
  const recommendedModel = isAssignment ? sessionDefaults.assignmentModel : provider?.defaultGeminiModel;
  // Keep the Admin's starting texts current until the customer edits them (a refresh can arrive after the page opens).
  useEffect(() => {
    if (activeId) return;
    if (!interviewContextTouched.current) setSupportingText(sessionDefaults.interviewContext);
    if (!assignmentContextTouched.current) setAssignmentContext(sessionDefaults.assignmentContext);
  }, [activeId, sessionDefaults.interviewContext, sessionDefaults.assignmentContext]);
  const chooseKind = (kind: SessionKind): void => {
    if (editing || kind === form.kind) return;
    setError('');
    setForm((old) => {
      const preferred = kind === 'assignment' ? sessionDefaults.assignmentModel : provider?.defaultGeminiModel ?? '';
      const usable = models.some((model) => model.modelId === preferred);
      return { ...old, kind, autoAnswer: kind === 'assignment', selectedModel: !modelTouched.current && usable ? preferred : old.selectedModel };
    });
  };
  const update = <K extends keyof SessionInput>(key: K, value: SessionInput[K]): void => setForm((old) => ({ ...old, [key]: value }));
  const back = (): void => setPage(editing ? 'copilot' : 'home');
  const validationError = (): string => {
    if (isAssignment) {
      if (form.title.trim().length < 2) return 'Add a session name (at least two characters).';
      if (!models.length) return 'No enabled AI models are available. Connect to Cluera and try again.';
      if (!form.selectedModel) return 'Choose an enabled AI model.';
      if (!selectedModelEnabled) return 'The selected AI model is no longer enabled. Choose another model.';
      return '';
    }
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
      // An assignment keeps its context in the session itself and answers questions directly, so the interview
      // fields (company, role, resume, job description) are simply empty, and Auto Answer is always on.
      const payload: SessionInput = isAssignment
        ? { ...form, kind: 'assignment', role: 'Assignment', company: 'Assignment', interviewType: 'mixed', jobDescription: '', resumeText: '', resumeFileName: '',
            instructions: assignmentContext.trim(), autoAnswer: true,
            answerStyle: assignmentMode === 'explained' ? ASSIGNMENT_STYLE_EXPLAINED : ASSIGNMENT_STYLE_DIRECT,
            answerLength: assignmentMode === 'explained' ? 'detailed' : 'medium' }
        : { ...form, kind: 'interview', resumeFileName };
      const session = await window.electronAPI.saveSession(payload);
      if (!current()) return;
      setForm((current) => ({ ...current, id: session.id }));
      if (!isAssignment && supportingText.trim() !== originalSupportingText.trim()) {
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
    <button className="dashboard-create" disabled={locked} onClick={() => void save()}>{saving ? 'Saving...' : editing ? 'Save Session' : 'Create Session'}<ArrowRight size={15}/></button>
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
      <div className="sc-column">
        <div className="sc-top">
          <div className="session-kind-toggle" role="group" aria-label="Session type">
            <button type="button" aria-pressed={!isAssignment} disabled={locked || (editing && isAssignment)} onClick={() => chooseKind('interview')}>Interview</button>
            <button type="button" aria-pressed={isAssignment} disabled={locked || (editing && !isAssignment)} onClick={() => chooseKind('assignment')}>Assignment</button>
          </div>
          <button type="button" className="session-tutorial" onClick={() => void tutorial()}><Video size={14}/>Video Tutorial</button>
        </div>
        {isAssignment ? <fieldset className="wizard-step sc-step" disabled={locked}>
          <h2 className="sc-heading">Assignment details</h2>
          <div className="sc-card sc-grid">
            <label className="sc-field sc-wide"><span className="field-label">Session name</span><input autoFocus value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="Java, SQL and aptitude assignment"/></label>
            <label className="sc-field sc-wide"><span className="field-label"><FileText size={14}/>Assignment context</span><textarea aria-label="Assignment context" maxLength={4000} value={assignmentContext} onChange={(event) => { assignmentContextTouched.current = true; setAssignmentContext(event.target.value); }} placeholder="Tell the AI about your assignment: the rounds, the languages, and how you want the answers."/></label>
          </div>
          <h2 className="sc-heading">How to answer</h2>
          <div className="assignment-style" role="radiogroup" aria-label="Answer style">
            <label><input type="radio" name="assignment-style" checked={assignmentMode === 'direct'} onChange={() => update('answerStyle', ASSIGNMENT_STYLE_DIRECT)}/><span><strong>Simple, direct answer only</strong><small>Just the option, the value, the query or the code.</small></span></label>
            <label><input type="radio" name="assignment-style" checked={assignmentMode === 'explained'} onChange={() => update('answerStyle', ASSIGNMENT_STYLE_EXPLAINED)}/><span><strong>Answer with explanation</strong><small>The answer first, then a short explanation.</small></span></label>
          </div>
        </fieldset> : <fieldset className="wizard-step sc-step" disabled={locked}>
          <h2 className="sc-heading">Session details</h2>
          <div className="sc-card sc-grid">
            <label className="sc-field sc-wide"><span className="field-label">Session name</span><input autoFocus value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="Frontend interview at Acme"/></label>
            <label className="sc-field"><span className="field-label">Company name</span><input value={form.company} onChange={(event) => update('company', event.target.value)} placeholder="Acme Inc."/></label>
            <label className="sc-field"><span className="field-label">Job role / title</span><input value={form.role} onChange={(event) => update('role', event.target.value)} placeholder="Software Engineer"/></label>
          </div>
          <h2 className="sc-heading">Your context</h2>
          <section className="sc-card sc-upload" aria-label="Resume upload">
            <div className="sc-row">
              <div className="sc-row-text"><span className="sc-title"><FileText size={14}/><strong>Resume / CV</strong><small className="field-required">Required</small></span><small className="sc-hint">PDF, DOCX, TXT, MD · saved to Files and your account</small></div>
              <div className="sc-actions"><button type="button" className="sc-btn" disabled={uploading !== null} onClick={() => void chooseFile('resume')}><Upload size={13}/>{uploading === 'resume' ? 'Reading...' : resumeFileName ? 'Replace file' : 'Upload resume'}</button><select aria-label="Choose saved resume" value="" disabled={uploading !== null || libraryLoading || savedResumes.length === 0} onChange={(event) => void chooseSavedFile('resume', event.target.value)}><option value="">{libraryLoading ? 'Loading saved resumes...' : savedResumes.length ? 'Choose saved resume...' : 'No saved files'}</option>{savedResumes.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}</select></div>
            </div>
            {resumeFileName && <div className="sc-file"><FileText size={13}/><span>{resumeFileName}</span><small>Ready for AI context</small><button type="button" aria-label="Remove resume" title="Remove resume" onClick={() => { update('resumeText', ''); setResumeFileName(''); }}><Trash2 size={13}/></button></div>}
          </section>
          <label className="sc-card sc-text"><span className="sc-title"><FileText size={14}/>Interview description / JD <small className="field-required">Required</small></span><textarea value={form.jobDescription} onChange={(event) => update('jobDescription', event.target.value)} placeholder="Paste or type the job description..."/></label>
          <section className="sc-card sc-text" aria-label="Supporting context">
            <div className="sc-row">
              <span className="sc-title"><FileText size={14}/>Supporting context <small className="field-required">Required</small></span>
              <div className="sc-actions"><button type="button" className="sc-btn" disabled={uploading !== null} onClick={() => void chooseFile('supporting')} aria-label="Upload supporting file" title="Upload supporting file"><Plus size={13}/><span>{uploading === 'supporting' ? 'Reading...' : 'Upload file'}</span></button><select aria-label="Choose saved supporting file" value="" disabled={uploading !== null || libraryLoading || savedSupportingFiles.length === 0} onChange={(event) => void chooseSavedFile('supporting', event.target.value)}><option value="">{libraryLoading ? 'Loading saved files...' : savedSupportingFiles.length ? 'Choose saved file...' : 'No saved files'}</option>{savedSupportingFiles.map((file) => <option value={file.id} key={file.id}>{file.name}</option>)}</select></div>
            </div>
            <textarea aria-label="Supporting context text" value={supportingText} onChange={(event) => { interviewContextTouched.current = true; setSupportingText(event.target.value); }} placeholder="Type context or attach a PDF, DOCX, TXT, or Markdown file..."/>
            <small className="sc-hint">Type context or attach at least one supporting file.</small>
            {(documents.length > 0 || pendingSupportingFiles.length > 0) && <div className="supporting-files sc-files">
              {documents.map((document) => <div key={document.id}><FileText size={13}/><span>{document.name}</span><small>{Math.max(1, Math.ceil(document.sizeBytes / 1024))} KB</small><button type="button" aria-label={`Remove ${document.name}`} onClick={() => void removeDocument(document.id)}><Trash2 size={13}/></button></div>)}
              {pendingSupportingFiles.map((document, index) => <div className="pending" key={`${document.name}-${index}`}><FileText size={13}/><span>{document.name}</span><small>Ready to save</small><button type="button" aria-label={`Remove ${document.name}`} onClick={() => setPendingSupportingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13}/></button></div>)}
            </div>}
            <button type="button" className="answer-pref-button" onClick={() => setShowPreferences(true)}><MessageSquareText size={14}/><span><strong>Answer preferences</strong><small>{answerPreferenceSummary(form.answerPreferences)}</small></span><ArrowRight size={13}/></button>
          </section>
        </fieldset>}

        <fieldset className="wizard-step preferences-step sc-step" disabled={locked}>
          <h2 className="sc-heading session-section-label">Output settings</h2>
          <div className="sc-card sc-grid">
            <div className="sc-field model-field"><span className="field-label" id="session-model-label">AI model</span><ModelPicker models={models} value={form.selectedModel} recommendedId={recommendedModel} ariaLabel="AI model" placeholder="Choose an AI model" unavailableLabel={form.selectedModel && !selectedModelEnabled ? `${form.selectedModel} · unavailable` : undefined} onChange={(modelId) => { modelTouched.current = true; update('selectedModel', modelId); }}/></div>
            {!isAssignment && <label className="sc-field"><span className="field-label">Answer language</span><input list="answer-languages" value={form.language} onChange={(event) => update('language', event.target.value)} aria-label="Answer language"/><datalist id="answer-languages">{['English', 'Hindi', 'Spanish', 'French', 'German', 'Telugu'].map((language) => <option value={language} key={language}/>)}</datalist></label>}
          </div>
          <h2 className="sc-heading session-section-label">Behavior</h2>
          <div className="sc-card session-behavior">
            {!isAssignment && <label><input type="checkbox" checked={form.autoAnswer ?? false} onChange={(event) => update('autoAnswer', event.target.checked)}/><span><span>Auto Answer <span className="beta-badge">Beta</span></span><small>Automatically answer completed interviewer questions after Start.</small></span></label>}
            <label><input type="checkbox" checked={form.saveTranscript ?? true} onChange={(event) => update('saveTranscript', event.target.checked)}/><span>Save Transcript<small>Save spoken turns in History. When off, speech is live context only; AI questions and answers are still saved.</small></span></label>
          </div>
        </fieldset>

        {!account && error && <div role="alert" className="form-error wizard-error">{error}</div>}
        {!account && actions}
      </div>
    </section>
    {account && error && <div role="alert" className="form-error account-session-error">{error}</div>}
    {account && actions}
    {showPreferences && <AnswerPreferencesDialog value={normalizeAnswerPreferences(form.answerPreferences)} onChange={(next) => update('answerPreferences', next)} onClose={() => setShowPreferences(false)}/>}
  </main>;
}
