import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen, type Display } from 'electron';
import { z } from 'zod';
import { MIN_AREA_DIP, type ShotRect, type ShotSize } from '../../shared/shotGeometry';
import type { AppSettings } from '../../shared/types';
import { developmentRendererUrl } from '../rendererLocation';

const selectionSchema = z.object({
  rect: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().min(MIN_AREA_DIP), height: z.number().finite().min(MIN_AREA_DIP) }),
  viewport: z.object({ width: z.number().finite().positive().max(32_768), height: z.number().finite().positive().max(32_768) }),
});
export interface AreaSelection { display: Display; rect: ShotRect; viewport: ShotSize }

/** Short-lived, unprivileged selector windows. No image or provider data goes to them. */
export class AreaShotController {
  private cancelActive: (() => void) | null = null;
  cancel(): void { this.cancelActive?.(); }

  select(signal: AbortSignal, theme: AppSettings['theme'] = 'dark'): Promise<AreaSelection | null> {
    if (this.cancelActive) throw new Error('An area selection is already open.');
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const windows = new Map<BrowserWindow, Display>();
      let settled = false;
      const finish = (selection: AreaSelection | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        this.cancelActive = null;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        ipcMain.removeHandler('area:submit');
        ipcMain.removeListener('area:cancel', cancelFromOverlay);
        screen.removeListener('display-added', changed);
        screen.removeListener('display-removed', changed);
        screen.removeListener('display-metrics-changed', changed);
        for (const overlay of windows.keys()) {
          if (overlay.isDestroyed()) continue;
          // Clear the shaded compositor surface before closing it. Windows can
          // otherwise retain the last dimmed frame briefly over the restored UI.
          overlay.setOpacity(0);
          overlay.hide();
          overlay.destroy();
        }
        if (error) reject(error); else resolve(selection);
      };
      const cancel = (): void => finish(null);
      const changed = (): void => finish(null, new Error('Display configuration changed. Please start Area Shot again.'));
      const ownedWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | undefined =>
        [...windows.keys()].find(w => !w.isDestroyed() && event.sender === w.webContents && event.senderFrame === w.webContents.mainFrame);
      const cancelFromOverlay = (event: Electron.IpcMainEvent): void => { if (ownedWindow(event)) cancel(); };
      const timeout = setTimeout(cancel, 120_000);
      this.cancelActive = cancel;
      signal.addEventListener('abort', cancel, { once: true });
      screen.on('display-added', changed);
      screen.on('display-removed', changed);
      screen.on('display-metrics-changed', changed);
      ipcMain.on('area:cancel', cancelFromOverlay);
      ipcMain.handle('area:submit', (event, input: unknown) => {
        const overlay = ownedWindow(event);
        if (!overlay) throw new Error('Unauthorized selection sender.');
        const parsed = selectionSchema.safeParse(input);
        if (!parsed.success) return { ok: false, error: 'Select a larger area inside this display.' };
        const { rect, viewport } = parsed.data;
        const display = windows.get(overlay)!;
        // The isolated overlay always uses zoom 1. Validate its viewport against
        // the display that owns it; never trust a renderer-supplied display ID.
        if (Math.abs(viewport.width - display.bounds.width) > 2 || Math.abs(viewport.height - display.bounds.height) > 2
          || rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1) {
          return { ok: false, error: 'Display dimensions changed. Cancel and select again.' };
        }
        // Return the IPC response before destroying the submitting renderer.
        setImmediate(() => finish({ display, rect, viewport }));
        return { ok: true };
      });
      try {
        const displays = screen.getAllDisplays();
        if (!displays.length) throw new Error('No displays are available for Area Shot.');
        for (const display of displays) {
          const overlay = new BrowserWindow({
            ...display.bounds, frame: false, transparent: true, backgroundColor: '#00000000',
            show: false, skipTaskbar: true, resizable: false, movable: false, hasShadow: false,
            enableLargerThanScreen: true, fullscreenable: false,
            webPreferences: { preload: path.join(__dirname, '../../preload/areaPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, zoomFactor: 1, partition: 'area-shot' },
          });
          windows.set(overlay, display);
          // Every selector is a separate native window; protection is not inherited
          // from the copilot window. Apply before showing any selection UI/buttons.
          overlay.setContentProtection(true);
          overlay.setAlwaysOnTop(true, 'screen-saver');
          overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          overlay.webContents.on('will-navigate', event => event.preventDefault());
          overlay.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'Escape') { event.preventDefault(); cancel(); }
          });
          overlay.on('closed', () => { if (!settled) cancel(); });
          overlay.webContents.on('render-process-gone', () => finish(null, new Error('Area selection closed unexpectedly. Please retry.')));
          overlay.once('ready-to-show', () => {
            if (settled || overlay.isDestroyed()) return;
            overlay.setBounds(display.bounds);
            overlay.show();
          });
          // Only appearance is shared with this isolated, selection-only renderer.
          const appearance = theme === 'light' || theme === 'system' ? theme : 'dark';
          const devRendererUrl = developmentRendererUrl(app.isPackaged, process.env.VITE_DEV_SERVER_URL);
          const loaded = devRendererUrl
            ? overlay.loadURL(`${devRendererUrl}/area.html?theme=${appearance}`)
            : overlay.loadFile(path.join(__dirname, '../../renderer/area.html'), { query: { theme: appearance } });
          void loaded.catch(() => finish(null, new Error('Area selector could not load. Rebuild the app and retry.')));
        }
      } catch (error) { finish(null, error instanceof Error ? error : new Error('Area selection failed.')); }
    });
  }
}
