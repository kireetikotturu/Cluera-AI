import type { BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc';
import type { AppEventMap } from '../shared/types';

/** The customer continues in their browser: the page collapses the window to its floating logo (never during a live
 * session), and shows it again when the work there is finished. Coming back also raises the window above the browser. */
export function announceHandoff(window: BrowserWindow, event: AppEventMap['window:handoff']): void {
  try {
    if (window.isDestroyed?.() || window.webContents.isDestroyed?.()) return;
    window.webContents.send?.(IPC.events, 'window:handoff', event);
    if (event.phase === 'back') { window.moveTop?.(); window.focus?.(); }
  } catch { /* The window is closing: there is nothing to bring forward. */ }
}
