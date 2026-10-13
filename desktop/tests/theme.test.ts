import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import type { AppSettings } from '../src/shared/types';

function luminance(hex: string): number {
  const channels = hex.replace('#', '').match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

describe('shared appearance', () => {
  it('keeps native opacity opaque and applies the saved preference only to renderer surfaces', async () => {
    const main = await fs.readFile('src/main/ipc/registerIpc.ts', 'utf8');
    const app = await fs.readFile('src/renderer/App.tsx', 'utf8');
    const css = await fs.readFile('src/renderer/styles/app.css', 'utf8');
    expect([...main.matchAll(/window\.setOpacity\(([^)]+)\)/g)].map(match => match[1])).toEqual(['1']);
    expect(app).toContain("style.setProperty('--surface-opacity', String(opacity))");
    expect(app).toContain('[overlayOpacity]');
    expect(css).toContain('background-color: var(--glass-bg)');
    expect(css).toContain('.app[hidden] { display: none; }');
    expect(css).not.toMatch(/opacity:\s*var\(--surface-opacity\)/);
  });

  it.each(['dark', 'light'])('keeps %s text and primary actions readable', async (theme) => {
    const css = await fs.readFile(path.resolve('src/renderer/styles/theme.css'), 'utf8');
    const rules = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/g)];
    const values = (body: string): Record<string, string> => Object.fromEntries(
      [...body.matchAll(/(--[\w-]+):\s*(#[a-f\d]{6});/gi)].map(match => [match[1], match[2]]),
    );
    const tokens = { ...values(rules[0][1]), ...(theme === 'light' ? values(rules[1][1]) : {}) };
    const contrast = (foreground: string, background: string): number => {
      const a = luminance(tokens[foreground]), b = luminance(tokens[background]);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    for (const background of ['--bg', '--panel']) {
      for (const foreground of ['--text', '--muted', '--faint', '--accent-text', '--info', '--danger']) {
        expect(contrast(foreground, background), `${theme} ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast('--accent-ink', '--accent')).toBeGreaterThanOrEqual(4.5);
    // Worst-case plain desktop backdrops, not just opaque palette swatches.
    for (const opacity of [1, .65, .35]) {
      for (const backdrop of [0, 255]) {
        const alpha = .65 + .35 * opacity;
        const background = '#' + tokens['--bg'].slice(1).match(/../g)!.map(channel =>
          Math.round(parseInt(channel, 16) * alpha + backdrop * (1 - alpha)).toString(16).padStart(2, '0'),
        ).join('');
        for (const foreground of ['--text', '--muted', '--faint']) {
          const a = luminance(tokens[foreground]), b = luminance(background);
          expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${theme}/${opacity}/${backdrop}/${foreground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('retains the saved theme across database reopen without altering other preferences', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sigmaround-theme-'));
    const defaults: AppSettings = { theme: 'dark', overlayOpacity: .96, privateMode: true, demoMode: false, debugMode: false, shortcuts: {} };
    let database: Database | undefined;
    try {
      database = new Database(path.join(root, 'test.sqlite'));
      await database.initialize();
      const repositories = new Repositories(database);
      expect(repositories.getSettings(defaults).theme).toBe('dark');
      const saved = { ...defaults, theme: 'light' as const, overlayOpacity: .82, debugMode: true };
      repositories.saveSettings(saved);
      database.close();
      database = undefined;
      database = new Database(path.join(root, 'test.sqlite'));
      await database.initialize();
      expect(new Repositories(database).getSettings(defaults)).toEqual(saved);
    } finally {
      database?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
