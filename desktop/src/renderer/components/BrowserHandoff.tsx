import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '../stores/appStore';
import { FloatingLogo } from './FloatingLogo';

const NOTICE_MS = 8_000;

/**
 * While the customer works in their browser (Google sign-in, payment, account pages), the window steps aside to the
 * floating logo so it does not cover the page. It comes back by itself when the work there is finished, or at once when
 * the logo is clicked. A live session is never collapsed. The screen underneath stays mounted, so nothing typed is lost.
 */
export function BrowserHandoff({ owner, children }: { owner: string; children: ReactNode }): JSX.Element {
  const [away, setAway] = useState(false);
  const [notice, setNotice] = useState('');
  const awayRef = useRef(false);

  const collapse = async (): Promise<void> => {
    if (awayRef.current) return;
    awayRef.current = true;
    setAway(true);
    try { await window.electronAPI.setLiveCollapsed(true); }
    catch { awayRef.current = false; setAway(false); }
  };
  const restore = async (): Promise<void> => {
    if (!awayRef.current) return;
    awayRef.current = false;
    setAway(false);
    // Draw the full screen while it is still clipped inside the small launcher, then grow the window.
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 200); });
    if (!awayRef.current) await window.electronAPI.setLiveCollapsed(false).catch(() => undefined);
  };

  useEffect(() => window.electronAPI?.onEvent?.('window:handoff', (event) => {
    const live = useAppStore.getState().page === 'copilot';
    if (event.phase === 'away') {
      if (!live) void collapse();
      return;
    }
    void restore();
    if (event.timeAdded) {
      useAppStore.getState().setTimeOver(false);
      if (!live) setNotice('New time was added to your account.');
    }
  }), []);
  // Another account, or signing out: always shown full size.
  const shownOwner = useRef(owner);
  useEffect(() => {
    if (shownOwner.current === owner) return;
    shownOwner.current = owner;
    void restore();
  }, [owner]);
  useLayoutEffect(() => {
    if (!away) return undefined;
    document.documentElement.dataset.liveCollapsed = 'true';
    return () => { delete document.documentElement.dataset.liveCollapsed; };
  }, [away]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return <>
    <div className="handoff-screen" style={{ display: away ? 'none' : 'contents' }}>{children}</div>
    {away && <AwayLauncher onRestore={() => void restore()}/>}
    {notice && !away && <p className="handoff-notice" role="status">{notice}</p>}
  </>;
}

/**
 * The floating logo, in a modal dialog of its own. A pop-up left open on the hidden screen (support, time used up) makes
 * the rest of the page ignore clicks; the newest modal dialog is the one that still takes them.
 */
function AwayLauncher({ onRestore }: { onRestore(): void }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => { if (typeof dialog.close === 'function' && dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="handoff-launcher" aria-label="Cluera AI is out of the way"
    onCancel={(event) => { event.preventDefault(); onRestore(); }}>
    <FloatingLogo label="Return to Cluera AI" onRestore={onRestore}/>
  </dialog>;
}
