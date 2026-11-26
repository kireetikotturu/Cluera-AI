import { CheckCircle2, Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../shared/types';

export function UpdatesSection({ initial, onStatus, variant }: { initial?: UpdateStatus; onStatus?(status: UpdateStatus): void; variant?: 'panel' }): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | undefined>(initial);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const receive = (next: UpdateStatus): void => { setStatus(next); onStatus?.(next); };
  useEffect(() => {
    let disposed = false;
    // Poll local state only while this section is mounted; never initiate a network request here.
    const refresh = (): void => { void window.electronAPI.getUpdateStatus().then((next) => {
      if (!disposed) setStatus(next);
    }).catch(() => { if (!disposed) setError('Update information is unavailable.'); }); };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const check = async (): Promise<void> => {
    setChecking(true); setError('');
    try { receive(await window.electronAPI.checkForUpdates()); }
    catch { setError('Could not check for updates. Try again when connected.'); }
    finally { setChecking(false); }
  };
  const install = async (): Promise<void> => {
    setInstalling(true); setError('');
    try { receive(await window.electronAPI.installUpdate()); }
    catch { setError('End any active session before updating, then try again.'); }
    finally { setInstalling(false); }
  };
  const busy = installing || Boolean(status?.installPhase && status.installPhase !== 'idle');
  const available = status && ['optional', 'recommended', 'required'].includes(status.state);
  if (variant === 'panel') {
    const note = error || status?.installError;
    const progress = busy ? (status?.installPhase === 'downloading'
      ? `Downloading ${Math.round((status.downloadedBytes ?? 0) / 1_000_000)} MB${status.totalBytes ? ` of ${Math.round(status.totalBytes / 1_000_000)} MB` : ''}`
      : status?.installPhase === 'launching' ? 'Installing the update…' : 'Checking the download…') : '';
    return <section className="st-card st-updates" aria-labelledby="updates-title">
      <div className="st-row">
        <div className="st-card-head"><h2 id="updates-title">Updates</h2><p>Cluera AI {status?.installedVersion ?? '…'}</p></div>
        <div className="st-row-actions">
          {status?.state === 'current' ? <span className="st-pill ok"><CheckCircle2 size={13}/>Up to date</span> : null}
          {available ? <span className="st-pill">Version {status.version} available</span> : null}
          <button type="button" className="st-btn" disabled={checking || busy || status?.sessionActive} onClick={() => void check()}><RefreshCw size={14}/>{checking ? 'Checking…' : 'Check for updates'}</button>
          {available ? <button type="button" className="st-btn primary" disabled={checking || busy || status.sessionActive} onClick={() => void install()}><Download size={14}/>{busy ? 'Updating…' : 'Update now'}</button> : null}
          {busy && status?.installPhase !== 'launching' ? <button type="button" className="st-btn" onClick={() => void window.electronAPI.cancelUpdate()}>Cancel</button> : null}
        </div>
      </div>
      {status?.state === 'unavailable' ? <p className="st-hint">{status.message}</p> : null}
      {available && status.releaseNotes ? <details className="st-notes"><summary>What's new</summary><p className="update-release-notes">{status.releaseNotes}</p></details> : null}
      {status?.sessionActive ? <p className="st-hint">Finish your session first. Updating never interrupts a live session.</p> : null}
      {progress ? <p className="st-hint" role="status">{progress}</p> : null}
      {busy ? <p className="st-hint">Cluera AI closes while Windows installs the update, then reopens by itself. This can take a minute.</p> : null}
      {note ? <p className="st-hint" role="status">{note}</p> : null}
    </section>;
  }
  return <section className="settings-section" aria-labelledby="updates-title">
    <div className="settings-title"><Download size={19}/><div><h2 id="updates-title">Updates</h2>
      <p>Installed version: {status?.installedVersion ?? 'Loading…'}</p></div></div>
    {status?.channel === 'beta' && <p className="settings-note">Windows may show a "Windows protected your PC" notice for updates. Choose More info, then Run anyway.</p>}
    <p>{status?.message ?? 'Loading update information…'}</p>
    {available && <p>Latest approved version: <strong>{status.version}</strong></p>}
    {available && status.releaseNotes && <details open><summary>Release notes</summary><p className="update-release-notes">{status.releaseNotes}</p></details>}
    {status?.sessionActive && <p>End the active session before checking or installing updates. Your session will not be interrupted.</p>}
    <div className="credential-actions">
      <button className="ghost" disabled={checking || busy || status?.sessionActive} onClick={() => void check()}><RefreshCw size={15}/>{checking ? 'Checking…' : 'Check for updates'}</button>
      {available && <button className="primary" disabled={checking || busy || status.sessionActive} onClick={() => void install()}><Download size={15}/>{busy ? 'Updating…' : 'Update now'}</button>}
      {busy && status?.installPhase !== 'launching' && <button className="ghost" onClick={() => void window.electronAPI.cancelUpdate()}>Cancel download</button>}
    </div>
    {available && !busy && <p className="muted">Update now downloads and verifies the approved installer, then closes Cluera, installs the update and reopens it by itself. Your local data is preserved.</p>}
    {busy && <p role="status">{status?.installPhase === 'downloading'
      ? `Downloading: ${Math.round((status.downloadedBytes ?? 0) / 1_000_000)} MB${status.totalBytes ? ` / ${Math.round(status.totalBytes / 1_000_000)} MB` : ''}`
      : status?.installPhase === 'launching' ? 'Installing the update…' : 'Verifying the approved update…'}</p>}
    {busy && <p className="muted">Cluera AI closes while Windows installs the update, then reopens by itself. This can take a minute.</p>}
    {(error || status?.installError) && <p role="status">{error || status?.installError}</p>}
  </section>;
}
