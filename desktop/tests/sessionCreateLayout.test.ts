import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionEditorPage } from '../src/renderer/pages/SessionEditorPage';
import { useAppStore } from '../src/renderer/stores/appStore';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('src/renderer/styles/session-create.css');
const html = renderToStaticMarkup(createElement(SessionEditorPage, { onCollapse: () => undefined, account: true }));

describe('Create Session page', () => {
  it('is split into short, clearly named groups', () => {
    for (const heading of ['Session details', 'Your context', 'Output settings', 'Behavior']) expect(html).toContain(`>${heading}<`);
    expect(html).toContain('aria-label="Session type"');
    expect(html).toContain('Video Tutorial');
  });
  it('no longer starts with a large banner or repeats the session type', () => {
    for (const text of ['A better interview starts here', 'PREPARE YOUR WORKSPACE', 'session-type-line', 'account-session-intro']) expect(html).not.toContain(text);
  });
  it('keeps every field, upload and option', () => {
    for (const text of ['Session name', 'Company name', 'Job role / title', 'Resume / CV', 'Upload resume', 'Choose saved resume', 'Interview description / JD',
      'Supporting context', 'Upload file', 'Choose saved supporting file', 'Answer preferences', 'AI model', 'Answer language', 'Auto Answer', 'Save Transcript', 'Create Session']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('type="checkbox"');
  });
  it('keeps the bottom bar outside the scrolling area', () => {
    const content = html.slice(html.indexOf('wizard-content'), html.indexOf('wizard-actions'));
    expect(content).not.toContain('wizard-actions');
    expect(html.indexOf('wizard-actions')).toBeGreaterThan(html.indexOf('</section>'));
  });
});

describe('Create Session styles', () => {
  it('use small, even controls and one centred column', () => {
    expect(css).toContain('height: 34px');
    expect(css).toContain('width: min(660px, 100%)');
    expect(css).not.toMatch(/min-height:\s*4\d+px[^;]*;[^}]*input/);
    for (const size of ['font-size: 11px', 'font-size: 10.5px', 'font-size: 9.5px']) expect(css).toContain(size);
  });
  it('follow the app theme instead of the old forced blue palette', () => {
    expect(css).toContain('--text: unset');
    expect(css).toContain('background: var(--bg)');
    expect(css).not.toMatch(/#1[0-9a-f]{5}/i);
  });
  it('turn the two options into switches and stack to one column on narrow windows', () => {
    expect(css).toContain("input[type='checkbox']::after");
    expect(css).toContain('@media (max-width: 560px)');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
  });
  it('is loaded after the old stylesheets so it wins', () => {
    const main = read('src/renderer/main.tsx');
    expect(main.indexOf("./styles/session-create.css")).toBeGreaterThan(main.indexOf("./styles/account.css"));
    expect(main.indexOf("./styles/session-create.css")).toBeGreaterThan(main.indexOf("./styles/app.css"));
  });
  it('animates only colors and short fades', () => {
    expect(css).not.toMatch(/transition:[^;]*(width|height|top|left|margin|padding)\s/);
    expect(css).not.toContain('backdrop-filter');
    expect(css).not.toContain('animation:');
  });
});
