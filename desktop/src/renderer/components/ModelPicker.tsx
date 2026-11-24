import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProviderModelOption } from '../../shared/types';
import { groupModelChoices, modelTitle, type ModelChoice, type ModelVendor } from '../services/modelLabel';

/** Simple company marks drawn inline, so the picker needs no image files. */
export function VendorIcon({ vendor, size = 16 }: { vendor: ModelVendor | null; size?: number }): JSX.Element {
  if (vendor === 'gemini') {
    return <svg className="vendor-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs><linearGradient id="vendor-gemini" x1="4" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse"><stop stopColor="#4285f4"/><stop offset=".55" stopColor="#7b6cf6"/><stop offset="1" stopColor="#d96570"/></linearGradient></defs>
      <path fill="url(#vendor-gemini)" d="M12 1.5c.5 5.6 4.9 10 10.5 10.5-5.6.5-10 4.9-10.5 10.5C11.5 16.9 7.1 12.5 1.5 12 7.1 11.5 11.5 7.1 12 1.5Z"/>
    </svg>;
  }
  if (vendor === 'claude') {
    return <svg className="vendor-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="#d97757" strokeWidth="2.3" strokeLinecap="round">
        {[0, 30, 60, 90, 120, 150].map((angle) => <line key={angle} x1="12" y1="3.2" x2="12" y2="20.8" transform={`rotate(${angle} 12 12)`}/>)}
      </g>
    </svg>;
  }
  if (vendor === 'chatgpt') {
    return <svg className="vendor-icon vendor-icon-mono" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
        {[0, 60, 120].map((angle) => <rect key={angle} x="8.4" y="2.6" width="7.2" height="18.8" rx="3.6" transform={`rotate(${angle} 12 12)`}/>)}
      </g>
    </svg>;
  }
  return <span className="vendor-icon vendor-icon-blank" style={{ width: size, height: size }} aria-hidden="true"/>;
}

interface ModelPickerProps {
  models: ProviderModelOption[];
  value: string;
  onChange(modelId: string): void;
  /** The server's default model. It is Recommended unless the Admin set a label for it. */
  recommendedId?: string;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  /** Shown when the saved choice is no longer in the list. */
  unavailableLabel?: string;
}

function Tag({ choice }: { choice: ModelChoice<ProviderModelOption> }): JSX.Element | null {
  return choice.tag ? <span className={`model-tag ${choice.tag.kind}`} title={choice.tag.text}>{choice.tag.text}</span> : null;
}

export function ModelPicker({ models, value, onChange, recommendedId, disabled, ariaLabel = 'AI model', placeholder = 'Choose an AI model', unavailableLabel }: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const groups = useMemo(() => groupModelChoices(models, recommendedId), [models, recommendedId]);
  const flat = useMemo(() => [...groups.quick, ...groups.more], [groups]);
  const selected = flat.find((choice) => choice.model.modelId === value);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (modelId: string): void => { onChange(modelId); setOpen(false); };
  const openList = (): void => {
    // Open upward when the list would run under the bottom of the window or the page footer.
    const rect = root.current?.getBoundingClientRect();
    if (rect) { const below = window.innerHeight - rect.bottom - 96; setUp(below < 280 && rect.top > below); }
    setActive(Math.max(0, flat.findIndex((choice) => choice.model.modelId === value))); setOpen(true);
  };
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (disabled) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { openList(); return; }
      setActive((index) => (flat.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length : -1));
    } else if ((event.key === 'Enter' || event.key === ' ') && open && active >= 0 && flat[active]) {
      event.preventDefault(); choose(flat[active].model.modelId);
    }
  };

  const row = (choice: ModelChoice<ProviderModelOption>): JSX.Element => {
    const index = flat.indexOf(choice);
    const isSelected = choice.model.modelId === value;
    return <button type="button" role="option" aria-selected={isSelected} key={choice.model.modelId}
      className={`model-option${isSelected ? ' selected' : ''}${index === active ? ' active' : ''}`}
      onMouseEnter={() => setActive(index)} onClick={() => choose(choice.model.modelId)}>
      <VendorIcon vendor={choice.vendor}/>
      <span className="model-option-name">{modelTitle(choice.model)}</span>
      <Tag choice={choice}/>
      {isSelected && <Check size={13} className="model-option-check" aria-hidden="true"/>}
    </button>;
  };

  return <div className={`model-picker${open ? ' open' : ''}${up ? ' up' : ''}`} ref={root} onKeyDown={onKeyDown}>
    <button type="button" className="model-picker-button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => (open ? setOpen(false) : openList())}>
      {selected ? <><VendorIcon vendor={selected.vendor}/><span className="model-option-name">{modelTitle(selected.model)}</span><Tag choice={selected}/></>
        : value && unavailableLabel ? <span className="model-option-name muted">{unavailableLabel}</span>
        : <span className="model-option-name muted">{models.length ? placeholder : 'No enabled AI models available'}</span>}
      <ChevronDown size={14} className="model-picker-chevron" aria-hidden="true"/>
    </button>
    {open && <div className="model-picker-menu" id={listId} role="listbox" aria-label={ariaLabel}>
      {groups.quick.map(row)}
      {groups.quick.length > 0 && groups.more.length > 0 && <div className="model-picker-divider" role="separator"/>}
      {groups.more.map(row)}
    </div>}
  </div>;
}
