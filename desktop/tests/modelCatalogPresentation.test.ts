import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../src/renderer/pages/SettingsPage';

const mocks = vi.hoisted(() => ({
  state: {
    settings: {
      theme: 'dark', overlayOpacity: 1, privateMode: true, debugMode: false,
      demoMode: false, shortcuts: {}, geminiModel: 'gemini-3.5-flash',
      deepgramModel: 'flux-general-en',
    },
    providerStatus: {
      demoMode: false, deepgramConfigured: true, geminiConfigured: true,
      databasePath: 'local database', models: [], screenAnalysisEnabled: true,
      defaultGeminiModel: 'gemini-3.5-flash', defaultDeepgramModel: 'flux-general-en',
      modelOptions: [{ provider: 'gemini', modelId: 'gemini-3.5-flash',
        displayName: 'Gemini 3.5 Flash', description: 'Enabled AI model' }],
      deepgramModelOptions: [{ provider: 'deepgram', modelId: 'flux-general-en',
        displayName: 'Flux General English', description: 'Enabled audio model' }],
    },
    setSettings: () => undefined,
  },
}));

vi.mock('../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),{getState:()=>mocks.state}),
}));

describe('activated desktop model catalog presentation', () => {
  it('shows exact enabled catalog IDs in Settings selectors without a free-text model field', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage,{account:{mode:'cluera-staging',state:'active',userId:'00000000-0000-4000-8000-000000000001',email:'synthetic@example.invalid'}}));
    expect(html).toContain('value="gemini-3.5-flash"');
    expect(html).toContain('Gemini 3.5 Flash');
    expect(html).toContain('server-approved Flux model');
    expect(html).not.toContain('API key');
    expect(html).not.toContain('value="gemini-disabled"');
    expect(html).not.toMatch(/<input[^>]+(?:name|id)="[^\"]*model/i);
  });
});
