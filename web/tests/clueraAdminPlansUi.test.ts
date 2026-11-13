// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AdminPlans, describeChange, hoursText, hoursToSeconds, rupeesToPaise } from '../app/account/admin/AdminPlans';

const planId = '00000000-0000-4000-8000-000000000005', revisionId = '00000000-0000-4000-8000-000000000004';
const base = { planId, revisionId, offerCode: 'cluera_pack_3h_v2', name: 'Cluera 3 Hours', amountPaise: 54900, currency: 'INR', allowanceSeconds: 10800,
  kind: 'PACK', version: 1, enabled: true, archived: false, createdAt: '2026-10-24T00:00:00Z', openCheckouts: 0 };
let host: HTMLDivElement, root: Root, plans: Array<typeof base>, history: object[];
const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit | undefined]>;
const posts = () => calls().filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)));
const respond = (status: number, body: unknown) => Response.json(body, { status });
const render = async (disabled = false) => { await act(async () => root.render(createElement(AdminPlans, { disabled }))); };
const button = (name: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === name) as HTMLButtonElement | undefined;
const click = async (name: string) => { const target = button(name); if (!target) throw Error('no button ' + name); await act(async () => target.click()); };
const fill = async (values: Record<string, string>) => {
  const form = host.querySelector('form.account-admin-plan-form') as HTMLFormElement;
  for (const [name, value] of Object.entries(values)) (form.elements.namedItem(name) as HTMLInputElement).value = value;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};
const listAnd = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => vi.fn(async (url: string, init?: RequestInit) =>
  (init?.method !== 'POST' && !String(url).includes('operation=')) ? respond(200, { code: 'ACTIVE', plans, history }) : handler(String(url), init));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history = [];
  plans = [{ ...base }, { ...base, planId: '00000000-0000-4000-8000-000000000006', revisionId: '00000000-0000-4000-8000-000000000007', name: 'Cluera 20 Hours', amountPaise: 249900, allowanceSeconds: 72000, enabled: false }];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('converts what the owner types without rounding mistakes and refuses nonsense', () => {
  expect(rupeesToPaise('549')).toBe(54900); expect(rupeesToPaise('549.5')).toBe(54950); expect(rupeesToPaise('0.99')).toBeNull();
  expect(rupeesToPaise('1,499')).toBeNull(); expect(rupeesToPaise('1e3')).toBeNull(); expect(rupeesToPaise('100001')).toBeNull(); expect(rupeesToPaise('-5')).toBeNull();
  expect(hoursToSeconds('3')).toBe(10800); expect(hoursToSeconds('1.5')).toBe(5400); expect(hoursToSeconds('0.01')).toBeNull(); expect(hoursToSeconds('1001')).toBeNull();
  expect(hoursText(3600)).toBe('1 hour'); expect(hoursText(10800)).toBe('3 hours'); expect(hoursText(5400)).toBe('1.5 hours');
});

it('shows every plan with name, price in rupees, hours and a clear On / Off status, and asks for no authenticator code', async () => {
  vi.stubGlobal('fetch', listAnd(() => respond(500, {})));
  await render();
  expect(calls()).toHaveLength(0);
  await click('Refresh plans');
  const rows = Array.from(host.querySelectorAll('tbody tr'), row => Array.from(row.children, cell => cell.textContent));
  expect(rows[0].slice(0, 4)).toEqual(['Cluera 3 Hours', '₹549', '3 hours', '● On']);
  expect(rows[1].slice(0, 4)).toEqual(['Cluera 20 Hours', '₹2,499', '20 hours', '○ Off']);
  expect(host.textContent).toContain('future purchases only');
  expect(host.querySelector('input[name="code"]')).toBeNull();
  expect(host.textContent).not.toMatch(/six-digit|authenticator code/i);
  expect(calls()[0][0]).toBe('/api/account/payments/cluera/live/plans');
});

it('adds a plan only after an "Are you sure?" box, then sends exact paise and seconds with no code', async () => {
  vi.stubGlobal('fetch', listAnd((_url, init) => { if (init?.method === 'POST') { plans.push({ ...base, planId: crypto.randomUUID(), name: 'Cluera 10 Hours', amountPaise: 149900, allowanceSeconds: 36000 }); return respond(200, { code: 'APPLIED', plan: plans.at(-1) }); } return respond(500, {}); }));
  await render(); await click('Refresh plans'); await click('+ Add a plan');
  await fill({ name: 'Cluera 10 Hours', price: '1499', hours: '10', reason: 'Launch offer' });
  expect(posts()).toHaveLength(0);
  const box = host.querySelector('[role="alertdialog"]')!;
  expect(box.textContent).toContain('Are you sure?'); expect(box.textContent).toContain('₹1,499'); expect(box.textContent).toContain('10 hours');
  expect(box.textContent).toContain('recorded automatically');
  await click('Yes, make this change');
  expect(posts()).toHaveLength(1);
  expect(posts()[0]).toMatchObject({ action: 'CREATE', reason: 'Launch offer', input: { name: 'Cluera 10 Hours', amountPaise: 149900, allowanceSeconds: 36000, enabled: true } });
  expect(Object.keys(posts()[0]).sort()).toEqual(['action', 'input', 'operationId', 'reason']);
  expect(host.textContent).toContain('Done. "Cluera 10 Hours" is now ₹1,499 for 10 hours and is On');
  expect(host.textContent).toContain('Cluera 10 Hours');
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

it('shows the old and new values when editing, warns about open checkouts and sends only after confirmation', async () => {
  plans[0].openCheckouts = 2;
  vi.stubGlobal('fetch', listAnd(() => respond(200, { code: 'APPLIED', plan: { ...plans[0], amountPaise: 59900, allowanceSeconds: 14400, revisionId: crypto.randomUUID() } })));
  await render(); await click('Refresh plans');
  await act(async () => (host.querySelector('tbody tr button') as HTMLButtonElement).click());
  await fill({ name: 'Cluera 3 Hours', price: '599', hours: '4' });
  const box = host.querySelector('[role="alertdialog"]')!.textContent!;
  expect(box).toContain('₹549'); expect(box).toContain('₹599'); expect(box).toContain('3 hours'); expect(box).toContain('4 hours');
  expect(box).toContain('FUTURE purchases only'); expect(box).toContain('2 customers have an unpaid checkout open');
  expect(posts()).toHaveLength(0);
  await click('Yes, make this change');
  expect(posts()[0]).toMatchObject({ action: 'EDIT', planId, expectedRevisionId: revisionId, input: { name: 'Cluera 3 Hours', amountPaise: 59900, allowanceSeconds: 14400 } });
});

it('sends nothing when the owner goes back, and refuses unchanged or invalid values before asking', async () => {
  vi.stubGlobal('fetch', listAnd(() => respond(500, {})));
  await render(); await click('Refresh plans');
  await act(async () => (host.querySelector('tbody tr button') as HTMLButtonElement).click());
  await fill({ name: 'Cluera 3 Hours', price: '549', hours: '3' });
  expect(host.textContent).toContain('You did not change anything'); expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  await fill({ name: 'Cluera 3 Hours', price: '0.5', hours: '3' });
  expect(host.textContent).toContain('Enter the price in rupees');
  await fill({ name: 'Cluera 3 Hours', price: '600', hours: '9999' });
  expect(host.textContent).toContain('Enter the time in hours');
  await fill({ name: 'Cluera 3 Hours', price: '600', hours: '3' });
  await click('No, go back');
  expect(host.querySelector('[role="alertdialog"]')).toBeNull(); expect(posts()).toHaveLength(0);
});

it('turns a plan Off and removes it by hiding, never by deleting, each after confirmation', async () => {
  vi.stubGlobal('fetch', listAnd(() => respond(200, { code: 'APPLIED', plan: { ...plans[0], enabled: false } })));
  await render(); await click('Refresh plans');
  await click('Turn Off');
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain('Customers will no longer see');
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toMatch(/On.*Off/s);
  await click('Yes, make this change');
  expect(posts()[0]).toMatchObject({ action: 'SET_ENABLED', planId, expectedRevisionId: revisionId, input: { enabled: false } });
  await click('Remove');
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain('not deleted');
  await click('Yes, make this change');
  expect(posts()[1]).toMatchObject({ action: 'ARCHIVE', input: {} });
  expect(posts().some(body => body.action === 'DELETE')).toBe(false);
});

it('lists removed plans separately and can restore them', async () => {
  plans[1].archived = true;
  vi.stubGlobal('fetch', listAnd(() => respond(200, { code: 'APPLIED', plan: { ...plans[1], archived: false } })));
  await render(); await click('Refresh plans');
  expect(host.querySelector('tbody')!.textContent).not.toContain('Cluera 20 Hours');
  expect(host.querySelector('details summary')!.textContent).toContain('Removed plans (1)');
  await click('Restore');
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain('comes back Off');
  await click('Yes, make this change');
  expect(posts()[0]).toMatchObject({ action: 'RESTORE', planId: plans[1].planId });
});

it('shows a clear refusal in plain English and lets the owner correct it', async () => {
  vi.stubGlobal('fetch', listAnd(() => respond(409, { code: 'DUPLICATE_NAME', message: 'Another plan already has that name. Choose a different name.' })));
  await render(); await click('Refresh plans'); await click('+ Add a plan');
  await fill({ name: 'Cluera 3 Hours', price: '100', hours: '1' });
  await click('Yes, make this change');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('Another plan already has that name');
  expect(button('+ Add a plan')!.disabled).toBe(false);
  expect(button('Check what happened')).toBeUndefined();
});

it('after an unknown outcome it locks changes, never resends and checks the same operation', async () => {
  let saved = false;
  vi.stubGlobal('fetch', listAnd((url, init) => {
    if (init?.method === 'POST') throw new Error('network');
    return saved ? respond(200, { code: 'APPLIED', plan: { ...plans[0], enabled: false } }) : respond(200, { code: 'PENDING' });
  }));
  await render(); await click('Refresh plans'); await click('Turn Off'); await click('Yes, make this change');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('could not confirm');
  const original = posts()[0];
  expect(button('Turn On')?.disabled ?? button('Turn Off')!.disabled).toBe(true);
  expect(button('Remove')!.disabled).toBe(true); expect(button('+ Add a plan')!.disabled).toBe(true);
  await click('Check what happened');
  expect(calls().at(-1)![0]).toBe(`/api/account/payments/cluera/live/plans?operation=${original.operationId}`);
  expect(host.textContent).toContain('was NOT saved');
  expect(posts()).toHaveLength(1);
  // A second unknown outcome that really was saved is reported as saved.
  await click('Turn Off'); await click('Yes, make this change');
  saved = true;
  await click('Check what happened');
  expect(host.textContent).toContain('That change WAS saved');
  expect(posts()).toHaveLength(2);
});

it('lists recent changes in plain English: who, when and exactly what changed', async () => {
  history = [
    { at: '2026-10-24T10:00:00+00:00', by: 'owner@example.invalid', action: 'PLAN_EDIT', reason: 'Reason given: Better value',
      before: { name: 'Cluera 3 Hours', amountPaise: 54900, allowanceSeconds: 10800 }, after: { name: 'Cluera 3 Hours', amountPaise: 59900, allowanceSeconds: 14400 } },
    { at: '2026-10-23T10:00:00+00:00', by: 'owner@example.invalid', action: 'PLAN_CREATE', reason: 'No reason given', before: {},
      after: { name: 'Cluera 3 Hours', amountPaise: 54900, allowanceSeconds: 10800, enabled: false } },
  ];
  vi.stubGlobal('fetch', listAnd(() => respond(500, {})));
  await render(); await click('Refresh plans');
  const text = host.textContent!;
  expect(text).toContain('Recent changes (2)');
  expect(text).toContain('owner@example.invalid');
  expect(text).toContain('Edited "Cluera 3 Hours": price ₹549 to ₹599; time 3 hours to 4 hours');
  expect(text).toContain('Added "Cluera 3 Hours" (₹549, 3 hours, Off)');
  expect(text).toContain('Reason given: Better value');
  expect(describeChange({ ...(history[0] as never), action: 'PLAN_ARCHIVE' })).toContain('Removed "Cluera 3 Hours"');
  expect(describeChange({ ...(history[0] as never), action: 'PLAN_SET_ENABLED', after: { name: 'X', enabled: true } })).toContain('Turned On "X"');
});

it('disables every control while the parent is locked', async () => {
  vi.stubGlobal('fetch', listAnd(() => respond(500, {})));
  await render(true);
  expect(button('Refresh plans')!.disabled).toBe(true);
  expect(calls()).toHaveLength(0);
});
