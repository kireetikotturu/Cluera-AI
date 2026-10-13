import { describe, expect, it } from 'vitest';
import { inferScreenContentHint } from '../src/main/screen/ScreenImageOptimizer';

describe('adaptive screenshot optimization hints', () => {
  it('preserves text-heavy developer windows', () => {
    expect(inferScreenContentHint('main.ts — Visual Studio Code')).toBe('text-dense');
    expect(inferScreenContentHint('DevTools - localhost')).toBe('text-dense');
    expect(inferScreenContentHint('Windows PowerShell')).toBe('text-dense');
  });

  it('treats unknown windows conservatively and obvious media as visual', () => {
    expect(inferScreenContentHint('Google Chrome')).toBe('uncertain');
    expect(inferScreenContentHint('YouTube - Google Chrome')).toBe('visual');
  });
});
