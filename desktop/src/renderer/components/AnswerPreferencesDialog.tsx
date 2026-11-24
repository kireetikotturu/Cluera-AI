import { MessageSquareText, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { normalizeAnswerPreferences, type AnswerPreferences } from '../../shared/answerPreferences';

const FORMATS: Array<{ key: 'fullScript' | 'scriptWithBullets' | 'bullets'; title: string; text: string }> = [
  { key: 'fullScript', title: 'Full script', text: 'An answer you can read word for word.' },
  { key: 'scriptWithBullets', title: 'Script + bullets', text: 'Opening line, then supporting bullets.' },
  { key: 'bullets', title: 'Bullet points', text: 'Short bullets you can say in your own words.' },
];

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(next: boolean): void }): JSX.Element {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`pref-switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}><i/></button>;
}

interface AnswerPreferencesDialogProps { value: AnswerPreferences; onChange(next: AnswerPreferences): void; onClose(): void }

/** Pop-up on the Create Session page. The choices apply to every answer generated in that session. */
export function AnswerPreferencesDialog({ value, onChange, onClose }: AnswerPreferencesDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const prefs = normalizeAnswerPreferences(value);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const set = (key: keyof AnswerPreferences, next: boolean): void => onChange({ ...prefs, [key]: next });
  return <dialog ref={dialogRef} className="pref-dialog" aria-labelledby="pref-dialog-title" aria-describedby="pref-dialog-text"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onMouseDown={(event) => { if (event.target === dialogRef.current) onClose(); }}>
    <div className="pref-dialog-content">
      <div className="pref-dialog-top">
        <span className="pref-dialog-mark" aria-hidden="true"><MessageSquareText size={18}/></span>
        <button type="button" className="pref-dialog-close" aria-label="Close answer preferences" onClick={onClose}><X size={16}/></button>
      </div>
      <h2 id="pref-dialog-title">How should answers be presented?</h2>
      <p id="pref-dialog-text" className="pref-dialog-text">Choose the format that fits how you want to answer. It applies to every answer in this session.</p>
      <div className="pref-list">
        {FORMATS.map((format) => <div className="pref-row" key={format.key}>
          <span><strong>{format.title}</strong><small>{format.text}</small></span>
          <Switch checked={prefs[format.key]} label={format.title} onChange={(next) => set(format.key, next)}/>
        </div>)}
        <div className="pref-row pref-row-speech">
          <span><strong>Use filler words</strong><small>Writes the script the way people actually speak, with the small pauses and connectives real speech carries.</small></span>
          <Switch checked={prefs.fillerWords} label="Use filler words" onChange={(next) => set('fillerWords', next)}/>
        </div>
      </div>
      <button type="button" className="pref-dialog-done" onClick={onClose}>Done</button>
    </div>
  </dialog>;
}
