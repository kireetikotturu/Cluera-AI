import { ArrowLeft, CheckCircle2, Monitor, Moon, Shrink, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../../shared/types';
import type { AccountView } from '../../shared/accounts';
import { UpdatesSection } from '../components/UpdatesSection';
import { AccountContextSection } from '../components/AccountContextSection';
import { AccountCreditsSection } from '../components/AccountCreditsSection';
import { ModelPicker } from '../components/ModelPicker';
import { useAppStore } from '../stores/appStore';
import clueraLogo from '../assets/cluera-ai.svg';

const THEMES = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
] as const;

export function SettingsPage({ onUpdateStatus, account, onCollapse }: { onUpdateStatus?(status: UpdateStatus): void; account: AccountView; onCollapse?(): void }): JSX.Element {
  const provider = useAppStore((s) => s.providerStatus), settings = useAppStore((s) => s.settings), setPage = useAppStore((s) => s.setPage);
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const running = useRef(false), again = useRef(false), dirty = useRef(false), epoch = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const current = ++epoch.current;
    void window.electronAPI.getProviderStatus().then((status) => {
      if (epoch.current === current) useAppStore.getState().setProviderStatus(status);
    }).catch(() => { if (epoch.current === current) useAppStore.getState().setError('Could not load the approved model catalog.'); });
    return () => { epoch.current++; clearTimeout(timer.current); };
  }, [account.userId]);

  /** Saves the current preferences. A change made while a save is running is saved right after it, never dropped. */
  const save = async (modelId?: string): Promise<void> => {
    if (running.current) {
      if (modelId !== undefined) { const now = useAppStore.getState().settings; if (now) useAppStore.getState().setSettings({ ...now, geminiModel: modelId }); }
      again.current = true; return;
    }
    running.current = true; setBusy(true); setSaved(false);
    const current = epoch.current;
    try {
      const draft = useAppStore.getState().settings; if (!draft) throw Error();
      const next = await window.electronAPI.saveSettings({ ...draft, ...(modelId === undefined ? {} : { geminiModel: modelId }) });
      if (epoch.current !== current) return;
      // Anything changed while this save was running stays (the saved copy comes back without it).
      useAppStore.getState().setSettings({ ...next, ...changedSince(draft, useAppStore.getState().settings) });
      setSaved(true);
      const status = await window.electronAPI.getProviderStatus();
      if (epoch.current === current) useAppStore.getState().setProviderStatus(status);
      clearTimeout(timer.current); timer.current = setTimeout(() => { if (epoch.current === current) setSaved(false); }, 1600);
    } catch { if (epoch.current === current) useAppStore.getState().setError('Settings could not be saved. Your previous configuration is retained.'); }
    finally {
      running.current = false; if (epoch.current === current) setBusy(false);
      if (again.current && epoch.current === current) { again.current = false; void save(); }
    }
  };
  /** The slider saves once, when it is let go, not on every step. */
  const flush = (): void => { if (dirty.current) { dirty.current = false; void save(); } };
  if (!settings) return <main className="file-library-page settings-workspace"><p className="st-loading" role="status">Loading your settings…</p></main>;
  const setSettings = useAppStore.getState().setSettings;
  const opacity = Math.round(settings.overlayOpacity * 100);
  const change = (patch: Partial<typeof settings>, persist = true): void => { setSettings({ ...settings, ...patch }); if (persist) void save(); };

  return <main className="file-library-page settings-workspace">
    <header className="file-library-header">
      <button className="library-back" onClick={() => setPage('home')}><ArrowLeft size={16}/>Dashboard</button>
      <div><span className="dashboard-mark"><img src={clueraLogo} alt=""/></span><strong>Settings</strong></div>
      <div className="library-header-actions">
        <button className="library-collapse" aria-label="Collapse Cluera AI" title="Collapse to floating logo" onClick={() => onCollapse?.()}><Shrink size={16}/></button>
        <button className="library-close" aria-label="Close Cluera AI" title="Close Cluera AI" onClick={() => void window.electronAPI.closeWindow()}><X size={17}/></button>
      </div>
    </header>
    <div className="file-library-scroll st-scroll"><div className="st-column">
      <div className="st-intro"><div><h1>Settings</h1><p>Your account, AI model and documents.</p></div>
        <span className={`st-saved${saved ? ' show' : ''}`} role="status">{saved ? <><CheckCircle2 size={14}/>Saved</> : null}</span></div>

      <AccountCard account={account}/>

      <section className="st-card" aria-labelledby="st-model-title">
        <div className="st-card-head"><h2 id="st-model-title">AI model</h2><p>The model that writes your answers.</p></div>
        <ModelPicker models={provider?.modelOptions ?? []} value={settings.geminiModel ?? provider?.defaultGeminiModel ?? ''} recommendedId={provider?.defaultGeminiModel}
          ariaLabel="Approved answer model" placeholder="Choose an AI model" disabled={busy || !provider?.modelOptions?.length}
          unavailableLabel={settings.geminiModel ? `${settings.geminiModel} · unavailable` : undefined} onChange={(modelId) => void save(modelId)}/>
      </section>

      <AccountContextSection key={account.userId}/>

      <section className="st-card" aria-labelledby="st-look-title">
        <div className="st-card-head"><h2 id="st-look-title">Appearance</h2><p>How Cluera looks on this computer.</p></div>
        <div className="st-field"><span id="st-theme-label">Theme</span>
          <div className="st-seg" role="radiogroup" aria-labelledby="st-theme-label">
            {THEMES.map(({ id, label, icon: Icon }) => <button type="button" key={id} role="radio" aria-checked={settings.theme === id} className={settings.theme === id ? 'on' : ''}
              onClick={() => change({ theme: id })}><Icon size={14}/>{label}</button>)}
          </div></div>
        <div className="st-field"><label htmlFor="st-opacity">Window opacity<em>{opacity}%</em></label>
          <input id="st-opacity" className="st-range" type="range" min="35" max="100" value={opacity} style={{ ['--fill' as string]: `${((opacity - 35) / 65) * 100}%` }}
            onChange={(event) => { dirty.current = true; change({ overlayOpacity: Number(event.target.value) / 100 }, false); }}
            onPointerUp={flush} onKeyUp={flush} onBlur={flush}/></div>
        {provider?.development ? <div className="st-field st-inline"><label htmlFor="st-debug">Developer diagnostics</label>
          <button id="st-debug" type="button" role="switch" aria-checked={settings.debugMode} className={settings.debugMode ? 'switch on' : 'switch'} onClick={() => change({ debugMode: !settings.debugMode })}><i/></button></div> : null}
      </section>

      <UpdatesSection variant="panel" onStatus={onUpdateStatus}/>
    </div></div>
  </main>;
}

/** The settings the customer changed after `before` was taken (used so a running save never undoes a newer change). */
function changedSince<T extends object>(before: T, now: T | null): Partial<T> {
  if (!now) return {};
  const edits: Partial<T> = {};
  for (const key of Object.keys(now) as Array<keyof T>) if (now[key] !== before[key]) edits[key] = now[key];
  return edits;
}

function AccountCard({ account }: { account: AccountView }): JSX.Element {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signOut = async (all: boolean): Promise<void> => {
    if (running.current) return;
    running.current = true; setBusy(true); setMessage('');
    try { await window.accountAPI!.logout(all); }
    catch { if (mounted.current) setMessage('Signing out could not be confirmed. Try again when you are online.'); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const email = account.email ?? '';
  return <section className="st-card st-account" aria-label="Your account">
    <div className="st-account-top">
      <span className="st-avatar" aria-hidden="true">{email.charAt(0).toUpperCase() || 'C'}</span>
      <div className="st-account-id"><strong title={email}>{email}</strong><small>Signed in</small></div>
      <button type="button" className="st-btn" disabled={busy}
        onClick={() => void window.accountAPI!.openWeb('dashboard').catch(() => { if (mounted.current) setMessage('The account website could not be opened.'); })}>Account dashboard</button>
    </div>
    <AccountCreditsSection userId={account.userId} settings/>
    <div className="st-account-foot">
      <button type="button" className="st-btn" disabled={busy} onClick={() => void signOut(false)}>Sign out this device</button>
      <button type="button" className="st-link danger" disabled={busy} onClick={() => void signOut(true)}>Sign out all devices</button>
    </div>
    {message ? <p className="st-status" role="status">{message}</p> : null}
  </section>;
}
