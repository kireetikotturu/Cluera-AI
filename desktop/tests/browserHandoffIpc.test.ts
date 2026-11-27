import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), openExternal: vi.fn(async (_url: string) => undefined), google: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler), removeHandler: (name: string) => mocks.handlers.delete(name) },
  shell: { openExternal: mocks.openExternal }, dialog: {},
}));
vi.mock('../src/main/accounts/GoogleAccountLogin', () => ({ googleAccountLogin: mocks.google }));

import { registerAccountIpc } from '../src/main/accounts/registerAccountIpc';
import { IPC } from '../src/shared/ipc';

const userId = '00000000-0000-4000-8000-000000000001';
type Open = (url: string) => Promise<void>;

beforeEach(() => { mocks.handlers.clear(); vi.clearAllMocks(); mocks.openExternal.mockImplementation(async () => undefined); });

function fixture(state: 'active' | 'signed-out' = 'signed-out') {
  const sent: unknown[] = [];
  const window = {
    webContents: { mainFrame: {}, isDestroyed: () => false, send: vi.fn((_channel: string, name: string, payload: unknown) => { if (name === 'window:handoff') sent.push(payload); }) },
    isDestroyed: () => false, moveTop: vi.fn(), focus: vi.fn(),
  };
  const view = { mode: 'cluera-staging', state, userId: state === 'active' ? userId : undefined };
  const attempt = new AbortController();
  const account = {
    status: vi.fn(() => view),
    loginExternal: vi.fn(async (acquire: (signal: AbortSignal) => Promise<unknown>) => {
      try { await acquire(attempt.signal); return { mode: 'cluera-staging', state: 'active', userId }; }
      catch { return { mode: 'cluera-staging', state: 'signed-out' }; }
    }),
    cancelExternal: vi.fn(() => { attempt.abort(); return { mode: 'cluera-staging', state: 'signed-out' }; }),
  };
  const credits = { checkoutOpened: vi.fn(), watchPurchase: vi.fn() };
  const options = { workspaceUserId: state === 'active' ? userId : undefined, stop: vi.fn(async () => undefined), restart: vi.fn(), credits,
    updates: { officialDownloadPage: () => 'https://www.clueraai.in/download' } };
  registerAccountIpc(window as never, account as never, options as never);
  const call = (name: string, ...args: unknown[]) => mocks.handlers.get(name)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  return { window, sent, account, credits, call };
}
const away = (purpose: string) => ({ phase: 'away', purpose });
const back = (purpose: string, extra: object = {}) => ({ phase: 'back', purpose, ...extra });

describe('stepping aside while the customer works in the browser', () => {
  it('steps aside once Google opens and comes back, on top, as soon as the browser returns', async () => {
    const f = fixture(); let finish!: () => void;
    mocks.google.mockImplementationOnce(async (open: Open, _signal: AbortSignal, _api: unknown, returned: () => void) => {
      await open('https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/authorize');
      await new Promise<void>((resolve) => { finish = resolve; });
      returned(); return {};
    });
    const pending = f.call('account:google');
    await vi.waitFor(() => expect(f.sent).toEqual([away('sign-in')]));
    expect(f.window.focus).not.toHaveBeenCalled();
    finish(); await pending;
    expect(f.sent).toEqual([away('sign-in'), back('sign-in')]);
    expect(f.window.moveTop).toHaveBeenCalledOnce(); expect(f.window.focus).toHaveBeenCalledOnce();
  });

  it('never collapses when the browser has already returned before the opener finishes', async () => {
    const f = fixture(); let opened!: () => void;
    mocks.openExternal.mockImplementationOnce(() => new Promise<undefined>((resolve) => { opened = () => resolve(undefined); }));
    mocks.google.mockImplementationOnce(async (open: Open, _signal: AbortSignal, _api: unknown, returned: () => void) => {
      const opening = open('https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/authorize');
      returned(); opened(); await opening; return {};
    });
    await f.call('account:google');
    expect(f.sent).toEqual([]);
  });

  it('comes back when the browser sign-in fails or times out', async () => {
    const f = fixture();
    mocks.google.mockImplementationOnce(async (open: Open) => { await open('https://yhnqlfcgrmckhyjdxegg.supabase.co/x'); throw new Error('timed out'); });
    await f.call('account:google');
    expect(f.sent).toEqual([away('sign-in'), back('sign-in')]);
  });

  it('cancels only a browser sign-in that is waiting', async () => {
    const f = fixture();
    expect(f.call('account:google-cancel')).toMatchObject({ state: 'signed-out' });
    expect(f.account.cancelExternal).not.toHaveBeenCalled();
    mocks.google.mockImplementationOnce(async (open: Open, signal: AbortSignal) => {
      await open('https://yhnqlfcgrmckhyjdxegg.supabase.co/x');
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
    });
    const pending = f.call('account:google');
    await vi.waitFor(() => expect(f.sent).toEqual([away('sign-in')]));
    f.call('account:google-cancel');
    expect(await pending).toMatchObject({ state: 'signed-out' });
    expect(f.account.cancelExternal).toHaveBeenCalledOnce();
    expect(f.sent).toEqual([away('sign-in'), back('sign-in')]);
  });

  it('refuses a cancel from another renderer or frame', () => {
    const f = fixture();
    expect(() => mocks.handlers.get('account:google-cancel')!({ sender: {}, senderFrame: f.window.webContents.mainFrame })).toThrow('Unauthorized');
  });

  it('opens checkout, then comes back by itself once the paid time appears', async () => {
    const f = fixture('active');
    await f.call('account:open-web', 'credits');
    expect(mocks.openExternal).toHaveBeenCalledWith(`https://www.clueraai.in/account/checkout?desktopAccount=${userId}`);
    expect(f.credits.checkoutOpened).toHaveBeenCalledOnce();
    expect(f.credits.watchPurchase).toHaveBeenCalledOnce();
    expect(f.sent).toEqual([away('checkout')]);
    (f.credits.watchPurchase.mock.calls[0][0] as () => void)();
    expect(f.sent).toEqual([away('checkout'), back('checkout', { timeAdded: true })]);
    expect(f.window.focus).toHaveBeenCalledOnce();
  });

  it('steps aside for the account website and the download page', async () => {
    const f = fixture('active');
    await f.call('account:open-web', 'dashboard');
    await f.call(IPC.updates.openDownload);
    expect(f.sent).toEqual([away('account'), away('download')]);
    expect(f.credits.watchPurchase).not.toHaveBeenCalled();
  });

  it('stays on screen when the browser cannot be opened', async () => {
    const f = fixture('active');
    mocks.openExternal.mockRejectedValue(new Error('no browser'));
    await expect(f.call('account:open-web', 'signup')).rejects.toThrow('no browser');
    await expect(f.call('account:open-web', 'credits')).rejects.toThrow('no browser');
    expect(f.sent).toEqual([]);
    expect(f.credits.watchPurchase).not.toHaveBeenCalled();
  });
});
