'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LiveEngine } from '../../../lib/live/engine';
import { MicCapture } from '../../../lib/live/mic';
import {
  deleteSession, getAccess, getDocuments, getHome, getModels, listSessions, LiveApiError, readSession,
  type AccountDocument, type ModelOption, type PhoneSession, type PhoneSessionSummary, type SessionDefaults,
} from '../../../lib/live/liveApi';
import type { LiveSetup, LiveTurn, SocketLike } from '../../../lib/live/types';
import { usageDuration } from '../../../lib/usage/display';
import { saveLastSetup } from './prefs';
import { SetupForm, type SetupDraft } from './SetupForm';
import { LiveSession } from './LiveSession';
import { TurnCard } from './TurnCard';
import { Icon } from './icons';
import './live.css';

type View = { name: 'home' } | { name: 'setup' } | { name: 'live' } | { name: 'detail'; id: string };
type Loaded = { documents: AccountDocument[]; availableMilliseconds: number; models: ModelOption[]; defaults: SessionDefaults };

function composeSetup(draft: SetupDraft, documents: AccountDocument[], models: ModelOption[]): LiveSetup {
  const bodies = (kind: AccountDocument['kind']): AccountDocument[] => documents.filter(document => document.kind === kind && document.body);
  const model = models.find(item => item.modelId === draft.modelId);
  const title = draft.title || (draft.kind === 'assignment' ? 'Assignment' : [draft.role, draft.company].filter(Boolean).join(' · '));
  return {
    id: crypto.randomUUID(), kind: draft.kind, title, role: draft.role, company: draft.company, interviewType: draft.interviewType,
    language: draft.language, answerLength: draft.answerLength, answerStyle: draft.answerStyle, answerPreferences: draft.answerPreferences,
    instructions: [draft.instructions, ...bodies('INSTRUCTIONS').map(document => document.body as string)].filter(Boolean).join('\n\n').slice(0, 8_000),
    resumeText: bodies('RESUME').map(document => document.body).join('\n\n').slice(0, 60_000),
    jobDescription: bodies('JOB_DESCRIPTION').map(document => document.body).join('\n\n').slice(0, 30_000),
    supporting: bodies('SUPPORTING').map(document => ({ name: document.name, text: document.body as string })),
    documentNames: documents.map(document => document.name), modelId: draft.modelId, modelReadsImages: Boolean(model?.image),
    autoAnswer: draft.autoAnswer, saveHistory: draft.saveHistory,
  };
}

const dateLine = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

function HistoryDetail({ id, onBack, onDeleted }: { id: string; onBack(): void; onDeleted(): void }) {
  const [session, setSession] = useState<PhoneSession | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let alive = true;
    readSession(id).then(value => { if (alive) setSession(value); }, failure => { if (alive) setError(failure instanceof Error ? failure.message : 'Could not open this session.'); });
    return () => { alive = false; };
  }, [id]);
  const turns: LiveTurn[] = (session?.turns ?? []).map(turn => ({ ...turn, source: turn.source ?? 'voice', state: 'done' as const }));
  return <div className="lv-stack">
    <div className="lv-head"><button type="button" className="lv-icon" aria-label="Back" onClick={onBack}><Icon name="back" /></button><h1>{session?.title ?? 'Session'}</h1></div>
    {error ? <p className="lv-error" role="alert">{error}</p> : null}
    {!session && !error ? <><div className="lv-skeleton" /><div className="lv-skeleton" style={{ height: 160 }} /></> : null}
    {session ? <>
      <p className="lv-sub" style={{ margin: 0 }}>{dateLine(session.startedAt)} · {turns.length} {turns.length === 1 ? 'question' : 'questions'} · {session.model || 'AI model'}</p>
      {turns.length ? turns.map(turn => <TurnCard key={turn.id} turn={turn} />) : <p className="lv-hint">No answers were saved for this session.</p>}
      <button type="button" className="lv-btn danger block" onClick={async () => {
        if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3_000); return; }
        try { await deleteSession(id); onDeleted(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not delete.'); }
      }}><Icon name="trash" />{confirm ? 'Tap again to delete for good' : 'Delete this session'}</button>
    </> : null}
  </div>;
}

export function LiveApp() {
  const [phone, setPhone] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'unavailable'>('loading');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sessions, setSessions] = useState<PhoneSessionSummary[]>([]);
  const [view, setView] = useState<View>({ name: 'home' });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [micProblem, setMicProblem] = useState('');
  const [live, setLive] = useState<{ setup: LiveSetup; engine: LiveEngine; mic: MicCapture } | null>(null);

  useEffect(() => {
    // Phones and tablets: a narrow screen, or a touch screen as the main input. A computer with a mouse is sent to the Windows app.
    const query = window.matchMedia('(max-width: 820px), (pointer: coarse)');
    const update = (): void => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // This page needs its own security settings (the relay and the microphone). A page opened from inside the site keeps
  // the settings of the page it came from, so in that case the page is loaded again once, as a whole.
  useEffect(() => {
    const policy = (document as unknown as { permissionsPolicy?: { allowsFeature(name: string): boolean } }).permissionsPolicy;
    if (!policy || policy.allowsFeature('microphone')) return;
    try {
      const last = Number(sessionStorage.getItem('cluera-live-reload') ?? 0);
      if (Date.now() - last < 15_000) return;
      sessionStorage.setItem('cluera-live-reload', String(Date.now()));
    } catch { /* storage unavailable: reload once anyway */ }
    window.location.assign('/account/live');
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    const [home, catalog, history] = await Promise.allSettled([getHome(), getModels(), listSessions()]);
    const denied = [home, catalog].some(result => result.status === 'rejected' && result.reason instanceof LiveApiError && result.reason.kind === 'signin');
    if (denied) { setState('signed-out'); return; }
    if (home.status === 'rejected' || catalog.status === 'rejected') { setState('unavailable'); return; }
    setLoaded({ documents: home.value.documents, availableMilliseconds: home.value.availableMilliseconds, models: catalog.value.models, defaults: catalog.value.sessionDefaults });
    if (history.status === 'fulfilled') setSessions(history.value);
    setState('ready');
  }, []);
  useEffect(() => { if (phone && !loaded && state === 'loading') void load(); }, [phone, loaded, state, load]);

  const reloadDocuments = useCallback(async (): Promise<AccountDocument[]> => {
    const home = await getHome();
    setLoaded(current => (current ? { ...current, documents: home.documents, availableMilliseconds: home.availableMilliseconds } : current));
    return home.documents;
  }, []);

  /** The tap on Start: the microphone is asked for first, inside the tap, because phones only allow sound that way. */
  const begin = (draft: SetupDraft): void => {
    if (starting || !loaded) return;
    setStarting(true); setStartError(''); setMicProblem('');
    const engine = new LiveEngine({ access: getAccess, openSocket: url => new WebSocket(url) as unknown as SocketLike });
    const mic = new MicCapture();
    const microphone = mic.start(chunk => engine.pushAudio(chunk), message => setMicProblem(message));
    void (async () => {
      try {
        const [documents] = await Promise.all([getDocuments(draft.docIds), microphone]);
        const setup = composeSetup(draft, documents, loaded.models);
        saveLastSetup({ role: draft.role, company: draft.company, interviewType: draft.interviewType, language: draft.language,
          answerLength: draft.answerLength, answerPreferences: draft.answerPreferences, modelId: draft.modelId });
        await engine.start(setup);
        setLive({ setup, engine, mic });
        setView({ name: 'live' });
      } catch (error) {
        engine.stop();
        await mic.stop();
        setStartError(error instanceof Error && error.message ? error.message : 'The session could not start. Try again.');
      } finally { setStarting(false); }
    })();
  };

  const finished = (savedId: string | null): void => {
    setLive(null);
    void listSessions().then(setSessions, () => undefined);
    void reloadDocuments().catch(() => undefined);
    setView(savedId ? { name: 'detail', id: savedId } : { name: 'home' });
  };

  return <div className="lv-root">
    <div className="lv-desktop-note">
      <h1>Live sessions run on your phone</h1>
      <p>Open this page on your phone to start a live session in the browser. On your computer, use the Cluera app for Windows.</p>
      <Link className="button" href="/download">Download for Windows</Link>
    </div>
    {phone ? <div className="lv-app">
      {view.name === 'live' && live ? <LiveSession setup={live.setup} engine={live.engine} mic={live.mic} models={loaded?.models ?? []} micProblem={micProblem} onClose={finished} />
        : view.name === 'detail' ? <HistoryDetail id={view.id} onBack={() => setView({ name: 'home' })} onDeleted={() => { setSessions(list => list.filter(item => item.id !== view.id)); setView({ name: 'home' }); }} />
        : state === 'loading' ? <div className="lv-stack"><div className="lv-skeleton" /><div className="lv-skeleton" style={{ height: 70 }} /><div className="lv-skeleton" /><div className="lv-skeleton" /></div>
        : state === 'signed-out' ? <div className="lv-card lv-stack"><h1 style={{ margin: 0, fontSize: 24 }}>Sign in to continue</h1>
            <p className="lv-sub" style={{ margin: 0 }}>Sign in to your Cluera account to start a live session on this phone.</p>
            <Link className="lv-btn block" href="/account">Sign in</Link></div>
        : state === 'unavailable' || !loaded ? <div className="lv-card lv-stack"><h1 style={{ margin: 0, fontSize: 24 }}>Cluera is not reachable</h1>
            <p className="lv-sub" style={{ margin: 0 }}>Check your internet connection and try again.</p>
            <button type="button" className="lv-btn block" onClick={() => { setLoaded(null); setState('loading'); }}>Try again</button></div>
        : view.name === 'setup' ? <SetupForm models={loaded.models} defaults={loaded.defaults} documents={loaded.documents} busy={starting} error={startError}
            onStart={begin} onBack={() => { setStartError(''); setView({ name: 'home' }); }} onDocumentsChanged={reloadDocuments} />
        : <div className="lv-stack">
          <div className="lv-head"><h1>Live session</h1></div>
          <p className="lv-sub" style={{ margin: 0 }}>Answers to your interview or test questions, on this phone. The microphone listens to the room and answers by itself.</p>
          <div className="lv-balance"><div><small>Time left</small><b>{usageDuration(loaded.availableMilliseconds)}</b></div>
            <Link className="lv-btn ghost small" href="/account/checkout?offer=cluera_pack_3h_v2">Buy time</Link></div>
          {loaded.availableMilliseconds <= 0 ? <p className="lv-note">You have no time left. Buy time to start a session.</p> : null}
          <button type="button" className="lv-btn block" disabled={loaded.availableMilliseconds <= 0} onClick={() => { setStartError(''); setView({ name: 'setup' }); }}><Icon name="plus" />New session</button>
          <section className="lv-section" aria-label="Recent sessions"><h2>Recent sessions</h2>
            {sessions.length ? <ul className="lv-list">{sessions.slice(0, 20).map(item => <li key={item.id}>
              <button type="button" className="lv-row" onClick={() => setView({ name: 'detail', id: item.id })}>
                <span><strong>{item.title}</strong><small>{dateLine(item.startedAt)} · {item.questionCount} {item.questionCount === 1 ? 'question' : 'questions'}</small></span>
                <span className="lv-chip">{item.kind === 'assignment' ? 'Assignment' : 'Interview'}</span></button></li>)}</ul>
              : <p className="lv-hint">Your phone sessions appear here and in the Windows app.</p>}
          </section>
          <Link className="lv-btn ghost block" href="/account">Back to my account</Link>
        </div>}
    </div> : null}
  </div>;
}
