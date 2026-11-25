'use client';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { AnswerLength, AnswerPreferences, InterviewType, SessionKind } from '../../../../desktop/src/shared/types';
import { DEFAULT_ANSWER_PREFERENCES } from '../../../../desktop/src/shared/answerPreferences';
import { ASSIGNMENT_STYLE_DIRECT, ASSIGNMENT_STYLE_EXPLAINED } from '../../../../desktop/src/shared/sessionKinds';
import { LiveApiError, saveDocument, type AccountDocument, type DocumentKind, type ModelOption, type SessionDefaults } from '../../../lib/live/liveApi';
import { loadLastSetup } from './prefs';
import { modelChoiceLabel, orderedModels } from './modelChoices';
import { Icon } from './icons';

/** What the setup screen collects; the saved documents are read when the session starts. */
export interface SetupDraft {
  kind: SessionKind; title: string; role: string; company: string; interviewType: InterviewType; language: string;
  answerLength: AnswerLength; answerStyle: string; answerPreferences: AnswerPreferences; instructions: string;
  docIds: string[]; modelId: string; autoAnswer: boolean; saveHistory: boolean;
}

const KIND_LABEL: Record<DocumentKind, string> = { RESUME: 'Résumé', JOB_DESCRIPTION: 'Job description', SUPPORTING: 'Supporting notes', INSTRUCTIONS: 'Instructions' };
const LANGUAGES = ['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Spanish', 'French', 'German'];
const FORMATS: Array<{ key: keyof AnswerPreferences; label: string; hint: string }> = [
  { key: 'scriptWithBullets', label: 'Opening line, then bullets', hint: 'One line to say first, then short supporting points.' },
  { key: 'fullScript', label: 'Full script', hint: 'An answer to read word for word.' },
  { key: 'bullets', label: 'Bullets only', hint: 'Short points to say in your own words.' },
  { key: 'fillerWords', label: 'Natural speech', hint: 'Small pauses and connecting words, like real talking.' },
];

function str(value: unknown, fallback: string): string { return typeof value === 'string' && value ? value : fallback; }

export function SetupForm({ models, defaults, documents, busy, error, onStart, onBack, onDocumentsChanged }: {
  models: ModelOption[]; defaults: SessionDefaults; documents: AccountDocument[]; busy: boolean; error: string;
  onStart(draft: SetupDraft): void; onBack(): void; onDocumentsChanged(): Promise<AccountDocument[]>;
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
  const [picked, setPicked] = useState<string[]>(() => {
    const newest = documents.find(document => document.kind === 'RESUME');
    return newest ? [newest.id] : [];
  });
  const [autoAnswer, setAutoAnswer] = useState(true);
  const [saveHistory, setSaveHistory] = useState(true);
  const [problem, setProblem] = useState('');
  const modelTouched = useRef(false);
  const choices = useMemo(() => orderedModels(models), [models]);

  const changeKind = (next: SessionKind): void => {
    setKind(next);
    // An assignment starts with the model the Admin recommends for tests, unless a model was already chosen by hand.
    if (!modelTouched.current) setModelId(pickModel(next));
  };

  // Adding a résumé or notes right here
  const [adding, setAdding] = useState(false);
  const [addKind, setAddKind] = useState<DocumentKind>('RESUME');
  const [addName, setAddName] = useState('');
  const [addBody, setAddBody] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');
  const loadFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setAddError('');
    if (file.size > 400_000) { setAddError('That file is too large. Use a text file up to 120 KB, or paste the text.'); return; }
    if (!/\.(txt|md|markdown)$/i.test(file.name) && !file.type.startsWith('text/')) {
      setAddError('Only text files (.txt or .md) can be read on a phone. For PDF or Word, paste the text, or add it once in the Windows app.'); return;
    }
    setAddBody((await file.text()).slice(0, 120_000));
    if (!addName.trim()) setAddName(file.name.replace(/\.[^.]+$/, '').slice(0, 120));
  };
  const saveAdded = async (): Promise<void> => {
    const body = addBody.trim(), name = addName.trim();
    if (!name || !body) { setAddError('Give it a name and some text.'); return; }
    if (new TextEncoder().encode(body).length > 120_000) { setAddError('That text is longer than 120 KB. Shorten it a little.'); return; }
    setAddBusy(true); setAddError('');
    try {
      const id = await saveDocument({ kind: addKind, name, body });
      await onDocumentsChanged();
      setPicked(current => [...new Set([...current, id])].slice(0, 8));
      setAdding(false); setAddName(''); setAddBody('');
    } catch (failure) {
      setAddError(failure instanceof LiveApiError && failure.kind === 'invalid' ? 'Could not save. You may already have 20 saved items; delete one in My account.' : failure instanceof Error ? failure.message : 'Could not save.');
    } finally { setAddBusy(false); }
  };

  const toggleDoc = (id: string): void => setPicked(current => current.includes(id) ? current.filter(item => item !== id) : current.length >= 8 ? current : [...current, id]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (kind === 'interview' && role.trim().length < 2) { setProblem('Enter the job role you are interviewing for.'); return; }
    if (!modelId) { setProblem('No AI model is available right now. Try again in a moment.'); return; }
    setProblem('');
    onStart({
      kind, title: title.trim(), role: kind === 'assignment' ? 'Assignment' : role.trim(), company: kind === 'assignment' ? 'Assignment' : company.trim(),
      interviewType: kind === 'assignment' ? 'mixed' : interviewType, language: kind === 'assignment' ? 'English' : language.trim() || 'English', answerLength,
      answerStyle: kind === 'assignment' ? (explained ? ASSIGNMENT_STYLE_EXPLAINED : ASSIGNMENT_STYLE_DIRECT) : 'Natural and confident',
      answerPreferences: preferences, instructions: (kind === 'assignment' ? assignmentNotes : interviewNotes).trim(),
      docIds: kind === 'assignment' ? [] : picked, modelId, autoAnswer, saveHistory,
    });
  };

  return <form className="lv-stack" onSubmit={submit} noValidate>
    <div className="lv-head"><button type="button" className="lv-icon" aria-label="Back" onClick={onBack} disabled={busy}><Icon name="back" /></button><h1>New session</h1></div>
    <div className="lv-seg" role="group" aria-label="Session type">
      <button type="button" aria-pressed={kind === 'interview'} onClick={() => changeKind('interview')}>Interview</button>
      <button type="button" aria-pressed={kind === 'assignment'} onClick={() => changeKind('assignment')}>Assignment</button>
    </div>
    {kind === 'interview' ? <>
      <label className="lv-field"><span>Job role *</span><input value={role} onChange={event => setRole(event.target.value)} placeholder="For example: Java developer" maxLength={160} autoComplete="off" required /></label>
      <label className="lv-field"><span>Company</span><input value={company} onChange={event => setCompany(event.target.value)} placeholder="Optional" maxLength={160} autoComplete="off" /></label>
      <label className="lv-field"><span>Interview type</span>
        <select value={interviewType} onChange={event => setInterviewType(event.target.value as InterviewType)}>
          <option value="mixed">Mixed</option><option value="technical">Technical</option><option value="behavioral">Behavioral</option>
          <option value="system-design">System design</option><option value="coding">Coding</option>
        </select></label>
      <label className="lv-field"><span>Answer language</span>
        <input list="lv-languages" value={language} onChange={event => setLanguage(event.target.value)} maxLength={40} autoComplete="off" />
        <datalist id="lv-languages">{LANGUAGES.map(item => <option key={item} value={item} />)}</datalist></label>
    </> : <>
      <label className="lv-field"><span>Assignment name</span><input value={title} onChange={event => setTitle(event.target.value)} placeholder="Optional" maxLength={160} autoComplete="off" /></label>
      <div className="lv-field"><span>Answer style</span>
        <div className="lv-seg" role="group" aria-label="Answer style">
          <button type="button" aria-pressed={!explained} onClick={() => setExplained(false)}>Direct answer</button>
          <button type="button" aria-pressed={explained} onClick={() => setExplained(true)}>With explanation</button>
        </div></div>
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
    <label className="lv-field"><span>{kind === 'assignment' ? 'Assignment context' : 'Notes for the AI'}</span>
      <textarea value={kind === 'assignment' ? assignmentNotes : interviewNotes} maxLength={4000}
        onChange={event => (kind === 'assignment' ? setAssignmentNotes : setInterviewNotes)(event.target.value)} />
      <small className="lv-hint">Tell the AI how you want to sound{kind === 'assignment' ? ' and what the test covers' : ''}. You can change or clear this.</small></label>

    {kind === 'interview' ? <section className="lv-section" aria-label="Résumé and notes">
      <h2>Résumé and notes</h2>
      {documents.length ? <div className="lv-docs">{documents.map(document => <label key={document.id} className={`lv-doc${picked.includes(document.id) ? ' on' : ''}`}>
        <input type="checkbox" checked={picked.includes(document.id)} onChange={() => toggleDoc(document.id)} />
        <span><b>{document.name}</b><small>{KIND_LABEL[document.kind]} · {Math.max(1, Math.round(document.bytes / 1024))} KB</small></span></label>)}</div>
        : <p className="lv-hint">You have not saved a résumé yet. Add one below, or add it once in the Windows app and it appears here.</p>}
      <details className="lv-details" open={adding} onToggle={event => setAdding((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>Add a résumé, job description or notes</summary>
        <div>
          <label className="lv-field"><span>Type</span>
            <select value={addKind} onChange={event => setAddKind(event.target.value as DocumentKind)}>
              {(['RESUME', 'JOB_DESCRIPTION', 'SUPPORTING'] as const).map(value => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}
            </select></label>
          <label className="lv-field"><span>Name</span><input value={addName} onChange={event => setAddName(event.target.value)} maxLength={120} placeholder="For example: My résumé" /></label>
          <label className="lv-field"><span>Text</span><textarea value={addBody} onChange={event => setAddBody(event.target.value)} maxLength={120000} placeholder="Paste the text here" /></label>
          <label className="lv-btn ghost small" style={{ justifySelf: 'start' }}>Load a .txt or .md file
            <input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden onChange={event => { void loadFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
          {addError ? <p className="lv-error" role="alert">{addError}</p> : null}
          <button type="button" className="lv-btn" disabled={addBusy} onClick={() => void saveAdded()}>{addBusy ? 'Saving…' : 'Save to my account'}</button>
          <p className="lv-hint">Saved to your account, so it is also available in the Windows app. PDF and Word files: paste the text, or add them in the Windows app.</p>
        </div>
      </details>
    </section> : null}

    {kind === 'interview' ? <details className="lv-details">
      <summary>Answer format</summary>
      <div>{FORMATS.map(item => <label className="lv-switch" key={item.key}><span><b>{item.label}</b><small>{item.hint}</small></span>
        <input type="checkbox" checked={preferences[item.key]} onChange={event => setPreferences(current => ({ ...current, [item.key]: event.target.checked }))} /><i /></label>)}</div>
    </details> : null}

    <section className="lv-card" aria-label="During the session">
      <label className="lv-switch"><span><b>Auto Answer</b><small>Answer every question you hear by itself.</small></span>
        <input type="checkbox" checked={autoAnswer} onChange={event => setAutoAnswer(event.target.checked)} /><i /></label>
      <label className="lv-switch"><span><b>Save to my history</b><small>Keeps the questions and answers. They also show in the Windows app.</small></span>
        <input type="checkbox" checked={saveHistory} onChange={event => setSaveHistory(event.target.checked)} /><i /></label>
    </section>
    <p className="lv-hint">Place the phone close to the speaker and the microphone hears the interviewer and you. Everything it hears can become a question. Time is used only while the session runs.</p>
    {problem || error ? <p className="lv-error" role="alert">{problem || error}</p> : null}
    <button type="submit" className="lv-btn block" disabled={busy}>{busy ? 'Starting…' : <><Icon name="mic" />Start session</>}</button>
  </form>;
}
