import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../src/renderer/pages/SettingsPage';
import { documentsInUse, MAX_DOCUMENTS_IN_USE, useSavedDocuments } from '../src/renderer/services/contextSelection';
import type { ContextDocument, ContextSnapshot } from '../src/shared/accountContext';

const fixture = vi.hoisted(() => ({ state: {
  settings: { theme: 'dark', overlayOpacity: .85, privateMode: false, debugMode: false, demoMode: false, shortcuts: {}, geminiModel: 'gemini-3.5-flash' },
  providerStatus: { demoMode: false, development: false, deepgramConfigured: true, geminiConfigured: true, databasePath: 'C:\\Users\\someone\\cluera-ai.sqlite', models: [],
    defaultGeminiModel: 'gemini-3.5-flash', modelOptions: [{ modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'Google Gemini model' }] },
  setError: () => undefined, setPage: () => undefined, setSettings: () => undefined, setProviderStatus: () => undefined,
} }));
vi.mock('../src/renderer/stores/appStore', () => ({ useAppStore: Object.assign((select: any) => select(fixture.state), { getState: () => fixture.state }) }));
const account = { mode: 'cluera-staging' as const, state: 'active' as const, userId: '00000000-0000-4000-8000-000000000001', email: 'synthetic@example.invalid' };
const html = renderToStaticMarkup(createElement(SettingsPage, { account }));

describe('Settings page', () => {
  it('is its own page, without the old side menu', () => {
    expect(html).toContain('settings-workspace');
    expect(html).toContain('Dashboard');
    for (const word of ['History', 'New session', 'Cloud ready', 'Local-first', 'sidebar']) expect(html).not.toContain(word);
  });
  it('shows only what a customer needs, in clear sections', () => {
    for (const heading of ['AI model', 'Résumé and documents', 'Appearance', 'Updates']) expect(html).toContain(`>${heading}<`);
    for (const text of ['Time left', 'Used', 'Buy time', 'Sign out this device', 'Sign out all devices', 'Account dashboard']) expect(html).toContain(text);
  });
  it('uploads documents with plain buttons, with no selecting', () => {
    for (const text of ['Upload résumé', 'Upload job description', 'Upload other file', 'Paste text instead']) expect(html).toContain(text);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Selected account context');
    expect(html).not.toContain('Select at most');
  });
  it('drops the technical details that only confused people', () => {
    for (const text of ['SQLite', 'Local data', 'BYOK', 'Account Edition', 'second trial', 'Managed AI models', 'Save appearance', 'cluera-ai.sqlite']) expect(html).not.toContain(text);
  });
  it('keeps the AI model choice and never offers a free-text model or a key', () => {
    expect(html).toContain('aria-label="Approved answer model"');
    expect(html).toContain('Gemini 3.5 Flash');
    expect(html).not.toContain('type="password"');
    expect(html).not.toMatch(/API key/i);
  });
  it('changes the theme and window opacity with simple controls', () => {
    expect(html).toContain('role="radiogroup"');
    for (const theme of ['Dark', 'Light', 'System']) expect(html).toContain(`${theme}</button>`);
    expect(html).toContain('type="range"');
  });
});

const doc = (id: string, updatedAt: string): ContextDocument => ({ id, kind: 'RESUME', name: id, bytes: 100, updatedAt });
const snapshot = (documents: ContextDocument[], selectedIds: string[] = [], pending = false): ContextSnapshot => ({ documents, selectedIds, pending });
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('saved documents are used for answers automatically', () => {
  it('uses the newest documents, up to the limit', () => {
    const documents = Array.from({ length: 12 }, (_, index) => doc(uuid(index), new Date(2026, 0, index + 1).toISOString()));
    const ids = documentsInUse(documents);
    expect(ids).toHaveLength(MAX_DOCUMENTS_IN_USE);
    expect(ids[0]).toBe(uuid(11));
    expect(ids).not.toContain(uuid(0));
    expect(documentsInUse([])).toEqual([]);
  });
  it('asks to select them only when the selection is not already right', async () => {
    const documents = [doc(uuid(1), '2026-01-01T00:00:00Z'), doc(uuid(2), '2026-02-01T00:00:00Z')];
    const select = vi.fn(async (ids: string[]) => snapshot(documents, ids));
    const first = await useSavedDocuments(snapshot(documents), select);
    expect(select).toHaveBeenCalledWith([uuid(2), uuid(1)]);
    expect(first.selectedIds).toEqual([uuid(2), uuid(1)]);
    select.mockClear();
    await useSavedDocuments(snapshot(documents, [uuid(1), uuid(2)]), select);
    expect(select).not.toHaveBeenCalled();
  });
  it('leaves a pending change alone and never fails the page', async () => {
    const documents = [doc(uuid(1), '2026-01-01T00:00:00Z')];
    const select = vi.fn(async () => { throw new Error('offline'); });
    expect((await useSavedDocuments(snapshot(documents, [], true), select as never)).pending).toBe(true);
    expect(select).not.toHaveBeenCalled();
    const unchanged = snapshot(documents);
    expect(await useSavedDocuments(unchanged, select as never)).toBe(unchanged);
  });
});
