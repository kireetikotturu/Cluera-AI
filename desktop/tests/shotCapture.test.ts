import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), displays: vi.fn(), select: vi.fn(), cancel: vi.fn() }));
vi.mock('electron', () => ({ desktopCapturer: { getSources: mocks.sources }, screen: { getAllDisplays: mocks.displays } }));
vi.mock('../src/main/screen/AreaShotController', () => ({ AreaShotController: class { select = mocks.select; cancel = mocks.cancel; } }));
import { ShotCapture } from '../src/main/screen/ShotCapture';

const display = { id: 42, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 };
function owner() {
  return Object.assign(new EventEmitter(), { isVisible: () => true, isDestroyed: () => false, hide: vi.fn(), show: vi.fn(), showInactive: vi.fn() });
}
function image() { return { isEmpty: () => false, getSize: () => ({ width: 2880, height: 1620 }), crop: vi.fn() }; }
beforeEach(() => { vi.clearAllMocks(); mocks.displays.mockReturnValue([display]); });

describe('shot capture lifecycle', () => {
  it('restores the app after a capture failure', async () => {
    const window = owner(); mocks.sources.mockRejectedValue(new Error('Permission denied'));
    await expect(new ShotCapture(window as unknown as BrowserWindow, 2560).capture('screen', 'screen:1')).rejects.toThrow('Permission denied');
    expect(window.hide).toHaveBeenCalledOnce(); expect(window.showInactive).toHaveBeenCalledOnce();
  });
  it('keeps Cluera AI visible when capturing a different selected window', async () => {
    const window = owner();
    mocks.sources.mockResolvedValue([{ id: 'window:meeting:1', display_id: '', name: 'Meeting', thumbnail: image() }]);
    const result = await new ShotCapture(window as unknown as BrowserWindow, 2560).capture('screen', 'window:meeting:1');
    expect(result).toMatchObject({ kind: 'screen', sourceId: 'window:meeting:1' });
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });
  it('keeps Cluera AI stable for a camera-triggered whole-display capture', async () => {
    const window = owner();
    mocks.sources.mockResolvedValue([{ id: 'screen:1', display_id: '42', name: 'Display', thumbnail: image() }]);
    const result = await new ShotCapture(window as unknown as BrowserWindow, 2560).capture(
      'screen',
      'screen:1',
      { keepOwnerVisible: true },
    );
    expect(result).toMatchObject({ kind: 'screen', sourceId: 'screen:1' });
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });
  it('returns quietly on cancelled selection without reading the screen', async () => {
    const window = owner(); mocks.select.mockResolvedValue(null);
    expect(await new ShotCapture(window as unknown as BrowserWindow, 2560).capture('area')).toBeNull();
    expect(mocks.sources).not.toHaveBeenCalled(); expect(window.show).toHaveBeenCalledOnce();
  });
  it('crops the chosen display at its actual pixel scale', async () => {
    const window = owner(); const raw = image(); const cropped = image(); raw.crop.mockReturnValue(cropped);
    mocks.select.mockResolvedValue({ display, rect: { x: 100, y: 50, width: 400, height: 300 }, viewport: { width: 1920, height: 1080 } });
    mocks.sources.mockImplementation(() => {
      expect(window.show).toHaveBeenCalledOnce();
      return Promise.resolve([{ id: 'screen:secondary', display_id: '42', name: 'Secondary', thumbnail: raw }]);
    });
    const result = await new ShotCapture(window as unknown as BrowserWindow, 2560).capture('area');
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(mocks.sources.mock.invocationCallOrder[0]);
    expect(raw.crop).toHaveBeenCalledWith({ x: 150, y: 75, width: 600, height: 450 });
    expect(result).toMatchObject({ kind: 'area', sourceId: 'screen:secondary', image: cropped });
  });
  it('rejects a display that changed after selection', async () => {
    mocks.select.mockResolvedValue({ display, rect: { x: 0, y: 0, width: 400, height: 300 }, viewport: { width: 1920, height: 1080 } });
    mocks.sources.mockResolvedValue([{ id: 'screen:secondary', display_id: '42', name: 'Secondary', thumbnail: image() }]);
    mocks.displays.mockReturnValue([{ ...display, scaleFactor: 2 }]);
    await expect(new ShotCapture(owner() as unknown as BrowserWindow, 2560).capture('area')).rejects.toThrow('Display configuration changed');
  });
  it('prevents overlapping captures and cancels an outstanding selector', async () => {
    const window = owner();
    mocks.select.mockImplementation((signal: AbortSignal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(null))));
    const service = new ShotCapture(window as unknown as BrowserWindow, 2560);
    const capture = service.capture('area');
    await expect(service.capture('area')).rejects.toThrow('already running');
    service.cancel(); expect(await capture).toBeNull(); expect(window.show).toHaveBeenCalledOnce();
  });
  it('restores the owner even if a native capture has not settled when canceled', async () => {
    const window = owner(); let started!: () => void;
    const nativeStarted = new Promise<void>(resolve => { started = resolve; });
    mocks.sources.mockImplementation(() => { started(); return new Promise(() => undefined); });
    const service = new ShotCapture(window as unknown as BrowserWindow, 2560);
    const capture = service.capture('screen', 'screen:1');
    await nativeStarted; service.cancel();
    expect(await capture).toBeNull(); expect(window.showInactive).toHaveBeenCalledOnce();
  });
});
