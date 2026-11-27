import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserHandoff } from '../src/renderer/components/BrowserHandoff';
import { useAppStore } from '../src/renderer/stores/appStore';
import type { AppEventMap } from '../src/shared/types';

const require = createRequire(import.meta.url), { JSDOM } = require('jsdom');
let dom: any, root: ReturnType<typeof createRoot>, handoff: (event: AppEventMap['window:handoff']) => void;
const collapsed = vi.fn(async (_value: boolean) => undefined);

beforeEach(() => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  collapsed.mockClear();
  dom.window.electronAPI = {
    onEvent: (name: string, callback: typeof handoff) => { if (name === 'window:handoff') handoff = callback; return () => undefined; },
    setLiveCollapsed: collapsed, moveLiveCollapsed: vi.fn(),
  };
  useAppStore.setState(useAppStore.getInitialState(), true);
  root = createRoot(document.getElementById('root')!);
});
afterEach(() => { act(() => root.unmount()); dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const render = async (owner = 'signed-out') => act(async () => root.render(createElement(BrowserHandoff, { owner, children: createElement('input', { id: 'typed' }) })));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const send = async (event: AppEventMap['window:handoff']) => act(async () => { handoff(event); await settle(); });
const screen = () => document.querySelector('.handoff-screen') as HTMLElement;
const logo = () => document.querySelector('dialog.handoff-launcher button[aria-label="Return to Cluera AI"]') as HTMLButtonElement | null;

describe('the window while the customer works in the browser', () => {
  it('steps aside to the floating logo and comes back on a click, keeping what was typed', async () => {
    await render();
    (document.getElementById('typed') as HTMLInputElement).value = 'typed text';
    await send({ phase: 'away', purpose: 'account' });
    expect(collapsed).toHaveBeenLastCalledWith(true);
    expect(screen().style.display).toBe('none');
    expect(document.documentElement.dataset.liveCollapsed).toBe('true');
    // The logo sits in its own open dialog, so a pop-up left open behind it cannot block it.
    expect(document.querySelector('dialog.handoff-launcher')?.hasAttribute('open')).toBe(true);
    await act(async () => { logo()!.click(); await settle(); });
    expect(collapsed).toHaveBeenLastCalledWith(false);
    expect(screen().style.display).toBe('contents');
    expect(logo()).toBeNull();
    expect(document.documentElement.dataset.liveCollapsed).toBeUndefined();
    expect((document.getElementById('typed') as HTMLInputElement).value).toBe('typed text');
  });

  it('comes back on Escape', async () => {
    await render();
    await send({ phase: 'away', purpose: 'help' });
    const escape = new dom.window.Event('cancel', { cancelable: true });
    await act(async () => { document.querySelector('dialog.handoff-launcher')!.dispatchEvent(escape); await settle(); });
    expect(escape.defaultPrevented).toBe(true);
    expect(collapsed).toHaveBeenLastCalledWith(false);
    expect(logo()).toBeNull();
  });

  it('never collapses a live session', async () => {
    useAppStore.getState().setPage('copilot');
    await render('user');
    await send({ phase: 'away', purpose: 'help' });
    expect(collapsed).not.toHaveBeenCalled();
    expect(screen().style.display).toBe('contents');
  });

  it('comes back by itself after the payment, clears "time used up" and says so for a few seconds', async () => {
    useAppStore.getState().setTimeOver(true);
    await render('user');
    await send({ phase: 'away', purpose: 'checkout' });
    vi.useFakeTimers();
    await act(async () => { handoff({ phase: 'back', purpose: 'checkout', timeAdded: true }); await vi.advanceTimersByTimeAsync(20); });
    expect(collapsed).toHaveBeenLastCalledWith(false);
    expect(useAppStore.getState().timeOver).toBe(false);
    expect(document.querySelector('.handoff-notice')?.textContent).toBe('New time was added to your account.');
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(document.querySelector('.handoff-notice')).toBeNull();
  });

  it('is always full size after signing in or switching accounts, and ignores a return it did not need', async () => {
    await render('signed-out');
    await send({ phase: 'back', purpose: 'sign-in' });
    expect(collapsed).not.toHaveBeenCalled();
    await send({ phase: 'away', purpose: 'sign-in' });
    await render('00000000-0000-4000-8000-000000000001');
    await act(async () => { await settle(); });
    expect(collapsed.mock.calls.map(([value]) => value)).toEqual([true, false]);
    expect(logo()).toBeNull();
  });

  it('stays full size when the window cannot be collapsed', async () => {
    collapsed.mockRejectedValueOnce(new Error('workspace switching'));
    await render();
    await send({ phase: 'away', purpose: 'account' });
    expect(screen().style.display).toBe('contents');
    expect(logo()).toBeNull();
  });
});
