import { Shrink, Square, X } from 'lucide-react';
import { Brand } from './Brand';

interface WindowBarProps { onMinimize(): void }

export function WindowBar({ onMinimize }: WindowBarProps): JSX.Element {
  return <header className="window-bar" title="Drag to move the window. Resize from any edge.">
    <Brand />
    <span className="window-caption">Interview workspace</span>
    <div className="window-actions">
      <button aria-label="Collapse Cluera AI" title="Collapse to floating logo" onClick={onMinimize}><Shrink size={15} /></button>
      <button aria-label="Toggle compact overlay" title="Toggle compact overlay" onClick={() => void window.electronAPI.toggleOverlay()}><Square size={12} /></button>
      <button aria-label="Close" title="Close Cluera AI" className="close" onClick={() => void window.electronAPI.closeWindow()}><X size={16} /></button>
    </div>
  </header>;
}
