import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('locks the reviewed security patches and their runtime/compiler platform packages', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  expect(manifest.dependencies.next).toBe('16.4.2');
  expect(lock.packages[''].dependencies.next).toBe(manifest.dependencies.next);
  expect(manifest.overrides).toEqual({ sharp: '0.35.5', 'source-map-js': '1.2.2', '@vercel/cli-config': { zod: '$zod' } });
  expect(manifest.dependencies.zod).toBe('4.6.6');
  expect(lock.packages[''].dependencies.zod).toBe(manifest.dependencies.zod);
  expect(lock.packages['node_modules/zod'].version).toBe('4.6.6');
  expect(lock.packages['node_modules/@vercel/cli-config/node_modules/zod'].version).toBe('4.6.6');
  expect(lock.packages['node_modules/next'].version).toBe('16.4.2');
  expect(lock.packages['node_modules/sharp'].version).toBe('0.35.5');
  expect(lock.packages['node_modules/source-map-js'].version).toBe('1.2.2');
  for (const [name, value] of Object.entries(lock.packages) as [string, { version: string }][]) {
    if (/^node_modules\/@next\/(?:env|swc-)/.test(name)) expect(value.version).toBe('16.4.2');
    if (/^node_modules\/@img\/sharp-(?!libvips-)/.test(name)) expect(value.version).toBe('0.35.5');
  }
});
