'use client';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AnswerLength, AnswerPreferences, InterviewType, SessionKind } from '../../../../desktop/src/shared/types';
import { DEFAULT_ANSWER_PREFERENCES } from '../../../../desktop/src/shared/answerPreferences';
import { ASSIGNMENT_STYLE_DIRECT, ASSIGNMENT_STYLE_EXPLAINED } from '../../../../desktop/src/shared/sessionKinds';
import { DocumentError, readDocumentText } from '../../../lib/live/documentText';
import { getDocuments, type AccountDocument, type ModelOption, type SessionDefaults } from '../../../lib/live/liveApi';
import { loadLastSetup } from './prefs';
import { modelChoiceLabel, orderedModels } from './modelChoices';
import { Icon } from './icons';

/** What the setup screen collects. The résumé and the job description are plain text by the time Start is pressed. */
export interface SetupDraft {
  kind: SessionKind; title: string; role: string; company: string; interviewType: InterviewType; language: string;
  answerLength: AnswerLength; answerStyle: string; answerPreferences: AnswerPreferences; instructions: string;
  resumeText: string; jobDescription: string;
  /** Set when the résumé was uploaded or pasted and the customer wants it kept on the account for next time. */
  saveResume: { name: string; text: string } | null;
  /** Extra saved notes (supporting material or instructions) chosen under More options. */
  docIds: string[]; modelId: string; autoAnswer: boolean; saveHistory: boolean;
}

const LANGUAGES = ['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Spanish', 'French', 'German'];
const FORMATS: Array<{ key: keyof AnswerPreferences; label: string; hint: string }> = [
  { key: 'scriptWithBullets', label: 'Opening line, then bullets', hint: 'One line to say first, then short supporting points.' },
  { key: 'fullScript', label: 'Full script', hint: 'An answer to read word for word.' },
  { key: 'bullets', label: 'Bullets only', hint: 'Short points to say in your own words.' },
  { key: 'fillerWords', label: 'Natural speech', hint: 'Small pauses and connecting words, like real talking.' },
];
const FILE_TYPES = '.pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';
const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value ? value : fallback);
const words = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);

export function SetupForm({ models, defaults, documents, busy, error, onStart, onBack }: {
  models: ModelOption[]; defaults: SessionDefaults; documents: AccountDocument[]; busy: boolean; error: string;
  onStart(draft: SetupDraft): void; onBack(): void;
}) {
  const last = useMemo(loadLastSetup, []);
  const recommended = models.find(model => model.isDefault) ?? models[0];
  const pickModel = (kind: SessionKind): string => {
    const wanted = kind === 'assignment' ? defaults.assignmentModel : str(last.modelId, '');
    return (models.find(model => model.modelId === wanted) ?? recommended)?.modelId ?? '';
  };
  const [kind, setKind] = useState<SessionKind>('interview');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState(str(last.role, ''));
  const [company, setCompany] = useState(str(last.company, ''));
  const [interviewType, setInterviewType] = useState<InterviewType>((['technical', 'behavioral', 'mixed', 'system-design', 'coding'] as const).find(item => item === last.interviewType) ?? 'mixed');
  const [language, setLanguage] = useState(str(last.language, 'English'));
  const [answerLength, setAnswerLength] = useState<AnswerLength>((['short', 'medium', 'detailed'] as const).find(item => item === last.answerLength) ?? 'medium');
  const [explained, setExplained] = useState(true);
  const [preferences, setPreferences] = useState<AnswerPreferences>({ ...DEFAULT_ANSWER_PREFERENCES, ...(typeof last.answerPreferences === 'object' && last.answerPreferences ? last.answerPreferences as Partial<AnswerPreferences> : {}) });
  const [interviewNotes, setInterviewNotes] = useState(defaults.interviewContext);
  const [assignmentNotes, setAssignmentNotes] = useState(defaults.assignmentContext);
  const [modelId, setModelId] = useState(() => pickModel('interview'));
  const [autoAnswer, setAutoAnswer] = useState(true);
  const [saveHistory, setSaveHistory] = useState(true);
  const [problem, setProblem] = useState('');
  const modelTouched = useRef(false);
  const choices = useMemo(() => orderedModels(models), [models]);

  // ── Résumé: uploaded, pasted, or one already saved on the account ─────────────────────────────────────────────────
  const savedResumes = useMemo(() => documents.filter(document => document.kind === 'RESUME'), [documents]);
  const savedJds = useMemo(() => documents.filter(document => document.kind === 'JOB_DESCRIPTION'), [documents]);
  const extraNotes = useMemo(() => documents.filter(document => document.kind === 'SUPPORTING' || document.kind === 'INSTRUCTIONS'), [documents]);
  const [resumeText, setResumeText] = useState('');
  const [resumeName, setResumeName] = useState('');
  const [resumeFrom, setResumeFrom] = useState<'none' | 'upload' | 'saved' | 'typed'>('none');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [resumeNote, setResumeNote] = useState('');
  const [saveResume, setSaveResume] = useState(true);
  const [jd, setJd] = useState('');
  const [jdBusy, setJdBusy] = useState(false);
  const [extraPicked, setExtraPicked] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadSaved = async (id: string, apply: (document: AccountDocument) => void, setBusyState: (value: boolean) => void): Promise<void> => {
    setBusyState(true);
    try { const [document] = await getDocuments([id]); if (document?.body) apply(document); }
    catch { setResumeError('Could not load that saved text. Check your internet and try again.'); }
    finally { setBusyState(false); }
  };
  // The newest saved résumé is ready to use the moment the form opens.
  const preloaded = useRef(false);
  useEffect(() => {
    if (preloaded.current || !savedResumes.length) return;
    preloaded.current = true;
    void loadSaved(savedResumes[0].id, document => { setResumeText(document.body ?? ''); setResumeName(document.name); setResumeFrom('saved'); }, setResumeBusy);
  }, [savedResumes]);

  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setResumeError(''); setResumeNote(''); setResumeBusy(true);
    try {
      const result = await readDocumentText(file);
      setResumeText(result.text); setResumeName(file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'My résumé'); setResumeFrom('upload'); setSaveResume(true);
      if (result.truncated) setResumeNote('Your résumé is very long, so only the first part is used.');
    } catch (failure) {
      setResumeError(failure instanceof DocumentError ? failure.message : 'That file could not be read. Paste the text instead.');
    } finally { setResumeBusy(false); }
  };
  const clearResume = (): void => { setResumeText(''); setResumeName(''); setResumeFrom('none'); setResumeNote(''); setResumeError(''); };

  const changeKind = (next: SessionKind): void => {
    setKind(next);
    // An assignment starts with the model the Admin recommends for tests, unless a model was already chosen by hand.
    if (!modelTouched.current) setModelId(pickModel(next));
  };
  const toggleExtra = (id: string): void => setExtraPicked(current => current.includes(id) ? current.filter(item => item !== id) : current.length >= 6 ? current : [...current, id]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (kind === 'interview' && role.trim().length < 2) { setProblem('Enter the job role you are interviewing for.'); return; }
    if (!modelId) { setProblem('No AI model is available right now. Try again in a moment.'); return; }
    if (resumeBusy || jdBusy) { setProblem('Wait a moment: your résumé is still being read.'); return; }
    setProblem('');
    const resume = kind === 'assignment' ? '' : resumeText.trim();
    onStart({
      kind, title: title.trim(), role: kind === 'assignment' ? 'Assignment' : role.trim(), company: kind === 'assignment' ? 'Assignment' : company.trim(),
      interviewType: kind === 'assignment' ? 'mixed' : interviewType, language: kind === 'assignment' ? 'English' : language.trim() || 'English', answerLength,
      answerStyle: kind === 'assignment' ? (explained ? ASSIGNMENT_STYLE_EXPLAINED : ASSIGNMENT_STYLE_DIRECT) : 'Natural and confident',
      answerPreferences: preferences, instructions: (kind === 'assignment' ? assignmentNotes : interviewNotes).trim(),
      resumeText: resume, jobDescription: kind === 'assignment' ? '' : jd.trim(),
      saveResume: kind === 'interview' && saveResume && resumeFrom !== 'saved' && resume.length >= 40 ? { name: resumeName.trim() || 'My résumé', text: resume } : null,
      docIds: kind === 'assignment' ? [] : extraPicked, modelId, autoAnswer, saveHistory,
    });
  };

  return <form className="lv-stack lv-setup" onSubmit={submit} noValidate>
    <div className="lv-head"><button type="button" className="lv-icon" aria-label="Back" onClick={onBack} disabled={busy}><Icon name="back" /></button><h1>New session</h1></div>
    <div className="lv-seg" role="group" aria-label="Session type">
      <button type="button" aria-pressed={kind === 'interview'} onClick={() => changeKind('interview')}>Interview</button>
      <button type="button" aria-pressed={kind === 'assignment'} onClick={() => changeKind('assignment')}>Assignment</button>
    </div>

    {kind === 'interview' ? <>
      <label className="lv-field"><span>Job role *</span><input value={role} onChange={event => setRole(event.target.value)} placeholder="For example: Java developer" maxLength={160} autoComplete="off" required /></label>
      <label className="lv-field"><span>Company</span><input value={company} onChange={event => setCompany(event.target.value)} placeholder="Optional" maxLength={160} autoComplete="off" /></label>

      <section className="lv-card lv-source" aria-label="Résumé">
        <header><span className="lv-step">1</span><div><h2>Your résumé</h2><p>Upload a PDF, Word or text file so answers use your real experience.</p></div></header>
        <input ref={fileInput} type="file" accept={FILE_TYPES} hidden onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
        {resumeFrom === 'upload' || resumeFrom === 'saved' ? <div className="lv-file">
          <Icon name="check" /><span><b>{resumeName || 'Résumé'}</b><small>{resumeFrom === 'saved' ? 'Saved on your account' : 'Read from your file'} · {words(resumeText).toLocaleString()} words</small></span>
          <button type="button" onClick={clearResume} disabled={busy}>Remove</button>
        </div> : null}
        <button type="button" className="lv-btn ghost block" disabled={resumeBusy || busy} onClick={() => fileInput.current?.click()}>
          <Icon name="upload" />{resumeBusy ? 'Reading your résumé…' : resumeFrom === 'upload' || resumeFrom === 'saved' ? 'Upload a different résumé' : 'Upload résumé'}
        </button>
        {resumeError ? <p className="lv-error" role="alert">{resumeError}</p> : null}
        {resumeNote ? <p className="lv-note">{resumeNote}</p> : null}
        {savedResumes.length > 1 ? <label className="lv-field"><span>Or use another saved résumé</span>
          <select value="" onChange={event => { const id = event.target.value; if (id) void loadSaved(id, document => { setResumeText(document.body ?? ''); setResumeName(document.name); setResumeFrom('saved'); }, setResumeBusy); }}>
            <option value="">Choose…</option>{savedResumes.map(document => <option key={document.id} value={document.id}>{document.name}</option>)}</select></label> : null}
        <label className="lv-field"><span>Résumé text <em>(you can edit it, or paste it here)</em></span>
          <textarea value={resumeText} onChange={event => { setResumeText(event.target.value); setResumeFrom(current => (current === 'saved' || current === 'upload' ? current : event.target.value.trim() ? 'typed' : 'none')); }}
            maxLength={120000} placeholder="Your résumé appears here after you upload it. Or paste it." rows={6} /></label>
        {resumeText.trim().length >= 40 && resumeFrom !== 'saved' ? <label className="lv-switch"><span><b>Save for next time</b><small>Keeps it on your account, also for the Windows app.</small></span>
          <input type="checkbox" checked={saveResume} onChange={event => setSaveResume(event.target.checked)} /><i /></label> : null}
      </section>

      <section className="lv-card lv-source" aria-label="Job description">
        <header><span className="lv-step">2</span><div><h2>Job description</h2><p>Paste it as text so answers fit the role.</p></div></header>
        {savedJds.length ? <label className="lv-field"><span>Use a saved job description</span>
          <select value="" onChange={event => { const id = event.target.value; if (id) void loadSaved(id, document => setJd(document.body ?? ''), setJdBusy); }}>
            <option value="">Choose…</option>{savedJds.map(document => <option key={document.id} value={document.id}>{document.name}</option>)}</select></label> : null}
        <label className="lv-field"><span>Job description text</span>
          <textarea value={jd} onChange={event => setJd(event.target.value)} maxLength={120000} rows={6} placeholder="Paste the job description here" /></label>
        {jd.trim() ? <p className="lv-hint">{words(jd).toLocaleString()} words</p> : null}
      </section>
    </>
      : <>
        <label className="lv-field"><span>Assignment name</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="Optional" maxLength={160} autoComplete="off" /></label>
        <div className="lv-field"><span>Answer style</span>
          <div className="lv-seg" role="group" aria-label="Answer style">
            <button type="button" aria-pressed={!explained} onClick={() => setExplained(false)}>Direct answer</button>
            <button type="button" aria-pressed={explained} onClick={() => setExplained(true)}>With explanation</button>
          </div></div>
        <label className="lv-field"><span>Assignment context</span>
          <textarea value={assignmentNotes} maxLength={4000} onChange={event => setAssignmentNotes(event.target.value)} />
          <small className="lv-hint">Tell the AI what the test covers and how you want the answers. You can change or clear this.</small></label>
      </>}

    <div className="lv-field"><span>Answer length</span>
      <div className="lv-seg" role="group" aria-label="Answer length">
        {(['short', 'medium', 'detailed'] as const).map(value => <button key={value} type="button" aria-pressed={answerLength === value} onClick={() => setAnswerLength(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div></div>
    <label className="lv-field"><span>AI model</span>
      <select value={modelId} onChange={event => { modelTouched.current = true; setModelId(event.target.value); }} disabled={!models.length}>
        {!models.length ? <option value="">No model available</option> : null}
        {choices.quick.length ? <optgroup label="Recommended and fast">{choices.quick.map(model => <option key={model.modelId} value={model.modelId}>{modelChoiceLabel(model)}</option>)}</optgroup> : null}
        {choices.more.length ? <optgroup label="More models">{choices.more.map(model => <option key={model.modelId} value={model.modelId}>{modelChoiceLabel(model)}</option>)}</optgroup> : null}
      </select></label>

    {kind === 'interview' ? <details className="lv-details">
      <summary>More options</summary>
      <div>
        <label className="lv-field"><span>Interview type</span>
          <select value={interviewType} onChange={event => setInterviewType(event.target.value as InterviewType)}>
            <option value="mixed">Mixed</option><option value="technical">Technical</option><option value="behavioral">Behavioral</option>
            <option value="system-design">System design</option><option value="coding">Coding</option>
          </select></label>
        <label className="lv-field"><span>Answer language</span>
          <input list="lv-languages" value={language} onChange={event => setLanguage(event.target.value)} maxLength={40} autoComplete="off" />
          <datalist id="lv-languages">{LANGUAGES.map(item => <option key={item} value={item} />)}</datalist></label>
        <label className="lv-field"><span>Notes for the AI</span>
          <textarea value={interviewNotes} maxLength={4000} onChange={event => setInterviewNotes(event.target.value)} />
          <small className="lv-hint">Tell the AI how you want to sound. You can change or clear this.</small></label>
        {FORMATS.map(item => <label className="lv-switch" key={item.key}><span><b>{item.label}</b><small>{item.hint}</small></span>
          <input type="checkbox" checked={preferences[item.key]} onChange={event => setPreferences(current => ({ ...current, [item.key]: event.target.checked }))} /><i /></label>)}
        {extraNotes.length ? <div className="lv-docs"><span className="lv-label">Other saved notes to use</span>{extraNotes.map(document => <label key={document.id} className={`lv-doc${extraPicked.includes(document.id) ? ' on' : ''}`}>
          <input type="checkbox" checked={extraPicked.includes(document.id)} onChange={() => toggleExtra(document.id)} />
          <span><b>{document.name}</b><small>{document.kind === 'INSTRUCTIONS' ? 'Instructions' : 'Supporting notes'} · {Math.max(1, Math.round(document.bytes / 1024))} KB</small></span></label>)}</div> : null}
      </div>
    </details> : null}

    <section className="lv-card" aria-label="During the session">
      <label className="lv-switch"><span><b>Auto Answer</b><small>Answer every question you hear by itself.</small></span>
        <input type="checkbox" checked={autoAnswer} onChange={event => setAutoAnswer(event.target.checked)} /><i /></label>
      <label className="lv-switch"><span><b>Save to my history</b><small>Keeps the questions and answers. They also show in the Windows app.</small></span>
        <input type="checkbox" checked={saveHistory} onChange={event => setSaveHistory(event.target.checked)} /><i /></label>
    </section>
    <p className="lv-hint">Place the phone close to the speaker and the microphone hears the interviewer and you. Everything it hears can become a question. Time is used only while the session runs.</p>
    {problem || error ? <p className="lv-error" role="alert">{problem || error}</p> : null}
    <div className="lv-startbar">
      <button type="submit" className="lv-btn block" disabled={busy || resumeBusy}>{busy ? 'Starting…' : <><Icon name="mic" />Start session</>}</button>
      <small>Opens full screen and starts listening.</small>
    </div>
  </form>;
}
