/** Small per-phone choices. They only make the screen nicer, so every read and write is allowed to fail. */
export interface LivePrefs { autoScroll: boolean; keepAwake: boolean; font: number }
const KEY = 'cluera-live-prefs-v1';
const DEFAULTS: LivePrefs = { autoScroll: false, keepAwake: true, font: 17 };

export function loadPrefs(): LivePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LivePrefs> | null;
    return {
      autoScroll: typeof raw?.autoScroll === 'boolean' ? raw.autoScroll : DEFAULTS.autoScroll,
      keepAwake: typeof raw?.keepAwake === 'boolean' ? raw.keepAwake : DEFAULTS.keepAwake,
      font: typeof raw?.font === 'number' && raw.font >= 14 && raw.font <= 28 ? Math.round(raw.font) : DEFAULTS.font,
    };
  } catch { return { ...DEFAULTS }; }
}
export function savePrefs(value: LivePrefs): void { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private window */ } }

const LAST = 'cluera-live-last-v1';
/** The choices of the previous setup, so the next one starts filled in. */
export function loadLastSetup(): Record<string, unknown> {
  try { const value = JSON.parse(localStorage.getItem(LAST) ?? 'null'); return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
export function saveLastSetup(value: Record<string, unknown>): void { try { localStorage.setItem(LAST, JSON.stringify(value)); } catch { /* private window */ } }
