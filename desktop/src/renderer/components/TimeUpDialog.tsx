import { Clock3, ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Shown on the dashboard after the account's time ran out during a live session. */
export function TimeUpDialog({ onClose }: { onClose(): void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal?.();
    // Show the new balance as soon as it is known.
    void window.accountAPI?.credits.refresh().catch(() => undefined);
    return () => { mounted.current = false; if (dialog?.open) dialog.close(); };
  }, []);

  const addTime = async (): Promise<void> => {
    setError('');
    try { await window.accountAPI!.openWeb('credits'); }
    catch { if (mounted.current) setError('The checkout page could not be opened. Open your account on www.clueraai.in to add time.'); }
  };

  return <dialog ref={dialogRef} className="time-up-dialog" aria-labelledby="time-up-title" aria-describedby="time-up-text"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <span className="time-up-icon" aria-hidden="true"><Clock3 size={22}/></span>
    <h2 id="time-up-title">Your time is used up</h2>
    <p id="time-up-text">The live session ended because your Cluera time ran out. Add more time to continue; the new time shows here after your payment.</p>
    <div className="time-up-actions">
      <button type="button" className="time-up-primary" onClick={() => void addTime()}>Add time<ArrowUpRight size={15}/></button>
      <button type="button" className="time-up-secondary" onClick={onClose}>Not now</button>
    </div>
    {error && <p className="time-up-error" role="alert">{error}</p>}
  </dialog>;
}
