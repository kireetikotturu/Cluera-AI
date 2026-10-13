import {
  ArrowRight, CalendarDays, CircleUserRound, FileText, FolderOpen, MoreHorizontal, Plus,
  Search, Settings2, Shrink, SunMedium, Trash2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SessionDetail } from '../../shared/types';
import { useAppStore } from '../stores/appStore';
import { ThemeControl } from '../components/ThemeControl';
import { PrivateModeControl } from '../components/PrivateModeControl';
import { SupportDialog } from '../components/SupportDialog';
import { filterSessions } from '../services/sessionSearch';
import { requireSessionProviderSetup } from '../services/providerSetup';
import clueraLogo from '../assets/cluera-ai.svg';
import type {AccountView} from '../../shared/accounts';
import {AccountCreditsSection} from '../components/AccountCreditsSection';

const formatDate = (value: string): string => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric',
}).format(new Date(value));

const dayGroup = (value: string): string => {
  const date = new Date(value);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - target) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
};

const sessionDuration = (detail?: SessionDetail): string => {
  if (!detail?.conversation.length && !detail?.rounds?.length) return 'Not started';
  const times = detail.conversation.map((turn) => new Date(turn.createdAt).getTime()).filter(Number.isFinite);
  const duration = detail.rounds?.length ? detail.rounds.reduce((total, round) => total + Math.max(0,
    new Date(round.endedAt ?? round.startedAt).getTime() - new Date(round.startedAt).getTime()), 0)
    : times.length ? Math.max(...times) - Math.min(...times) : 0;
  const minutes = Math.max(1, Math.ceil(duration / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

const companyInitials = (session: Session): string => (session.company || session.role)
  .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'M';

interface HomePageProps { onCollapse(): void; customerName?: string; account:AccountView }

export function HomePage({ onCollapse, customerName, account }: HomePageProps): JSX.Element {
  const sessions = useAppStore((state) => state.sessions);
  const activeId = useAppStore((state) => state.activeSessionId);
  const copilotStatus = useAppStore((state) => state.copilotStatus);
  const setPage = useAppStore((state) => state.setPage);
  const setActive = useAppStore((state) => state.setActiveSession);
  const setSessions = useAppStore((state) => state.setSessions);
  const setError = useAppStore((state) => state.setError);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [search, setSearch] = useState('');
  const deleting = useRef(new Set<string>());
  const [deletingIds,setDeletingIds]=useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const [showWindowMenu, setShowWindowMenu] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [continuing, setContinuing] = useState<SessionDetail | null>(null);
  const [roundNote, setRoundNote] = useState('');
  const [startingRound, setStartingRound] = useState(false);
  const roundDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = roundDialogRef.current;
    if (continuing) dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [continuing]);
  const [setupError, setSetupError] = useState<{ message: string; sessionId?: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const windowMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    void Promise.all(sessions.map(async (session) => [session.id, await window.electronAPI.getSession(session.id)] as const))
      .then((items) => {
        if (disposed) return;
        setDetails(Object.fromEntries(items.filter((item): item is readonly [string, SessionDetail] => Boolean(item[1]))));
      })
      .catch(() => { /* Cards can still render from the session list. */ });
    return () => { disposed = true; };
  }, [sessions]);

  useEffect(() => {
    if (!showWindowMenu && !showAccountMenu) return undefined;
    const dismiss = (event: PointerEvent): void => {
      if (!windowMenuRef.current?.contains(event.target as Node)) setShowWindowMenu(false);
      if (!accountMenuRef.current?.contains(event.target as Node)) setShowAccountMenu(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setShowWindowMenu(false); setShowAccountMenu(false); }
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [showAccountMenu, showWindowMenu]);

  const filteredSessions = useMemo(() => filterSessions(sessions, search), [sessions, search]);
  const groupedSessions = useMemo(() => {
    const ordered = [...filteredSessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return ordered.reduce<Array<{ label: string; sessions: Session[] }>>((groups, session) => {
      const label = dayGroup(session.updatedAt);
      const previous = groups.at(-1);
      if (previous?.label === label) previous.sessions.push(session);
      else groups.push({ label, sessions: [session] });
      return groups;
    }, []);
  }, [filteredSessions]);

  const opening = useRef(false);
  const enterSession = async (id?: string, note?: string): Promise<void> => {
    if (opening.current) return;
    opening.current = true;
    setSetupError(null);
    try {
      const detail = id ? await window.electronAPI.getSession(id) : null;
      if (!mounted.current) return;
      if (id && !detail) throw new Error('This session could not be found.');
      if (detail && note === undefined && (detail.rounds?.length || detail.conversation.length || detail.questions.length)) {
        setRoundNote(''); setContinuing(detail); return;
      }
      await requireSessionProviderSetup(detail?.session.selectedModel);
      if (!mounted.current) return;
      if (id && note !== undefined) await window.electronAPI.startSessionRound(id, note);
      if (!mounted.current) return;
      setContinuing(null);
      setActive(id ?? null); setPage(id ? 'copilot' : 'create');
    } catch (error) {
      if (mounted.current) setSetupError({ message: error instanceof Error ? error.message : 'Could not check provider setup. Open Settings and try again.', sessionId: id });
    } finally { opening.current = false; if(mounted.current)setStartingRound(false); }
  };
  const create = (): void => { void enterSession(); };
  const open = (id: string): void => { void enterSession(id); };
  const transcript = (id: string): void => { setActive(id); setPage('history'); };
  const remove = async (id: string): Promise<void> => {
    if (deleting.current.has(id)||!window.confirm('Delete this session and all local transcripts and answers?')) return;
    deleting.current.add(id);setDeletingIds([...deleting.current]);
    try {
      await window.electronAPI.deleteSession(id);
      if(mounted.current)setSessions(useAppStore.getState().sessions.filter(session=>session.id!==id));
    } catch {
      if(mounted.current)setError('Session deletion could not be confirmed. Your session list is retained.');
    } finally {
      deleting.current.delete(id);if(mounted.current)setDeletingIds([...deleting.current]);
    }
  };
  const adjustZoom = async (direction: 'in' | 'out'): Promise<void> => {
    try { await window.electronAPI.adjustZoom(direction); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not adjust zoom.'); }
  };
  const adjustTransparency = async (delta: number): Promise<void> => {
    const current = useAppStore.getState().settings;
    if (!current) return;
    const overlayOpacity = Math.round(Math.max(.35, Math.min(1, current.overlayOpacity - delta)) * 100) / 100;
    try { setSettings(await window.electronAPI.saveSettings({ ...current, overlayOpacity })); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not adjust transparency.'); }
  };
  const transparency = Math.round((1 - (settings?.overlayOpacity ?? .96)) * 100);
  return <main className="dashboard-page account-dashboard">
    <header className="dashboard-header">
      <div className="dashboard-title"><span className="dashboard-mark"><img src={clueraLogo} alt=""/></span><div><strong>Cluera AI</strong><small>Interview sessions</small></div></div>
      <div className="dashboard-actions">
        <button className="dashboard-action dashboard-support" onClick={() => { setShowWindowMenu(false); setShowAccountMenu(false); setShowSupport(true); }}>Support</button>
        {customerName && <div className="dashboard-account-wrap" ref={accountMenuRef}>
          <button className={`dashboard-action dashboard-account${showAccountMenu ? ' active' : ''}`} aria-label={customerName} title={customerName} aria-expanded={showAccountMenu} onClick={() => { setShowWindowMenu(false); setShowAccountMenu((value) => !value); }}><CircleUserRound size={14}/><span>{customerName}</span></button>
          {showAccountMenu && <div className="dashboard-account-menu">
            <div className="dashboard-account-summary"><CircleUserRound size={18}/><span><strong>{customerName}</strong></span></div>
            {account&&<><button className="ghost" onClick={()=>{setShowAccountMenu(false);setPage('settings');}}>Settings & Updates</button><button className="ghost" onClick={()=>void window.accountAPI?.logout(false).catch(()=>setError('Sign-out could not be confirmed.'))}>Log out</button></>}
          </div>}
        </div>}
        <button className="dashboard-create" onClick={create}><Plus size={15}/>Create Session</button>
        <div className="dashboard-window-menu-wrap" ref={windowMenuRef}>
          <button className={`dashboard-icon ${showWindowMenu ? 'active' : ''}`} aria-label="Dashboard window controls" title="Window controls" aria-expanded={showWindowMenu} onClick={() => { setShowAccountMenu(false); setShowWindowMenu((value) => !value); }}><MoreHorizontal size={17}/></button>
          {showWindowMenu && <div className="dashboard-window-menu" role="menu">
            <button role="menuitem" onClick={() => void adjustZoom('in')}><ZoomIn size={14}/><span>Zoom +</span></button>
            <button role="menuitem" onClick={() => void adjustZoom('out')}><ZoomOut size={14}/><span>Zoom −</span></button>
            <div className="dashboard-transparency" aria-label="Transparency control"><span><SunMedium size={14}/>Transparency <small>{transparency}%</small></span><div><button aria-label="Decrease transparency" title="Decrease transparency" disabled={transparency <= 0} onClick={() => void adjustTransparency(-.05)}>−</button><button aria-label="Increase transparency" title="Increase transparency" disabled={transparency >= 65} onClick={() => void adjustTransparency(.05)}>+</button></div></div>
            <ThemeControl/>
            <PrivateModeControl/>
            <button className="dashboard-files-action" role="menuitem" onClick={() => { setShowWindowMenu(false); setPage('files'); }}><FolderOpen size={14}/><span>Files</span></button>
            <button role="menuitem" onClick={() => { setShowWindowMenu(false); setPage('settings'); }}><Settings2 size={14}/><span>Settings & models</span></button>
          </div>}
        </div>
        <button className="dashboard-icon" aria-label="Collapse dashboard" title="Collapse to floating logo" onClick={() => { setShowWindowMenu(false); onCollapse(); }}><Shrink size={15}/></button>
        <button className="dashboard-icon close" aria-label="Close Cluera AI" title="Close Cluera AI" onClick={() => void window.electronAPI.closeWindow()}><X size={17}/></button>
      </div>
    </header>

    <section className="dashboard-content">
      {account&&<AccountCreditsSection key={account.userId} userId={account.userId}/>}
      {setupError && <div className="settings-note" role="alert"><p>{setupError.message}</p><button className="ghost" onClick={() => setPage('settings')}>Open Settings</button>{setupError.sessionId && <button className="ghost" onClick={() => { setActive(setupError.sessionId!); setPage('create'); }}>Edit saved session</button>}</div>}
      <div className="dashboard-intro"><div><p>SESSION WORKSPACE</p><h1>Your interviews</h1></div><span role="status">{search.trim() ? `${filteredSessions.length} of ${sessions.length}` : sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}</span></div>
      <div className="dashboard-search" role="search">
        <Search size={15} aria-hidden="true"/>
        <input ref={searchRef} type="search" value={search} aria-label="Search sessions" placeholder="Search sessions, companies or roles..." onChange={(event) => setSearch(event.target.value)}/>
        {search && <button type="button" aria-label="Clear session search" title="Clear search" onClick={() => { setSearch(''); searchRef.current?.focus(); }}><X size={13}/></button>}
      </div>
      {!sessions.length ? <div className="dashboard-empty">
        <span><CalendarDays size={23}/></span><h2>No sessions yet</h2><p>Create an interview workspace with your resume and job context.</p>
        <button className="dashboard-create" onClick={create}><Plus size={15}/>Create Session</button>
      </div> : !filteredSessions.length ? <div className="dashboard-search-empty"><Search size={21} aria-hidden="true"/><h2>No matching sessions</h2><p>Try another session name, company or role.</p><button type="button" onClick={() => { setSearch(''); searchRef.current?.focus(); }}>Clear search</button></div> : <div className="dashboard-groups">
        {groupedSessions.map((group) => <section className="dashboard-group" key={group.label}>
          <h2>{group.label}</h2>
          <div className="dashboard-session-list">{group.sessions.map((session) => {
            const detail = details[session.id];
            const hasTranscript = Boolean(detail?.conversation.some((turn) => turn.speaker !== 'copilot'));
            const active = activeId === session.id && !['idle', 'ready'].includes(copilotStatus);
            const status = active ? 'Active' : hasTranscript ? 'Ended' : 'Ready to Start';
            return <article className="dashboard-session" key={session.id}>
              <div className="company-avatar" aria-hidden="true">{companyInitials(session)}</div>
              <div className="session-primary"><div><h3>{session.role}</h3><span>{session.company || 'Company not specified'}</span></div><small>{session.title}</small></div>
              <div className="session-badges"><span className="session-badge interview">Interview</span>{hasTranscript && <span className="session-badge transcript"><FileText size={10}/>Transcript</span>}</div>
              <div className="session-usage"><strong>{status}</strong><span>{formatDate(session.updatedAt)} · {sessionDuration(detail)}</span></div>
              <div className="session-row-actions">
                <button className="session-main-action start" onClick={() => open(session.id)}>Start Session<ArrowRight size={14}/></button>
                {(hasTranscript || Boolean(detail?.rounds?.length || detail?.questions.length)) && <button className="session-main-action" onClick={() => transcript(session.id)}>View Transcript<ArrowRight size={14}/></button>}
                <button className="session-details-action" aria-label={`View setup for ${session.title}`} title="View saved session setup" onClick={() => transcript(session.id)}><FileText size={14}/></button>
                <button className="session-delete" disabled={deletingIds.includes(session.id)} aria-label={`Delete ${session.title}`} title="Delete session" onClick={() => void remove(session.id)}><Trash2 size={14}/></button>
              </div>
            </article>;
          })}</div>
        </section>)}
      </div>}
    </section>
    {showSupport && <SupportDialog account onClose={() => setShowSupport(false)}/>}
    {continuing && <dialog ref={roundDialogRef} className="round-dialog" aria-labelledby="continue-interview-title" onCancel={event => { event.preventDefault(); if (!startingRound) setContinuing(null); }}><form onSubmit={event => {
      event.preventDefault(); if (startingRound) return; setStartingRound(true); void enterSession(continuing.session.id, roundNote);
    }}>
      <h2 id="continue-interview-title">Continue Interview</h2>
      <p>Round {(continuing.rounds?.[0]?.number ?? 1) + 1} · {continuing.session.company}</p>
      <label>What's different about this round? <small>Optional</small><textarea autoFocus maxLength={2000} value={roundNote} onChange={event => setRoundNote(event.target.value)} disabled={startingRound}/></label>
      <p>Your saved resume, JD and supporting context will be reused.</p>
      {setupError && <p role="alert">{setupError.message}</p>}
      <div><button type="button" disabled={startingRound} onClick={() => setContinuing(null)}>Cancel</button><button className="dashboard-create" disabled={startingRound} type="submit">{startingRound ? 'Opening…' : 'Start Round'}</button></div>
    </form></dialog>}
  </main>;
}
