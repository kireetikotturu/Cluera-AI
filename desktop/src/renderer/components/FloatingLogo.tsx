import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface FloatingLogoProps {
  label: string;
  onRestore(): void;
  status?: 'active' | 'paused';
}

export function FloatingLogo({ label, onRestore, status }: FloatingLogoProps): JSX.Element {
  const drag = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const restoredByPointer = useRef(false);

  const flushMove = (): void => {
    moveFrame.current = null;
    const point = pendingMove.current;
    pendingMove.current = null;
    if (point) window.electronAPI.moveLiveCollapsed('move', point.x, point.y);
  };

  useEffect(() => () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    window.electronAPI.moveLiveCollapsed('end');
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moved: false };
    window.electronAPI.moveLiveCollapsed('start', event.screenX, event.screenY);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.screenX - current.startX, event.screenY - current.startY) < 4) return;
    current.moved = true;
    pendingMove.current = { x: event.screenX, y: event.screenY };
    if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(flushMove);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (moveFrame.current !== null) { cancelAnimationFrame(moveFrame.current); moveFrame.current = null; }
    if (current.moved) window.electronAPI.moveLiveCollapsed('move', event.screenX, event.screenY);
    pendingMove.current = null;
    window.electronAPI.moveLiveCollapsed('end');
    suppressClick.current = current.moved;
    if (current.moved) setTimeout(() => { suppressClick.current = false; }, 0);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // A plain press-and-release restores the window right away; the click handler below stays for keyboard use.
    if (!current.moved && event.button === 0) {
      restoredByPointer.current = true;
      setTimeout(() => { restoredByPointer.current = false; }, 400);
      onRestore();
    }
  };

  return <main className="live-collapsed-shell">
    <button
      className="live-collapsed-logo"
      aria-label={label}
      title="Drag to move - click to restore"
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={(event) => {
        if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
        moveFrame.current = null; pendingMove.current = null; drag.current = null; suppressClick.current = false;
        window.electronAPI.moveLiveCollapsed('end');
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        if (restoredByPointer.current) { restoredByPointer.current = false; return; }
        onRestore();
      }}
    >
      <svg className="collapsed-cluera-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <defs><linearGradient id="cluera-collapsed-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8f7dff"/><stop offset=".55" stopColor="#6b5cf6"/><stop offset="1" stopColor="#2fc6d4"/></linearGradient></defs>
        <rect width="48" height="48" rx="24" fill="url(#cluera-collapsed-bg)"/>
        <path d="M33.6 16.4a12 12 0 1 0 0 15.2" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round"/>
        <circle cx="34.5" cy="24" r="3.2" fill="#fff"/>
      </svg>
      {status && <i className={status === 'paused' ? 'paused' : ''}/>}
    </button>
  </main>;
}
