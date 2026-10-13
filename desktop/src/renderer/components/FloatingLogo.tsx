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
        onRestore();
      }}
    >
      <span className="collapsed-sigma-mark" aria-hidden="true">Σ</span>
      {status && <i className={status === 'paused' ? 'paused' : ''}/>}
    </button>
  </main>;
}
