'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type TouchEvent } from 'react';
import type { LiveEngine } from '../../../lib/live/engine';
import type { MicCapture } from '../../../lib/live/mic';
import { PhotoError, preparePhoto, type PreparedPhoto } from '../../../lib/live/photo';
import { historyPayload, saveSession, type ModelOption } from '../../../lib/live/liveApi';
import type { LiveSetup } from '../../../lib/live/types';
import { loadPrefs, savePrefs, type LivePrefs } from './prefs';
import { modelChoiceLabel } from './modelChoices';
import type { Meter } from './meter';
import { Icon } from './icons';
import { copyText } from './TurnCard';
import { Action, AnswerPane, QuestionHeader } from './LiveParts';

const LABEL = { idle: 'Ready', connecting: 'Connecting', listening: 'Listening', reconnecting: 'Reconnecting', ended: 'Ended', error: 'Stopped' } as const;
/** The microphone counts as quiet below this level (0 to 1) ... */
const QUIET_LEVEL = 0.12;
/** ... and the customer is told after this long without anything louder. */
const QUIET_AFTER_MS = 9_000;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return <small>{h ? `${h}:${String(m).padStart(2, '0')}` : String(m)}:{String(s).padStart(2, '0')}</small>;
}

const supportsNativeFullscreen = (): boolean => typeof document !== 'undefined'
  && Boolean(document.documentElement.requestFullscreen || (document.documentElement as unknown as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen);

export function LiveSession({ setup, engine, mic, meter, models, micProblem, onClose }: {
  setup: LiveSetup; engine: LiveEngine; mic: MicCapture; meter: Meter; models: ModelOption[]; micProblem: string;
  onClose(savedId: string | null): void;
}) {
  const snap = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const [prefs, setPrefsState] = useState<LivePrefs>(loadPrefs);
  const [sheet, setSheet] = useState<'none' | 'settings' | 'photo'>('none');
  // The live screen opens full screen: the tap on Start already asked for it.
  const [full, setFull] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('lv-full'));
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [saved, setSaved] = useState<'off' | 'idle' | 'saving' | 'saved' | 'failed'>(setup.saveHistory ? 'idle' : 'off');
  const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  const [top, setTop] = useState(64);
  const scroller = useRef<HTMLDivElement>(null);
  const meterBar = useRef<HTMLElement>(null);
  const fullRef = useRef(full);
  const swipe = useRef<{ x: number; y: number; ok: boolean } | null>(null);
  const setPrefs = (patch: Partial<LivePrefs>): void => setPrefsState(current => { const next = { ...current, ...patch }; savePrefs(next); return next; });

  // ── The page around the live screen ───────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('lv-session');
    const measure = (): void => {
      setHeight(Math.round(window.visualViewport?.height ?? window.innerHeight));
      setTop(Math.round(document.querySelector('.site-header-shell')?.getBoundingClientRect().height ?? 64));
    };
    measure();
    window.visualViewport?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    return () => {
      // Full screen belongs to the page that started the session (it also ends it); only this screen's own mark goes here.
      root.classList.remove('lv-session');
      window.visualViewport?.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  const toggleFull = async (): Promise<void> => {
    const next = !fullRef.current;
    fullRef.current = next; setFull(next);
    document.documentElement.classList.toggle('lv-full', next);
    const element = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    try {
      if (next) { if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' }); else await element.webkitRequestFullscreen?.(); }
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch { /* the page is still full screen without the browser's help */ }
  };
  useEffect(() => {
    const onChange = (): void => {
      if (!document.fullscreenElement && fullRef.current && supportsNativeFullscreen()) { fullRef.current = false; setFull(false); document.documentElement.classList.remove('lv-full'); }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ── Keep the screen on, and recover after the phone slept ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!prefs.keepAwake || !('wakeLock' in navigator)) return undefined;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async (): Promise<void> => {
      try { const next = await navigator.wakeLock.request('screen'); if (stopped) void next.release(); else lock = next; } catch { /* not allowed right now */ }
    };
    void acquire();
    const visible = (): void => { if (document.visibilityState === 'visible') void acquire(); };
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; document.removeEventListener('visibilitychange', visible); void lock?.release().catch(() => undefined); };
  }, [prefs.keepAwake]);
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
      void mic.revive();
      engine.wake(away);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [engine, mic]);
  const active = snap.status === 'connecting' || snap.status === 'listening' || snap.status === 'reconnecting';
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  // The microphone's level: drawn straight onto the bar, and used to say so when the phone cannot hear the customer.
  useEffect(() => {
    let quietSince = Date.now();
    const unsubscribe = meter.subscribe(level => {
      meterBar.current?.style.setProperty('--level', String(Math.min(1, level)));
      if (level >= QUIET_LEVEL) quietSince = Date.now();
    });
    const timer = setInterval(() => {
      const listening = engine.snapshot().status === 'listening' && !engine.snapshot().paused;
      setQuiet(listening && Date.now() - quietSince > QUIET_AFTER_MS);
    }, 1_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [meter, engine]);

  // ── History: saved a moment after each finished answer, and once more when the session ends ───────────────────────
  const chain = useRef<Promise<void>>(Promise.resolve());
  const lastSaved = useRef('');
  const persist = useCallback((final: boolean): Promise<void> => {
    if (!setup.saveHistory) return Promise.resolve();
    chain.current = chain.current.then(async () => {
      const current = engine.snapshot();
      const finished = current.turns.filter(turn => (turn.state === 'done' || turn.state === 'cancelled') && turn.answer.trim());
      if (!finished.length) return;
      const signature = `${finished.map(turn => `${turn.id}${turn.state}${turn.answer.length}`).join('|')}|${current.modelId}|${final}`;
      if (signature === lastSaved.current) return;
      setSaved('saving');
      try { await saveSession(historyPayload(setup, current, final ? new Date().toISOString() : null)); lastSaved.current = signature; setSaved('saved'); }
      catch { setSaved('failed'); }
    });
    return chain.current;
  }, [engine, setup]);
  const finishedSignature = snap.turns.map(turn => (turn.state === 'writing' ? '' : `${turn.id}${turn.state}${turn.answer.length}`)).join('|');
  useEffect(() => {
    if (!setup.saveHistory || !finishedSignature.replace(/\|/g, '')) return undefined;
    const timer = setTimeout(() => { void persist(false); }, 2_500);
    return () => clearTimeout(timer);
  }, [finishedSignature, persist, setup.saveHistory]);
  useEffect(() => {
    const flush = (): void => { if (document.visibilityState === 'hidden') void persist(false); };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [persist]);

  // ── The session ended on its own (the connection could not be restored) ───────────────────────────────────────────
  useEffect(() => { if (snap.status === 'error') void mic.stop(); }, [snap.status, mic]);

  const end = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    engine.stop();
    await mic.stop();
    await Promise.race([persist(true), new Promise<void>(resolve => setTimeout(resolve, 8_000))]);
    const any = engine.snapshot().turns.some(turn => turn.answer.trim());
    onClose(setup.saveHistory && any ? setup.id : null);
  };
  const stopPressed = (): void => {
    if (!confirmStop && active) { setConfirmStop(true); setTimeout(() => setConfirmStop(false), 3_000); return; }
    void end();
  };

  // ── One question at a time ────────────────────────────────────────────────────────────────────────────────────────
  const turns = snap.turns;
  const index = pinned ? Math.max(0, turns.findIndex(turn => turn.id === pinned)) : turns.length - 1;
  const current = turns[index];
  // A new question always takes over the screen.
  useEffect(() => { setPinned(null); }, [snap.questionSequence]);
  const go = useCallback((target: number): void => {
    const next = Math.max(0, Math.min(turns.length - 1, target));
    setPinned(next >= turns.length - 1 ? null : turns[next].id);
  }, [turns]);
  const swipeStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    swipe.current = { x: touch.clientX, y: touch.clientY, ok: !(event.target as Element).closest('pre') };
  };
  const swipeEnd = (event: TouchEvent): void => {
    const start = swipe.current; swipe.current = null;
    if (!start?.ok || turns.length < 2) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50 && Math.abs(dx) > Math.abs(dy) * 1.8) go(index + (dx < 0 ? 1 : -1));
  };
  const retry = useCallback((id: string): void => { void engine.retry(id); }, [engine]);
  const copy = useCallback((value: string): void => {
    void copyText(value).then(ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1_500); } });
  }, []);

  // ── Typing and photos ─────────────────────────────────────────────────────────────────────────────────────────────
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = text.trim();
    if (!value || snap.status !== 'listening') return;
    setText('');
    void engine.ask(value);
  };
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [photoNote, setPhotoNote] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const picked = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setPhotoError(''); setPhotoBusy(true); setPhoto(null);
    try { setPhoto(await preparePhoto(file)); }
    catch (error) { setPhotoError(error instanceof PhotoError ? error.message : 'The photo could not be prepared. Try again.'); }
    finally { setPhotoBusy(false); }
  };
  const model = models.find(item => item.modelId === snap.modelId);
  const canSeePhotos = model ? model.image : setup.modelReadsImages;
  const sendPhoto = async (): Promise<void> => {
    if (!photo) return;
    const sent = await engine.askPhoto({ data: photo.data, mimeType: photo.mimeType, preview: photo.preview, note: photoNote });
    if (sent) { setSheet('none'); setPhoto(null); setPhotoNote(''); }
  };
  const closePhoto = (): void => { setSheet('none'); setPhoto(null); setPhotoNote(''); setPhotoError(''); };

  const label = snap.paused && snap.status === 'listening' ? 'Paused' : LABEL[snap.status];
  const hearing = snap.heard || snap.collected;
  const offset = full ? 0 : top;
  const lastIndex = turns.length - 1;
  return <div className="lv-live" style={{ height: Math.max(0, height - offset), top: offset, ['--lv-font' as string]: `${prefs.font}px` }}>
    <header className="lv-bar">
      <div className="lv-status" role="status" aria-live="polite">
        <span className={`lv-dot ${snap.paused ? '' : snap.status}`} aria-hidden="true" />
        <div><b>{label}</b>{snap.startedAt ? <Elapsed since={snap.startedAt} /> : null}</div>
      </div>
      <nav className="lv-actions" aria-label="Session controls">
        <Action icon={snap.paused ? 'play' : 'pause'} label={snap.paused ? 'Resume' : 'Pause'} pressed={snap.paused} disabled={!active}
          title={snap.paused ? 'Resume listening' : 'Stop listening for a while'} onClick={() => engine.pause(!snap.paused)} />
        <Action icon="settings" label="Settings" onClick={() => setSheet('settings')} />
        <Action icon={full ? 'shrink' : 'expand'} label={full ? 'Exit full' : 'Full screen'} pressed={full} onClick={() => void toggleFull()} />
        <Action icon={confirmStop || !active ? null : 'stop'} label={confirmStop ? 'Tap to end' : !active ? 'Close' : 'End'} danger disabled={stopping}
          title={confirmStop ? 'Tap again to end the session' : 'End the session'} onClick={stopPressed} />
      </nav>
      <i className="lv-meter" aria-hidden="true" ref={meterBar as React.RefObject<HTMLElement>} />
    </header>
    {snap.status === 'reconnecting' ? <p className="lv-banner" role="status">Reconnecting… your answers are safe. Keep this screen open.</p> : null}
    {snap.status === 'error' ? <p className="lv-banner bad" role="alert">{snap.message}</p> : null}
    {micProblem && active ? <p className="lv-banner bad" role="alert">{micProblem}</p> : null}
    {quiet && active && !snap.paused ? <p className="lv-banner" role="status">The phone can hardly hear anything. Hold it closer to the speaker or to you, and check that Voice boost is on in Settings.</p> : null}

    <main className="lv-stage" onTouchStart={swipeStart} onTouchEnd={swipeEnd}>
      {current ? <>
        <QuestionHeader turn={current} number={index + 1} total={turns.length} />
        <div className="lv-answer" ref={scroller}>
          <AnswerPane turn={current} onRetry={retry} onCopy={copy} copied={copied} follow={prefs.autoScroll} scroller={scroller} />
        </div>
      </> : <div className="lv-empty"><Icon name="mic" /><b>{snap.status === 'connecting' ? 'Connecting…' : 'Listening'}</b>
        <span>{snap.autoAnswer ? 'Ask a question out loud and its answer appears here by itself. You can also type a question or send a photo below.'
          : 'Questions you hear are collected below. Tap Send to get the answer. You can also type a question or send a photo.'}</span></div>}
    </main>

    {turns.length > 1 ? <nav className="lv-nav" aria-label="Questions">
      <button type="button" onClick={() => go(index - 1)} disabled={index <= 0}><Icon name="back" /><span>Previous</span></button>
      <span className="lv-count" aria-live="polite">{index + 1}<i> / {turns.length}</i></span>
      <button type="button" onClick={() => go(index + 1)} disabled={index >= lastIndex}><span>Next</span><Icon name="forward" /></button>
    </nav> : null}

    <div className="lv-dock">
      {hearing && !snap.paused ? <div className="lv-heard" aria-live="polite">
        <span className="lv-wave" aria-hidden="true"><i /><i /><i /><i /></span>
        <div><small>Hearing</small><p>{snap.heard || snap.collected}</p></div>
        {!snap.autoAnswer && snap.collected ? <button type="button" className="lv-btn small" onClick={() => void engine.sendCollected()}>Send</button> : null}
        <button type="button" className="lv-clear" aria-label="Clear what was heard" title="Clear what was heard" onClick={() => engine.clearInput()}><Icon name="close" /></button>
      </div> : snap.message ? <p className="lv-hint" role="status">{snap.message}</p> : null}
      <form className="lv-compose" onSubmit={submit}>
        <button type="button" className="lv-side" title="Send a photo of a question" disabled={snap.status !== 'listening'} onClick={() => setSheet('photo')}><Icon name="camera" /><span>Photo</span></button>
        <input value={text} onChange={event => setText(event.target.value)} placeholder="Type a question…" enterKeyHint="send" autoComplete="off" autoCorrect="on"
          aria-label="Type a question" disabled={snap.status === 'error' || snap.status === 'ended'} maxLength={4000} />
        <button type="submit" className="lv-side go" title="Ask this question" disabled={!text.trim() || snap.status !== 'listening'}><Icon name="send" /><span>Ask</span></button>
      </form>
    </div>

    {sheet === 'settings' ? <div className="lv-sheet-wrap" onClick={event => { if (event.target === event.currentTarget) setSheet('none'); }}>
      <section className="lv-sheet" role="dialog" aria-modal="true" aria-label="Session settings">
        <header><h2>Settings</h2><button type="button" className="lv-icon" aria-label="Close settings" onClick={() => setSheet('none')}><Icon name="close" /></button></header>
        <div className="lv-stack">
          <label className="lv-switch"><span><b>Auto Answer</b><small>Answer every question you hear by itself.</small></span>
            <input type="checkbox" checked={snap.autoAnswer} onChange={event => engine.setAutoAnswer(event.target.checked)} /><i /></label>
          <label className="lv-switch"><span><b>Auto Scroll</b><small>Follow the answer as it is written. Turn off to scroll yourself.</small></span>
            <input type="checkbox" checked={prefs.autoScroll} onChange={event => setPrefs({ autoScroll: event.target.checked })} /><i /></label>
          <label className="lv-switch"><span><b>Keep screen on</b><small>Stops the phone from locking during the session.</small></span>
            <input type="checkbox" checked={prefs.keepAwake} onChange={event => setPrefs({ keepAwake: event.target.checked })} /><i /></label>
          <hr />
          <label className="lv-switch"><span><b>Voice boost</b><small>Lifts a quiet or distant voice to a steady level so it is heard better.</small></span>
            <input type="checkbox" checked={prefs.boost} onChange={event => { setPrefs({ boost: event.target.checked }); mic.setOptions({ boost: event.target.checked }); }} /><i /></label>
          <label className="lv-switch"><span><b>Reduce background noise</b><small>Helps in a loud room. Turn it off if your voice sounds cut or is missed.</small></span>
            <input type="checkbox" checked={prefs.noiseReduction} onChange={event => { setPrefs({ noiseReduction: event.target.checked }); mic.setOptions({ noiseReduction: event.target.checked }); }} /><i /></label>
          <hr />
          <div className="lv-field"><span>Text size</span>
            <div className="lv-size">
              <button type="button" className="lv-icon" aria-label="Smaller text" disabled={prefs.font <= 14} onClick={() => setPrefs({ font: Math.max(14, prefs.font - 1) })}>A−</button>
              <b>{prefs.font}</b>
              <button type="button" className="lv-icon" aria-label="Larger text" disabled={prefs.font >= 28} onClick={() => setPrefs({ font: Math.min(28, prefs.font + 1) })}>A+</button>
            </div></div>
          <div className="lv-field"><span>Answer length</span>
            <div className="lv-seg" role="group" aria-label="Answer length">
              {(['short', 'medium', 'detailed'] as const).map(value => <button key={value} type="button" aria-pressed={snap.answerLength === value} onClick={() => engine.setAnswerLength(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
            </div></div>
          <label className="lv-field"><span>AI model</span>
            <select value={snap.modelId} onChange={event => { const next = models.find(item => item.modelId === event.target.value); if (next) engine.setModel(next.modelId, next.image); }}>
              {models.map(item => <option key={item.modelId} value={item.modelId}>{modelChoiceLabel(item)}</option>)}
            </select></label>
          <button type="button" className="lv-btn ghost" onClick={() => { engine.clearInput(); setSheet('none'); }}>Clear what was heard</button>
          <p className="lv-hint">{saved === 'off' ? 'This session is not being saved to your history.' : saved === 'saved' ? 'Saved to your history. It also shows in the Windows app.'
            : saved === 'saving' ? 'Saving to your history…' : saved === 'failed' ? 'Could not save to your history just now. It will try again after the next answer.'
            : 'Answers are saved to your history as they finish. They also show in the Windows app.'}</p>
          {!supportsNativeFullscreen() ? <p className="lv-hint">On iPhone, tap Share and Add to Home Screen to open Cluera without the browser bars.</p> : null}
        </div>
      </section>
    </div> : null}

    {sheet === 'photo' ? <div className="lv-sheet-wrap" onClick={event => { if (event.target === event.currentTarget) closePhoto(); }}>
      <section className="lv-sheet" role="dialog" aria-modal="true" aria-label="Send a photo">
        <header><h2>Send a photo</h2><button type="button" className="lv-icon" aria-label="Close" onClick={closePhoto}><Icon name="close" /></button></header>
        <div className="lv-stack">
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={event => { void picked(event.target.files?.[0]); event.target.value = ''; }} />
          <input ref={gallery} type="file" accept="image/*" hidden onChange={event => { void picked(event.target.files?.[0]); event.target.value = ''; }} />
          {!canSeePhotos ? <p className="lv-note">The selected AI model cannot read photos. Open Settings and choose another model first.</p> : null}
          {photoError ? <p className="lv-error" role="alert">{photoError}</p> : null}
          {photoBusy ? <p className="lv-hint" role="status">Preparing the photo…</p> : null}
          {photo ? <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="lv-preview" src={photo.preview} alt="The photo that will be sent" />
            <label className="lv-field"><span>What should the AI answer? (optional)</span>
              <input value={photoNote} onChange={event => setPhotoNote(event.target.value)} maxLength={400} placeholder="For example: question 3 only" enterKeyHint="send" /></label>
            <p className="lv-hint">Reduced to {Math.round(photo.bytes / 1024)} KB so it sends fast.</p>
            <button type="button" className="lv-btn block" disabled={!canSeePhotos || snap.status !== 'listening'} onClick={() => void sendPhoto()}>Send to AI</button>
          </> : null}
          <button type="button" className="lv-btn block" disabled={photoBusy} onClick={() => camera.current?.click()}><Icon name="camera" />{photo ? 'Take another photo' : 'Take a photo'}</button>
          <button type="button" className="lv-btn ghost block" disabled={photoBusy} onClick={() => gallery.current?.click()}><Icon name="image" />Choose from gallery</button>
        </div>
      </section>
    </div> : null}
  </div>;
}
