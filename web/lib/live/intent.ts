/**
 * "Create session" on the website works only after sign-in. A visitor who taps it while signed out is sent to the sign-in page
 * with `?next=live`; this remembers that for a short while (so it also survives a Google sign-in in the same tab), and the
 * sign-in then sends them straight to the live page. It is a navigation hint only: the live page checks the account itself.
 */
export const LIVE_PATH = '/account/live';
/** Where a visitor goes to sign in first, then lands on the live page. */
export const LIVE_SIGN_IN_PATH = '/account?next=live';

const KEY = 'cluera.live-intent.v1';
const MAX_AGE_MS = 20 * 60 * 1000;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** True only for exactly `?next=live` (a single `next` value) — nothing else is ever followed. */
export function liveIntentFromSearch(search: string): boolean {
  if (search.length > 4096) return false;
  const values = new URLSearchParams(search).getAll('next');
  return values.length === 1 && values[0] === 'live';
}

export function resolveLiveIntent(search: string, storage: Store, now: number = Date.now()): boolean {
  if (liveIntentFromSearch(search)) {
    try { storage.setItem(KEY, String(now)); } catch { /* the address alone still carries the hint */ }
    return true;
  }
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return false;
    const saved = Number(raw);
    if (!Number.isFinite(saved) || saved > now + 5_000 || now - saved > MAX_AGE_MS) { storage.removeItem(KEY); return false; }
    return true;
  } catch { return false; }
}

export function clearLiveIntent(storage: Store): void {
  try { storage.removeItem(KEY); } catch { /* storage is optional */ }
}

/** The live page opens with a short welcome after the sign-in that came from "Create session". */
export const LIVE_WELCOME_QUERY = 'welcome';
export const liveWelcomePath = (): string => `${LIVE_PATH}?${LIVE_WELCOME_QUERY}=1`;
