import { useRef, useState, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { MIN_AREA_DIP, selectionRect, type ShotRect, type ShotSize } from '../shared/shotGeometry';
import './styles/theme.css';
import './styles/area.css';

declare global {
  interface Window { areaShot: { submit(rect: ShotRect, viewport: ShotSize): Promise<{ ok: boolean; error?: string }>; cancel(): void } }
}
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Drag = { mode: 'draw' | 'move' | Handle; x: number; y: number; rect: ShotRect };

function AreaSelector(): JSX.Element {
  const [rect, setRect] = useState<ShotRect | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const drag = useRef<Drag | null>(null);
  const viewport = (): ShotSize => ({ width: window.innerWidth, height: window.innerHeight });
  const begin = (event: PointerEvent<HTMLDivElement>): void => {
    if (submitting || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const target = event.target as HTMLElement;
    const mode = (target.dataset.handle || (target.dataset.selection ? 'move' : 'draw')) as Drag['mode'];
    drag.current = { mode, x: event.clientX, y: event.clientY, rect: rect ?? { x: event.clientX, y: event.clientY, width: 0, height: 0 } };
    if (mode === 'draw') setRect({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
    setError('');
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    const size = viewport();
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (state.mode === 'draw') setRect(selectionRect({ x: state.x, y: state.y }, { x: event.clientX, y: event.clientY }, size));
    else if (state.mode === 'move') setRect({ ...state.rect,
      x: Math.max(0, Math.min(size.width - state.rect.width, state.rect.x + dx)),
      y: Math.max(0, Math.min(size.height - state.rect.height, state.rect.y + dy)),
    });
    else {
      const r = state.rect;
      setRect(selectionRect(
        { x: r.x + (state.mode.includes('w') ? dx : 0), y: r.y + (state.mode.includes('n') ? dy : 0) },
        { x: r.x + r.width + (state.mode.includes('e') ? dx : 0), y: r.y + r.height + (state.mode.includes('s') ? dy : 0) }, size));
    }
  };
  const submit = async (): Promise<void> => {
    if (!rect || submitting) return;
    setSubmitting(true);
    try {
      const result = await window.areaShot.submit(rect, viewport());
      if (!result.ok) { setError(result.error ?? 'Select the area again.'); setSubmitting(false); }
    } catch { setError('Selection could not be accepted. Press Escape and try again.'); setSubmitting(false); }
  };
  const valid = rect && rect.width >= MIN_AREA_DIP && rect.height >= MIN_AREA_DIP;
  return <div className="area-overlay" onPointerDown={begin} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    <div className="area-instructions">Drag to select on this display · Move or resize the selection · Esc to cancel</div>
    {rect && <div data-selection="true" className="area-selection" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {(['nw','n','ne','e','se','s','sw','w'] as Handle[]).map(handle => <i key={handle} data-handle={handle} className={`area-handle ${handle}`}/>)}
    </div>}
    {!rect && <div className="area-shade"/>}
    <div className="area-toolbar" role="dialog" aria-label="Screenshot area selection">
      <span>{error || (rect ? `${Math.round(rect.width)} × ${Math.round(rect.height)}` : 'Choose an area')}</span>
      <button onClick={() => window.areaShot.cancel()}>Cancel · Esc</button>
      <button className="area-confirm" disabled={!valid || submitting} onClick={() => void submit()}>{submitting ? 'Capturing…' : 'Use area'}</button>
    </div>
  </div>;
}
const theme = new URLSearchParams(location.search).get('theme');
document.documentElement.dataset.colorScheme = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
createRoot(document.getElementById('root')!).render(<AreaSelector/>);
