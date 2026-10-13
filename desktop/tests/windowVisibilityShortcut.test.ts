import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWindowVisibilityShortcut } from '../src/main/windowVisibilityShortcut';

function fakeWindow(visible = true) {
  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    hide: vi.fn(() => { visible = false; }),
    showInactive: vi.fn(() => { visible = true; }),
    // Any accidental expansion of the shortcut's job is observable here.
    show: vi.fn(), focus: vi.fn(), close: vi.fn(), minimize: vi.fn(), setBounds: vi.fn(),
    loadURL: vi.fn(), loadFile: vi.fn(), webContents: { reload: vi.fn(), send: vi.fn() },
  };
  return window;
}
function setup(window: ReturnType<typeof fakeWindow> | null = fakeWindow()) {
  let callback = () => {};
  const shortcuts = { register: vi.fn((_key: string, action: () => void) => { callback = action; return true; }), unregister: vi.fn() };
  const getWindow = vi.fn(() => window);
  const cleanup = registerWindowVisibilityShortcut(shortcuts, getWindow);
  return { shortcuts, getWindow, cleanup, press: () => callback() };
}
afterEach(() => vi.restoreAllMocks());

describe('native Alt+H visibility shortcut', () => {
  it('registers the exact global accelerator without hiding or showing at registration', () => {
    const window = fakeWindow();
    const test = setup(window);
    expect(test.shortcuts.register).toHaveBeenCalledExactlyOnceWith('Alt+H', expect.any(Function));
    expect(test.getWindow).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });
  it('hides a visible window and shows that same instance quietly on the next press', () => {
    const window = fakeWindow();
    const test = setup(window);
    test.press();
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.isVisible()).toBe(false);
    test.press();
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.isVisible()).toBe(true);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(test.shortcuts.unregister).not.toHaveBeenCalled();
  });
  it('shows an initially hidden window without a focus prerequisite', () => {
    const window = fakeWindow(false);
    setup(window).press();
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.hide).not.toHaveBeenCalled();
  });
  it('never closes, minimizes, resizes, reloads, navigates or sends renderer commands', () => {
    const window = fakeWindow();
    const test = setup(window);
    for (let index = 0; index < 20; index += 1) test.press();
    for (const action of [window.close, window.minimize, window.setBounds, window.loadURL, window.loadFile,
      window.webContents.reload, window.webContents.send, window.focus, window.show]) expect(action).not.toHaveBeenCalled();
    expect(test.shortcuts.register).toHaveBeenCalledTimes(1);
  });
  it('ignores missing and destroyed windows', () => {
    const test = setup(null);
    expect(test.press).not.toThrow();
    const window = fakeWindow();
    window.isDestroyed.mockReturnValue(true);
    test.getWindow.mockReturnValue(window);
    expect(test.press).not.toThrow();
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });
  it('resolves a normally recreated main window without registering again', () => {
    const original = fakeWindow();
    const replacement = fakeWindow();
    const test = setup(original);
    test.getWindow.mockReturnValue(replacement);
    test.press();
    expect(replacement.hide).toHaveBeenCalledTimes(1);
    expect(original.hide).not.toHaveBeenCalled();
    expect(test.shortcuts.register).toHaveBeenCalledTimes(1);
  });
  it('unregisters only Alt+H once and makes a late callback harmless', () => {
    const window = fakeWindow();
    const test = setup(window);
    test.cleanup(); test.cleanup(); test.press();
    expect(test.shortcuts.unregister).toHaveBeenCalledExactlyOnceWith('Alt+H');
    expect(window.hide).not.toHaveBeenCalled();
  });
  it.each(['occupied', 'exception'])('logs safely and remains functional on %s registration failure', failure => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shortcuts = { register: vi.fn(() => { if (failure === 'exception') throw new Error('private OS detail'); return false; }), unregister: vi.fn() };
    const cleanup = registerWindowVisibilityShortcut(shortcuts, () => fakeWindow());
    expect(cleanup).not.toThrow();
    expect(shortcuts.unregister).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith('[window-shortcut] Alt+H unavailable; visibility shortcut disabled.');
  });
  it('does not let unregister failure disrupt the remaining app cleanup', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const test = setup();
    test.shortcuts.unregister.mockImplementation(() => { throw new Error('private OS detail'); });
    expect(test.cleanup).not.toThrow();
    expect(warning).toHaveBeenCalledExactlyOnceWith('[window-shortcut] Alt+H cleanup unavailable.');
  });
  it('wires registration after readiness outside createWindow and cleanup into will-quit', () => {
    const main = fs.readFileSync('src/main/main.ts', 'utf8');
    const startup = main.slice(main.indexOf('app\r\n  .whenReady()') >= 0 ? main.indexOf('app\r\n  .whenReady()') : main.indexOf('app\n  .whenReady()'));
    expect(startup).toMatch(/whenReady\(\)[\s\S]*if \(!ownsProfile\) return;[\s\S]*await createWindow\(\);[\s\S]*registerWindowVisibilityShortcut\(globalShortcut, \(\) => mainWindow\)/);
    expect(main.match(/registerWindowVisibilityShortcut\(globalShortcut/g)).toHaveLength(1);
    expect(main).toMatch(/'will-quit',[\s\S]*unregisterWindowVisibilityShortcut\(\);\s*database\?\.close\(\)/);
    expect(main).toContain('backgroundThrottling: false');
    for (const option of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'skipTaskbar: true',
      'frame: false', 'transparent: true', 'alwaysOnTop: true', 'window.setContentProtection(true)']) expect(main).toContain(option);
    const shortcut = fs.readFileSync('src/main/windowVisibilityShortcut.ts', 'utf8');
    for (const forbidden of ['setTimeout', 'setInterval', 'setBounds', 'webContents', '.focus(', '.on(', 'orchestrator', 'license', 'updates']) expect(shortcut).not.toContain(forbidden);
  });
});
