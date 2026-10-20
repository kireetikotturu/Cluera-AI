import { ExternalLink, Mail, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SUPPORT_EMAIL, type SupportDestination } from '../../shared/supportLinks';

export function SupportDialog({ onClose, account=false }: { onClose(): void; account?:boolean }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const working = useRef(false), mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { mounted.current = false; if (dialog?.open) dialog.close(); };
  }, []);

  const openEmail = async (kind: SupportDestination): Promise<void> => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.openExternal(kind);
    } catch {
      if (mounted.current) setError('Your email app could not be opened. Please write to the support address shown above.');
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <dialog ref={dialogRef} className="support-dialog" aria-labelledby="support-dialog-title" aria-describedby="support-dialog-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="support-dialog-content">
      <div className="support-dialog-top">
        <span className="support-dialog-mark" aria-hidden="true"><Mail size={21}/></span>
        <button className="support-dialog-close" type="button" aria-label="Close support" onClick={onClose}><X size={17}/></button>
      </div>
      <p className="eyebrow">Here to help</p>
      <h2 id="support-dialog-title">Cluera Support</h2>
      <p className="support-dialog-email">{SUPPORT_EMAIL}</p>
      <p id="support-dialog-description" className="support-dialog-description">We can help with your account, usage balance, setup and technical issues.</p>
      <p className="support-dialog-response">Include your Cluera version and the stage that failed. Response times depend on support availability.</p>
      <p className="support-dialog-safety">Never send API keys, passwords, or other private credentials.</p>
      <div className="support-dialog-actions">
        <button className="primary" type="button" disabled={busy} onClick={() => void openEmail('supportGmail')}><ExternalLink size={15}/> Email Cluera Support</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => void openEmail('supportMail')}>Open your email app instead</button>
      </div>
      <p className="support-dialog-hint">Gmail opens in your default browser. If you are not signed in, use your email app instead.</p>
      {error && <p className="support-dialog-error" role="alert">{error}</p>}
    </div>
  </dialog>;
}
