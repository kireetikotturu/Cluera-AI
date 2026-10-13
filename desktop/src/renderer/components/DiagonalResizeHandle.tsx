import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export function DiagonalResizeHandle(): JSX.Element {
  const drag = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);

  useEffect(() => () => {
    if (drag.current) window.electronAPI.resizeLiveWindow('end');
  }, []);

  const begin = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY };
    window.electronAPI.resizeLiveWindow('start');
  };

  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    window.electronAPI.resizeLiveWindow('move', event.screenX - current.startX, event.screenY - current.startY, false);
  };

  const end = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    window.electronAPI.resizeLiveWindow('end');
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <button
    className="dashboard-resize-handle"
    aria-label="Resize Cluera AI window"
    title="Drag horizontally, vertically, or diagonally to resize"
    onPointerDown={begin}
    onPointerMove={move}
    onPointerUp={end}
    onPointerCancel={end}
  />;
}
