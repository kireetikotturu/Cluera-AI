import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { useAppStore } from '../stores/appStore';

/** Shared capture-protection control for Dashboard and live-session menus. */
export function PrivateModeControl(): JSX.Element {
  const privateMode = useAppStore((state) => state.settings?.privateMode ?? true);
  const [saving, setSaving] = useState(false);

  const toggle = async (): Promise<void> => {
    const { settings, setSettings, setError } = useAppStore.getState();
    if (!settings || saving) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI.saveSettings({ ...settings, privateMode: !privateMode });
      setSettings(saved);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not change Private Mode.');
    } finally {
      setSaving(false);
    }
  };

  const Icon = privateMode ? ShieldCheck : ShieldOff;
  return <button
    type="button"
    className="private-mode-control"
    role="menuitemcheckbox"
    aria-checked={privateMode}
    aria-label={`Private Mode ${privateMode ? 'on' : 'off'}`}
    title={privateMode ? 'Cluera AI is protected from supported screen capture' : 'Cluera AI can appear in screen capture'}
    disabled={saving}
    onClick={() => void toggle()}
  >
    <Icon size={14}/>
    <span className="menu-toggle-label">Private Mode</span>
    <span className={`menu-toggle-track${privateMode ? ' on' : ''}`} aria-hidden="true"><i/></span>
    <span className="menu-toggle-state">{privateMode ? 'ON' : 'OFF'}</span>
  </button>;
}
