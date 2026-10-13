import { BrowserWindow, desktopCapturer, screen, type NativeImage } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { areaPixels } from '../../shared/shotGeometry';
import type { AppSettings, ShotKind } from '../../shared/types';
import { AreaShotController } from './AreaShotController';

export interface ShotFrame { image: NativeImage; sourceId: string; sourceName: string; scaleFactor: number; kind: ShotKind; capturedAt: string }
export interface ShotCaptureOptions { keepOwnerVisible?: boolean; theme?: AppSettings['theme'] }

function boundedCapture<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = (): void => { cleanup(); reject(signal.reason ?? new Error('Capture canceled.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Screen capture timed out. Check screen-recording permission and try again.')); }, 10_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    // Attach both handlers even after cancellation: a late native result is
    // ignored, and a late rejection must not become an unhandled rejection.
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class ShotCapture {
  private readonly area = new AreaShotController();
  private active: AbortController | null = null;
  constructor(private readonly owner: BrowserWindow, private readonly maxDimension: number) {}
  cancel(): void { this.active?.abort(); this.area.cancel(); }

  async capture(kind: ShotKind, sourceId?: string, options: ShotCaptureOptions = {}): Promise<ShotFrame | null> {
    if (this.active) throw new Error('A screenshot capture is already running.');
    const abort = new AbortController();
    this.active = abort;
    const visible = this.owner.isVisible();
    const capturesWholeDisplay = kind === 'area' || !sourceId?.startsWith('window:');
    const hideOwner = visible && capturesWholeDisplay && !options.keepOwnerVisible;
    let ownerHidden = false;
    const restoreOwner = (activate = false): void => {
      if (!ownerHidden) return;
      ownerHidden = false;
      if (this.owner.isDestroyed()) return;
      // Area selection temporarily owns focus. Return it to the session so the
      // restored tab uses its normal active appearance instead of an inactive,
      // dimmed Windows surface. Other capture paths keep their old behavior.
      if (activate) this.owner.show();
      else this.owner.showInactive();
    };
    const cancel = (): void => this.cancel();
    this.owner.once('closed', cancel);
    // A selected window thumbnail contains only that window. Camera-triggered
    // display captures also stay visually stable and rely on the owner's
    // existing Windows content protection. Area selection retains the explicit
    // hide/restore lifecycle so neither the app nor selector contaminates it.
    if (hideOwner) { this.owner.hide(); ownerHidden = true; }
    try {
      const area = kind === 'area' ? await this.area.select(abort.signal, options.theme) : null;
      if (kind === 'area' && !area) return null;
      // Use Area has completed and every selector window is already destroyed.
      // Restore the protected owner before the native screen-source request,
      // which can itself take one or two seconds on Windows. Area selection was
      // the active UI, so restore the normal session as the active window.
      if (kind === 'area') restoreOwner(true);
      // Let the compositor settle selector removal and owner protection.
      await delay(80, undefined, { signal: abort.signal });
      let dimension = Math.min(8_192, this.maxDimension);
      if (area) dimension = Math.min(8_192, Math.ceil(Math.max(area.display.bounds.width, area.display.bounds.height) * area.display.scaleFactor));
      const sources = await boundedCapture(desktopCapturer.getSources({
        types: area ? ['screen'] : sourceId?.startsWith('window:') ? ['window'] : ['screen', 'window'],
        thumbnailSize: { width: dimension, height: dimension }, fetchWindowIcons: false,
      }), abort.signal);
      abort.signal.throwIfAborted();
      const source = area
        ? sources.find(item => item.display_id === String(area.display.id))
        : sources.find(item => item.id === sourceId);
      if (!source) throw new Error('The selected surface is unavailable. Choose a visible window or display again.');
      if (source.thumbnail.isEmpty()) throw new Error('Capture returned an empty image. Check screen-recording permission and keep the source visible.');
      const display = area?.display ?? screen.getAllDisplays().find(item => String(item.id) === source.display_id);
      if (area) {
        const current = screen.getAllDisplays().find(item => item.id === area.display.id);
        if (!current || current.scaleFactor !== area.display.scaleFactor || JSON.stringify(current.bounds) !== JSON.stringify(area.display.bounds)) {
          throw new Error('Display configuration changed during capture. Please select the area again.');
        }
      }
      let image = source.thumbnail;
      const size = image.getSize();
      if (size.width < 1 || size.height < 1 || size.width * size.height > 40_000_000) throw new Error('The screenshot dimensions are invalid or too large.');
      if (area) image = image.crop(areaPixels(area.rect, area.viewport, size));
      return { image, sourceId: source.id, sourceName: area ? `${source.name} · selected area` : source.name,
        scaleFactor: display?.scaleFactor ?? 1, kind, capturedAt: new Date().toISOString() };
    } catch (error) {
      if (abort.signal.aborted) return null;
      throw error;
    } finally {
      this.owner.removeListener('closed', cancel);
      this.active = null;
      restoreOwner(kind === 'area');
    }
  }
}
