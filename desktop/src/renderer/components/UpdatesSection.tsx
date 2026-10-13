import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../shared/types';

export function UpdatesSection({ initial, onStatus }: { initial?: UpdateStatus; onStatus?(status: UpdateStatus): void }): JSX.Element {
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
  return <section className="settings-section" aria-labelledby="updates-title">
    <div className="settings-title"><Download size={19}/><div><h2 id="updates-title">Updates</h2>
      <p>Installed version: {status?.installedVersion ?? 'Loading…'}</p></div></div>
    {status?.channel === 'beta' && <p className="settings-note">Test updates only. These installers may be unsigned and Windows may show Unknown Publisher. They are not production releases.</p>}
    <p>{status?.message ?? 'Loading update information…'}</p>
    {available && <p>Latest approved version: <strong>{status.version}</strong></p>}
    {available && status.releaseNotes && <details open><summary>Release notes</summary><p className="update-release-notes">{status.releaseNotes}</p></details>}
    {status?.sessionActive && <p>End the active session before checking or installing updates. Your session will not be interrupted.</p>}
    <div className="credential-actions">
      <button className="ghost" disabled={checking || busy || status?.sessionActive} onClick={() => void check()}><RefreshCw size={15}/>{checking ? 'Checking…' : 'Check for updates'}</button>
      {available && <button className="primary" disabled={checking || busy || status.sessionActive} onClick={() => void install()}><Download size={15}/>{busy ? 'Updating…' : 'Update now'}</button>}
      {busy && status?.installPhase !== 'launching' && <button className="ghost" onClick={() => void window.electronAPI.cancelUpdate()}>Cancel download</button>}
    </div>
    {available && !busy && <p className="muted">Update now downloads and verifies the approved installer, then closes Cluera and opens the Windows upgrade wizard. Your local data is preserved.</p>}
    {busy && <p role="status">{status?.installPhase === 'downloading'
      ? `Downloading: ${Math.round((status.downloadedBytes ?? 0) / 1_000_000)} MB${status.totalBytes ? ` / ${Math.round(status.totalBytes / 1_000_000)} MB` : ''}`
      : status?.installPhase === 'launching' ? 'Opening the installer…' : 'Verifying the approved update…'}</p>}
    {(error || status?.installError) && <p role="status">{error || status?.installError}</p>}
  </section>;
}
