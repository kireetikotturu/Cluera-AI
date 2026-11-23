import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  resolve: { alias: {
    'next/font/google': fileURLToPath(new URL('./tests/helpers/nextFontGoogle.ts', import.meta.url)),
    '@': fileURLToPath(new URL('./', import.meta.url)),
  } },
});
