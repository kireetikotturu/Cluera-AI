import type { BrowserWindow, GlobalShortcut } from 'electron';

type VisibilityWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible' | 'hide' | 'showInactive'>;

// Called once after app readiness, not from createWindow. Resolve the current
// main window per keypress so normal window recreation never adds a shortcut.
export function registerWindowVisibilityShortcut(
  shortcuts: Pick<GlobalShortcut, 'register' | 'unregister'>,
  getWindow: () => VisibilityWindow | null,
): () => void {
  let registered = false;
  try {
    registered = shortcuts.register('Alt+H', () => {
      if (!registered) return;
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isVisible()) window.hide();
      else window.showInactive();
    });
  } catch { /* OS registration failure must not prevent application startup. */ }
  if (!registered) console.warn('[window-shortcut] Alt+H unavailable; visibility shortcut disabled.');

  return () => {
    if (!registered) return;
    registered = false;
    try { shortcuts.unregister('Alt+H'); }
    catch { console.warn('[window-shortcut] Alt+H cleanup unavailable.'); }
  };
}
