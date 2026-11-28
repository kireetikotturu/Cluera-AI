'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveEngine } from '../../../lib/live/engine';
import { MicCapture } from '../../../lib/live/mic';
import {
  deleteSession, getAccess, getDocuments, getHome, getModels, listSessions, LiveApiError, readSession, saveDocument,
  type AccountDocument, type ModelOption, type PhoneSession, type PhoneSessionSummary, type SessionDefaults,
} from '../../../lib/live/liveApi';
import type { LiveSetup, LiveTurn, SocketLike } from '../../../lib/live/types';
import { usageDuration } from '../../../lib/usage/display';
import { UnlimitedBadge, unlimitedUntil } from '../Unlimited';
import type { UnlimitedAccess } from '../../../../desktop/src/shared/accountCredits';
import { loadPrefs, saveLastSetup } from './prefs';
import { LIVE_PATH, LIVE_SIGN_IN_PATH, LIVE_WELCOME_QUERY } from '../../../lib/live/intent';
import { createMeter } from './meter';
import { sendResume } from '../../../lib/live/resumeUpload';
import { SetupForm, type SetupDraft } from './SetupForm';
import { LiveSession } from './LiveSession';
import { TurnCard } from './TurnCard';
import { Icon } from './icons';
import './live.css';
import './live-screen.css';

type View = { name: 'home' } | { name: 'setup' } | { name: 'live' } | { name: 'detail'; id: string };
type Loaded = { documents: AccountDocument[]; availableMilliseconds: number; unlimited: UnlimitedAccess; models: ModelOption[]; defaults: SessionDefaults };

/** The live screen fills the phone: the site's header goes away and the browser's own bars too, where the phone allows it. */
function enterFullScreen(): void {
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  root.classList.add('lv-full');
  try {
    const request = root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen?.();
    void Promise.resolve(request).catch(() => undefined);
  } catch { /* the page is still full screen without the browser's help */ }
}
function leaveFullScreen(): void {
  document.documentElement.classList.remove('lv-full');
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}

function composeSetup(draft: SetupDraft, documents: AccountDocument[], models: ModelOption[]): LiveSetup {
  const bodies = (kind: AccountDocument['kind']): AccountDocument[] => documents.filter(document => document.kind === kind && document.body);
  const model = models.find(item => item.modelId === draft.modelId);
  const title = draft.title || (draft.kind === 'assignment' ? 'Assignment' : [draft.role, draft.company].filter(Boolean).join(' · '));
  return {
    id: crypto.randomUUID(), kind: draft.kind, title, role: draft.role, company: draft.company, interviewType: draft.interviewType,
    language: draft.language, answerLength: draft.answerLength, answerStyle: draft.answerStyle, answerPreferences: draft.answerPreferences,
    instructions: [draft.instructions, ...bodies('INSTRUCTIONS').map(document => document.body as string)].filter(Boolean).join('\n\n').slice(0, 8_000),
    resumeText: draft.resumeText.slice(0, 100_000),
    jobDescription: draft.jobDescription.slice(0, 60_000),
    supporting: bodies('SUPPORTING').map(document => ({ name: document.name, text: document.body as string })),
    documentNames: [...(draft.resumeText ? ['Résumé'] : []), ...(draft.jobDescription ? ['Job description'] : []), ...documents.map(document => document.name)],
    modelId: draft.modelId, modelReadsImages: Boolean(model?.image),
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
  const [welcome, setWelcome] = useState(false);
  const [micProblem, setMicProblem] = useState('');
  const [live, setLive] = useState<{ setup: LiveSetup; engine: LiveEngine; mic: MicCapture } | null>(null);
  const meter = useMemo(createMeter, []);
  // Leaving the page for any reason also leaves full screen, so the site's header never stays hidden.
  useEffect(() => leaveFullScreen, []);
  // Arriving from "Create session" after signing in: a short welcome, shown once (the address is cleaned straight away).
  useEffect(() => {
    try {
      const query = new URLSearchParams(window.location.search);
      if (query.get(LIVE_WELCOME_QUERY) !== '1') return;
      setWelcome(true);
      window.history.replaceState(null, '', window.location.pathname);
    } catch { /* the welcome is a courtesy only */ }
  }, []);

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
    window.location.assign(`${LIVE_PATH}${window.location.search}`);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    const [home, catalog, history] = await Promise.allSettled([getHome(), getModels(), listSessions()]);
    const denied = [home, catalog].some(result => result.status === 'rejected' && result.reason instanceof LiveApiError && result.reason.kind === 'signin');
    if (denied) { setState('signed-out'); return; }
    if (home.status === 'rejected' || catalog.status === 'rejected') { setState('unavailable'); return; }
    setLoaded({ documents: home.value.documents, availableMilliseconds: home.value.availableMilliseconds, unlimited: home.value.unlimited, models: catalog.value.models, defaults: catalog.value.sessionDefaults });
    if (history.status === 'fulfilled') setSessions(history.value);
    setState('ready');
  }, []);
  useEffect(() => { if (phone && !loaded && state === 'loading') void load(); }, [phone, loaded, state, load]);

  const reloadDocuments = useCallback(async (): Promise<AccountDocument[]> => {
    const home = await getHome();
    setLoaded(current => (current ? { ...current, documents: home.documents, availableMilliseconds: home.availableMilliseconds, unlimited: home.unlimited } : current));
    return home.documents;
  }, []);

  /** The tap on Start: the microphone is asked for first, inside the tap, because phones only allow sound that way. */
  const begin = (draft: SetupDraft): void => {
    if (starting || !loaded) return;
    setStarting(true); setStartError(''); setMicProblem('');
    // Everything below that needs the tap (full screen, the microphone) is asked for first, before anything is awaited.
    enterFullScreen();
    const engine = new LiveEngine({ access: getAccess, openSocket: url => new WebSocket(url) as unknown as SocketLike });
    const prefs = loadPrefs();
    const mic = new MicCapture({ boost: prefs.boost, noiseReduction: prefs.noiseReduction });
    meter.set(0);
    const microphone = mic.start(chunk => engine.pushAudio(chunk), message => setMicProblem(message), level => meter.set(level));
    void (async () => {
      try {
        const [documents] = await Promise.all([getDocuments(draft.docIds), microphone]);
        const setup = composeSetup(draft, documents, loaded.models);
        saveLastSetup({ role: draft.role, company: draft.company, interviewType: draft.interviewType, language: draft.language,
          answerLength: draft.answerLength, answerPreferences: draft.answerPreferences, modelId: draft.modelId });
        await engine.start(setup);
        setLive({ setup, engine, mic });
        setView({ name: 'live' });
        // The résumé used in this session is also saved on the account, in the background.
        if (setup.resumeText.trim()) void sendResume({ text: setup.resumeText, name: draft.resumeName, file: draft.resumeFile, sessionRef: setup.id });
        // A résumé uploaded or pasted for this session is kept for next time, unless the customer turned that off.
        const keep = draft.saveResume;
        if (keep && !loaded.documents.some(document => document.kind === 'RESUME' && document.name === keep.name)) {
          void saveDocument({ kind: 'RESUME', name: keep.name, body: keep.text }).then(() => reloadDocuments(), () => undefined);
        }
      } catch (error) {
        engine.stop();
        await mic.stop();
        leaveFullScreen();
        setStartError(error instanceof Error && error.message ? error.message : 'The session could not start. Try again.');
      } finally { setStarting(false); }
    })();
  };

  const finished = (savedId: string | null): void => {
    leaveFullScreen();
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
      {view.name === 'live' && live ? <LiveSession setup={live.setup} engine={live.engine} mic={live.mic} meter={meter} models={loaded?.models ?? []} micProblem={micProblem} onClose={finished} />
        : view.name === 'detail' ? <HistoryDetail id={view.id} onBack={() => setView({ name: 'home' })} onDeleted={() => { setSessions(list => list.filter(item => item.id !== view.id)); setView({ name: 'home' }); }} />
        : state === 'loading' ? <div className="lv-stack"><div className="lv-skeleton" /><div className="lv-skeleton" style={{ height: 70 }} /><div className="lv-skeleton" /><div className="lv-skeleton" /></div>
        : state === 'signed-out' ? <div className="lv-card lv-stack"><h1 style={{ margin: 0, fontSize: 24 }}>Sign in to continue</h1>
            <p className="lv-sub" style={{ margin: 0 }}>Sign in to your Cluera account to create a session on this phone. New accounts get 15 free minutes.</p>
            <a className="lv-btn block" href={LIVE_SIGN_IN_PATH}>Sign in</a></div>
        : state === 'unavailable' || !loaded ? <div className="lv-card lv-stack"><h1 style={{ margin: 0, fontSize: 24 }}>Cluera is not reachable</h1>
            <p className="lv-sub" style={{ margin: 0 }}>Check your internet connection and try again.</p>
            <button type="button" className="lv-btn block" onClick={() => { setLoaded(null); setState('loading'); }}>Try again</button></div>
        : view.name === 'setup' ? <SetupForm models={loaded.models} defaults={loaded.defaults} documents={loaded.documents} busy={starting} error={startError}
            onStart={begin} onBack={() => { setStartError(''); setView({ name: 'home' }); }} />
        : <div className="lv-stack">
          <div className="lv-head"><h1>Live session</h1></div>
          {welcome ? <div className="lv-welcome" role="status"><b>Welcome to Cluera</b>
            <span>{loaded.unlimited ? 'Unlimited time is ready to use.' : loaded.availableMilliseconds > 0 ? `${usageDuration(loaded.availableMilliseconds)} ready to use. Your first 15 minutes are free.` : 'Your account is ready.'}</span></div> : null}
          <p className="lv-sub" style={{ margin: 0 }}>Answers to your interview or test questions, on this phone. The microphone listens to the room and answers by itself.</p>
          <div className="lv-balance"><div><small>Time left</small><b>{loaded.unlimited ? <UnlimitedBadge large /> : usageDuration(loaded.availableMilliseconds)}</b>{loaded.unlimited ? <small>{unlimitedUntil(loaded.unlimited.endsAt)}</small> : null}</div>
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
