import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { UpdateStatus } from '../../shared/types';
import { useState } from 'react';
import { SupportDialog } from '../components/SupportDialog';
import { UpdatesSection } from '../components/UpdatesSection';

export function UpdatePage({ status, onRetry, account=false }: { status: UpdateStatus; onRetry(status: UpdateStatus): void; account?:boolean }): JSX.Element {
  const [showSupport, setShowSupport] = useState(false);
  const retry = async (): Promise<void> => {
    try { onRetry(await window.electronAPI.checkForUpdates()); } catch { /* Existing signed requirement remains in force. */ }
  };
  return <main className="activation-shell"><section className="activation-card" aria-labelledby="update-title">
    <button className="activation-close" aria-label="Close Cluera AI" onClick={() => void window.electronAPI.closeWindow()}><X size={18}/></button>
    <div className="activation-mark"><ShieldCheck size={30}/></div><p className="eyebrow">Security update</p>
    <h1 id="update-title">Update Cluera AI to continue</h1>
    <p className="activation-copy">Version {status.version} is required before starting another session. Use Update now to download and verify the approved installer.</p>
    <UpdatesSection initial={status} onStatus={onRetry}/>
    <button className="ghost activation-retry" onClick={() => void retry()}><RefreshCw size={15}/> Check again after installing</button>
    <p className="activation-support">Need help? <button type="button" onClick={() => setShowSupport(true)}>Support</button>.</p>
  </section>{showSupport && <SupportDialog account={account} onClose={() => setShowSupport(false)}/>}</main>;
}
