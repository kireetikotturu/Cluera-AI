import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerIpc } from '../src/main/ipc/registerIpc';
import { registerAccountIpc } from '../src/main/accounts/registerAccountIpc';
import { trackedIpc } from '../src/main/ipc/trackedIpc';
import { IPC } from '../src/shared/ipc';

/** ipcMain that, like Electron, refuses a second handler for one channel. */
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const subscriptions = new Map<string, Set<(...args: any[]) => void>>();
  return {
    handlers, subscriptions,
    ipcMain: {
      handle(channel: string, listener: (...args: any[]) => any) {
        if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        handlers.set(channel, listener);
      },
      removeHandler(channel: string) { handlers.delete(channel); },
      on(channel: string, listener: (...args: any[]) => void) {
        if (!subscriptions.has(channel)) subscriptions.set(channel, new Set());
        subscriptions.get(channel)!.add(listener);
      },
      removeListener(channel: string, listener: (...args: any[]) => void) { subscriptions.get(channel)?.delete(listener); },
    },
    appEvents: new Map<string, Set<unknown>>(),
    getSources: vi.fn(),
    displayHandler: vi.fn(),
  };
});
vi.mock('electron', () => ({
  app: {
    on: (name: string, listener: unknown) => { if (!electron.appEvents.has(name)) electron.appEvents.set(name, new Set()); electron.appEvents.get(name)!.add(listener); },
    removeListener: (name: string, listener: unknown) => electron.appEvents.get(name)?.delete(listener),
    focus: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] }, desktopCapturer: { getSources: electron.getSources }, dialog: {}, shell: {},
  ipcMain: electron.ipcMain,
  globalShortcut: { register: () => true, unregister: vi.fn() },
  session: { defaultSession: { setDisplayMediaRequestHandler: electron.displayHandler } },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getPrimaryDisplay: () => ({ id: 2 }) },
}));

function fakeWindow() {
  const webContents = Object.assign(new EventEmitter(), { mainFrame: {}, getZoomFactor: () => 1, setZoomFactor: vi.fn(), focus: vi.fn(), send: vi.fn(), isDestroyed: () => false });
  return Object.assign(new EventEmitter(), {
    webContents, isDestroyed: () => false, isVisible: () => true, isFocused: () => false, isFocusable: () => true,
    setSkipTaskbar: vi.fn(), setFocusable: vi.fn(), showInactive: vi.fn(), restore: vi.fn(), isMinimized: () => false,
    setAlwaysOnTop: vi.fn(), setOpacity: vi.fn(), setContentProtection: vi.fn(), setIgnoreMouseEvents: vi.fn(),
  });
}
const userA = '00000000-0000-4000-8000-00000000000a';
function register(window: ReturnType<typeof fakeWindow>, userId: string) {
  const ipc = registerIpc(window as never, { accountManaged: true, screen: {}, gemini: {}, deepgram: {} } as never,
    { getSettings: () => ({}) } as never, {} as never, {} as never, { stop: vi.fn(async () => undefined) } as never,
    {} as never, { assertEntitled: vi.fn(), isEntitled: () => true }, { keepFresh: vi.fn() } as never, { assertSupported: vi.fn() } as never);
  const account = { status: () => ({ mode: 'cluera-staging', state: 'active', userId }) };
  const disposeAccount = registerAccountIpc(window as never, account as never, { workspaceUserId: userId, stop: vi.fn(async () => undefined), restart: vi.fn(), updates: {} } as never);
  return { ...ipc, disposeAccount };
}
afterEach(() => { electron.handlers.clear(); electron.subscriptions.clear(); electron.appEvents.clear(); vi.clearAllMocks(); });

describe('switching account workspaces without restarting the app', () => {
  it('removes everything one workspace registered, so the next one registers cleanly', () => {
    const window = fakeWindow();
    const loading = trackedIpc(electron.ipcMain as never);
    loading.handle('account:status', () => 'loading');
    loading.handle(IPC.app.close, () => undefined);
    loading.dispose();
    const first = register(window, userA);
    const channels = [...electron.handlers.keys()].sort();
    const listenersOnWindow = () => ['close', 'minimize', 'closed', 'show', 'restore', 'focus', 'always-on-top-changed'].map(name => window.listenerCount(name));
    const firstCounts = listenersOnWindow();
    first.disposeAccount(); first.dispose();
    expect(electron.handlers.size).toBe(0);
    expect([...electron.subscriptions.values()].every(set => set.size === 0)).toBe(true);
    expect(listenersOnWindow().every(count => count === 0)).toBe(true);
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
    expect(electron.appEvents.get('before-quit')?.size ?? 0).toBe(0);
    expect(electron.displayHandler).toHaveBeenLastCalledWith(null);
    const second = register(window, '00000000-0000-4000-8000-00000000000b');
    expect([...electron.handlers.keys()].sort()).toEqual(channels);
    expect(listenersOnWindow()).toEqual(firstCounts);        // nothing piles up from switch to switch
    second.disposeAccount(); second.dispose();
  });

  it('never leaves a launcher-sized window behind when the workspace switches while collapsed', () => {
    const window = Object.assign(fakeWindow(), {
      getBounds: () => ({ x: 432, y: 6, width: 1056, height: 972 }), setBounds: vi.fn(), getMaximumSize: () => [0, 0], getMinimumSize: () => [420, 360],
      setMaximumSize: vi.fn(), setMinimumSize: vi.fn(), isAlwaysOnTop: () => true, hasShadow: () => true, setHasShadow: vi.fn(), setBackgroundColor: vi.fn(),
    });
    const ipc = register(window, userA);
    electron.handlers.get(IPC.app.liveCollapse)!({ sender: window.webContents }, true);
    expect(window.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 44, height: 44 }), false);
    ipc.disposeAccount(); ipc.dispose();
    expect(window.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1056, height: 972 }), false);
    expect(window.setMaximumSize).toHaveBeenLastCalledWith(0, 0);
  });

  it('picks the primary screen for output audio without listing windows or taking pictures, and captures it as chosen', async () => {
    const window = fakeWindow(); const ipc = register(window, userA);
    electron.getSources.mockResolvedValue([{ id: 'screen:1:0', name: 'Screen 1', display_id: '1' }, { id: 'screen:2:0', name: 'Screen 2', display_id: '2' }]);
    const chosen = await electron.handlers.get(IPC.audio.defaultSystemSource)!({ sender: window.webContents });
    expect(chosen).toEqual({ id: 'screen:2:0', name: 'Screen 2' });
    expect(electron.getSources).toHaveBeenCalledExactlyOnceWith({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const capture = electron.displayHandler.mock.calls.find(([handler]) => typeof handler === 'function')![0];
    const callback = vi.fn(); await capture({}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ video: { id: 'screen:2:0', name: 'Screen 2' }, audio: 'loopback' });
    expect(electron.getSources).toHaveBeenCalledOnce();
    ipc.disposeAccount(); ipc.dispose();
  });
});
