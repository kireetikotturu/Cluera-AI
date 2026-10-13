import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useAppStore } from '../stores/appStore';

/** Shared menu control; preferences still use the existing settings IPC/storage. */
export function ThemeControl(): JSX.Element {
  const theme = useAppStore((s) => s.settings?.theme ?? 'dark');
  const [saving, setSaving] = useState(false);

  const choose = async (next: 'dark' | 'light'): Promise<void> => {
    const { settings, setSettings, setError } = useAppStore.getState();
    if (!settings || saving || settings.theme === next) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI.saveSettings({ ...settings, theme: next });
      setSettings(saved);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save the theme.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="theme-control" role="group" aria-label="Theme">
    <span>Theme</span>
    <div className="theme-options">
      <button type="button" aria-label="Dark theme" aria-pressed={theme === 'dark'} disabled={saving} onClick={() => void choose('dark')}><Moon size={12}/>Dark</button>
      <button type="button" aria-label="Light theme" aria-pressed={theme === 'light'} disabled={saving} onClick={() => void choose('light')}><Sun size={12}/>Light</button>
    </div>
  </div>;
}
