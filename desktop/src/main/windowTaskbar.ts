import type { BrowserWindow } from 'electron';

type TaskbarWindow = Pick<BrowserWindow, 'isDestroyed' | 'setSkipTaskbar'>;

export function keepWindowOffTaskbar(window: TaskbarWindow, platform = process.platform): void {
  if (platform === 'win32' && !window.isDestroyed()) window.setSkipTaskbar(true);
}

// Install once per main window. show covers Alt+H and screen-capture restoration.
// No focus/blur/resize listeners or timers: ordinary interaction needs no work.
export function installTaskbarInvariant(window: BrowserWindow, platform = process.platform): void {
  if (platform !== 'win32') return;
  const enforce = (): void => keepWindowOffTaskbar(window, platform);
  enforce();
  window.on('show', enforce);
  window.on('restore', enforce);
  window.once('closed', () => {
    window.removeListener('show', enforce);
    window.removeListener('restore', enforce);
  });
}

export function ensureFocusableOffTaskbar(
  window: TaskbarWindow & Pick<BrowserWindow, 'isFocusable' | 'setFocusable'>,
  platform = process.platform,
): void {
  if (window.isDestroyed() || window.isFocusable()) return;
  // Electron Windows SetFocusable(true) calls SetSkipTaskbar(false).
  // Avoid the redundant setter, and enforce AFTER any necessary native change.
  window.setFocusable(true);
  keepWindowOffTaskbar(window, platform);
}
