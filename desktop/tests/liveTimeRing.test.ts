// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LiveTimeRing } from '../src/renderer/components/LiveTimeRing';
import type { CreditsView } from '../src/shared/accountCredits';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, push: (view: CreditsView) => void;
const view = (available: number, over: Partial<CreditsView> = {}): CreditsView => ({ state: 'ready', refreshing: false, active: false, activeMilliseconds: 0,
  lastSync: new Date().toISOString(), snapshot: { userId: 'u', serverTime: '', displayName: '', availableMilliseconds: available, reservedMilliseconds: 0, spentMilliseconds: 0,
    buckets: [{ kind: 'PACK', grantedMilliseconds: 10_800_000, spentMilliseconds: 0, reservedMilliseconds: 0, availableMilliseconds: available }], plans: [], payments: [], checkoutAvailable: true }, ...over });
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (window as unknown as { accountAPI: unknown }).accountAPI = { credits: { refresh: async () => view(0), onChange: (callback: (v: CreditsView) => void) => { push = callback; return () => undefined; } } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const ring = () => host.querySelector('.live-time-ring')!;
it('shows hours and minutes left as a ring and warns when time is low', async () => {
  await act(async () => { root.render(createElement(LiveTimeRing)); });
  await act(async () => { push(view(3 * 3_600_000 + 5 * 60_000)); });
  expect(ring().getAttribute('aria-label')).toBe('3 hours 5 minutes left');
  expect(ring().className).toContain('ok');
  await act(async () => { push(view(8 * 60_000)); });
  expect(ring().getAttribute('aria-label')).toBe('8 minutes left');
  expect(ring().className).toContain('low');
  await act(async () => { push(view(2 * 60_000)); });
  expect(ring().className).toContain('critical');
});
it('never shows a negative or overflowing ring', async () => {
  await act(async () => { root.render(createElement(LiveTimeRing)); });
  await act(async () => { push(view(0)); });
  expect(ring().getAttribute('aria-label')).toBe('0 minutes left');
  const offset = Number(host.querySelector('.ring-value')!.getAttribute('stroke-dashoffset'));
  expect(offset).toBeGreaterThanOrEqual(0);
});
