import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../src/main/providers/ModelCatalog';

const catalogFor = (models: unknown[]): ModelCatalog => new ModelCatalog('https://example.test', { gemini: 'g-1', deepgram: 'flux-general-en' },
  (async () => new Response(JSON.stringify({ models }), { status: 200 })) as unknown as typeof fetch, false, () => false, '/api/account/models');
const base = { provider: 'gemini', description: 'Google Gemini model', enabled: true };

describe('model labels from the Admin', () => {
  it('passes a label through and treats a missing one as automatic', async () => {
    const catalog = catalogFor([
      { ...base, modelId: 'g-1', displayName: 'Gemini One', isDefault: true, tag: 'Recommended' },
      { ...base, modelId: 'g-2', displayName: 'Gemini Two', tag: '-' },
      { ...base, modelId: 'g-3', displayName: 'Gemini Three' },
      { ...base, modelId: 'g-4', displayName: 'Gemini Four', tag: '' },
    ]);
    await catalog.refresh(true);
    const choices = catalog.choices('gemini');
    expect(choices.map((model) => model.tag)).toEqual(['Recommended', '-', undefined, undefined]);
  });
  it('cleans an odd label instead of rejecting the whole model list', async () => {
    const catalog = catalogFor([
      { ...base, modelId: 'g-1', displayName: 'Gemini One', isDefault: true, tag: '  <b>Best for coding and also other long text</b> ' },
      { ...base, modelId: 'g-2', displayName: 'Gemini Two', tag: 42 },
    ]);
    await catalog.refresh(true);
    const choices = catalog.choices('gemini');
    expect(choices).toHaveLength(2);
    expect(choices[0].tag).toBe('bBest for coding and als');
    expect(choices[0].tag!.length).toBeLessThanOrEqual(24);
    expect(choices[1].tag).toBeUndefined();
  });
  it('shows a label changed in Admin on a forced reload, while an ordinary read keeps the cached list', async () => {
    let tag = 'Fast';
    let calls = 0;
    const fetcher = (async () => { calls += 1; return new Response(JSON.stringify({ models: [{ ...base, modelId: 'g-1', displayName: 'Gemini One', isDefault: true, tag }] }), { status: 200 }); }) as unknown as typeof fetch;
    const catalog = new ModelCatalog('https://example.test', { gemini: 'g-1', deepgram: 'flux-general-en' }, fetcher, false, () => false, '/api/account/models');
    await catalog.refresh();
    expect(catalog.choices('gemini')[0].tag).toBe('Fast');
    tag = 'Slow';
    await catalog.refresh();                       // an answer or other ordinary read: no new request, no waiting
    expect(calls).toBe(1);
    expect(catalog.choices('gemini')[0].tag).toBe('Fast');
    await catalog.refresh(true);                   // opening or saving a session
    expect(calls).toBe(2);
    expect(catalog.choices('gemini')[0].tag).toBe('Slow');
  });
});
