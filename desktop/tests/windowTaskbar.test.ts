import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTaskbarInvariant, ensureFocusableOffTaskbar } from '../src/main/windowTaskbar';
import { registerWindowVisibilityShortcut } from '../src/main/windowVisibilityShortcut';
import { registerIpc } from '../src/main/ipc/registerIpc';
import { IPC } from '../src/shared/ipc';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn(), focus: vi.fn() }, BrowserWindow: {}, desktopCapturer: {}, dialog: {}, shell: {},
  ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => handlers.set(key, fn), on: vi.fn() },
  globalShortcut: { register: () => true, unregister: vi.fn() },
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

function fixture() {
  let visible = false, focusable = true, focused = false, skipped = false, destroyed = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, isVisible: () => visible, isFocused: () => focused, isFocusable: () => focusable,
    setSkipTaskbar: vi.fn((skip: boolean) => { skipped = skip; }),
    // Models the documented Electron Windows side effect, not a no-op mock.
    setFocusable: vi.fn((value: boolean) => { focusable = value; skipped = !value; }),
    hide: () => { visible = false; focused = false; },
    showInactive: () => { visible = true; skipped = false; win.emit('show'); },
    show: () => { visible = true; skipped = false; win.emit('show'); },
    restore: () => { skipped = false; win.emit('restore'); },
    focus: () => { focused = true; win.emit('focus'); }, moveTop: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 640, height: 720 }), setBounds: vi.fn(),
    getMaximumSize: () => [1920, 1080], getMinimumSize: () => [320, 240],
    setMaximumSize: vi.fn(), setMinimumSize: vi.fn(), isAlwaysOnTop: () => true, setAlwaysOnTop: vi.fn(),
    hasShadow: () => false, setHasShadow: vi.fn(), setBackgroundColor: vi.fn(), setOpacity: vi.fn(), setContentProtection: vi.fn(),
    webContents: { mainFrame: {}, getZoomFactor: () => 1, setZoomFactor: vi.fn(), focus: vi.fn() },
  });
  installTaskbarInvariant(win as never, 'win32');
  const answer = vi.fn(async () => true);
  const startRound = vi.fn(), roundHistory = vi.fn(() => ({ conversation: [], questions: [], hasMore: false }));
  const assertEntitled = vi.fn(), assertSupported = vi.fn();
  registerIpc(win as never, { accountManaged:true, screen: {}, gemini: {managed:vi.fn()}, deepgram: {} } as never,
    { getSettings: () => ({}), roundHistory } as never, { startRound } as never, {} as never, { answer } as never,
    {} as never, { assertEntitled } as never, {} as never, { assertSupported } as never);
  const call = (key: string, ...args: unknown[]) => handlers.get(key)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
  return { win, call, answer, startRound, roundHistory, assertEntitled, assertSupported, skipped: () => skipped, destroy: () => { destroyed = true; win.emit('closed'); } };
}
afterEach(() => { handlers.clear(); vi.restoreAllMocks(); });

describe('main-window taskbar invariant', () => {
  it('keeps round IPC entitlement/sender checks and rejects malformed or active-session creation', () => {
    const { call, win, startRound, roundHistory, assertEntitled } = fixture();
    const id = '00000000-0000-4000-8000-000000000001';
    call(IPC.sessions.startRound, id, 'Technical'); expect(startRound).toHaveBeenCalledWith(id, 'Technical');
    call(IPC.sessions.roundHistory, id, 'legacy-round', 0); expect(roundHistory).toHaveBeenCalledWith(id, 'legacy-round', 0);
    expect(() => call(IPC.sessions.startRound, id, 'x'.repeat(2001))).toThrow('Invalid');
    expect(() => call(IPC.sessions.roundHistory, id, 'legacy-round', -1)).toThrow('Invalid');
    expect(() => handlers.get(IPC.sessions.startRound)!({ sender: {}, senderFrame: win.webContents.mainFrame }, id, '')).toThrow('Unauthorized');
    expect(() => handlers.get(IPC.sessions.roundHistory)!({ sender: win.webContents, senderFrame: {} }, id, 'round', 0)).toThrow('Unauthorized');
    call(IPC.app.sessionMode, true);
    expect(() => call(IPC.sessions.startRound, id, '')).toThrow('End the live session');
    assertEntitled.mockImplementationOnce(() => { throw new Error('Denied'); });
    expect(() => call(IPC.sessions.roundHistory, id, 'round', 0)).toThrow('Denied');
  });
  it('starts hidden from taskbar and survives show/restore with no focus/resize polling', () => {
    const { win, skipped } = fixture();
    expect(skipped()).toBe(true); win.show(); expect(skipped()).toBe(true);
    win.restore(); expect(skipped()).toBe(true);
    const count = win.setSkipTaskbar.mock.calls.length;
    for (let i = 0; i < 100; i++) { win.emit('focus'); win.emit('blur'); win.emit('resize'); }
    expect(win.setSkipTaskbar).toHaveBeenCalledTimes(count);
  });
  it('Alt+H restore → manual focus → actual answer IPC never re-adds the taskbar button', async () => {
    const { win, call, skipped, answer } = fixture();
    let press = () => {};
    registerWindowVisibilityShortcut({ register: (_key, fn) => { press = fn; return true; }, unregister() {} }, () => win);
    win.show(); call(IPC.app.sessionMode, true); press(); press();
    expect(await call(IPC.app.focusLiveTranscript, true)).toBe(true);
    expect(win.setFocusable).not.toHaveBeenCalled();
    expect(skipped()).toBe(true);
    await call(IPC.interview.answer, { sessionId: '00000000-0000-4000-8000-000000000001', question: 'Explain this?', origin: 'typed' });
    expect(answer).toHaveBeenCalledOnce(); expect(skipped()).toBe(true);
  });
  it('restores the invariant after a necessary focusability change', () => {
    const { win, skipped } = fixture(); win.setFocusable(false);
    ensureFocusableOffTaskbar(win, 'win32');
    expect(win.isFocusable()).toBe(true); expect(skipped()).toBe(true);
  });
  it('preserves taskbar hiding through real session/collapse IPC handlers', () => {
    const { win, call, skipped } = fixture(); win.show();
    for (let i = 0; i < 10; i++) {
      call(IPC.app.sessionMode, true); expect(skipped()).toBe(true);
      call(IPC.app.liveCollapse, true); expect(skipped()).toBe(true);
      call(IPC.app.liveCollapse, false); expect(skipped()).toBe(true);
      call(IPC.app.sessionMode, false); expect(skipped()).toBe(true);
    }
  });
  it('removes lifecycle listeners on close and ignores destroyed windows', () => {
    const { win, destroy } = fixture(); destroy();
    expect(win.listenerCount('show')).toBe(0); expect(win.listenerCount('restore')).toBe(0);
    const count = win.setSkipTaskbar.mock.calls.length;
    ensureFocusableOffTaskbar(win, 'win32'); win.emit('show');
    expect(win.setSkipTaskbar).toHaveBeenCalledTimes(count);
  });
});
