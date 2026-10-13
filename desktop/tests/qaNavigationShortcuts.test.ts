import { describe, expect, it } from 'vitest';
import { qaNavigationDelta, type QaNavigationKey } from '../src/renderer/services/qaNavigationShortcuts';

const key = (code: string, overrides: Partial<QaNavigationKey> = {}): QaNavigationKey => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  code,
  key: code === 'KeyA' ? 'a' : code === 'KeyD' ? 'd' : code,
  ...overrides,
});

describe('Q&A navigation shortcuts', () => {
  it('maps only Alt+A and Alt+D to previous and next', () => {
    expect(qaNavigationDelta(key('KeyA'), false)).toBe(-1);
    expect(qaNavigationDelta(key('KeyD'), false)).toBe(1);
    expect(qaNavigationDelta(key('ArrowLeft'), false)).toBe(0);
    expect(qaNavigationDelta(key('ArrowRight'), false)).toBe(0);
    expect(qaNavigationDelta(key('KeyA', { altKey: false }), false)).toBe(0);
    expect(qaNavigationDelta(key('', { key: 'A' }), false)).toBe(-1);
    expect(qaNavigationDelta(key('', { key: 'D' }), false)).toBe(1);
  });

  it('does not navigate while typing or with conflicting modifiers/repeats', () => {
    expect(qaNavigationDelta(key('KeyA'), true)).toBe(0);
    expect(qaNavigationDelta(key('KeyD', { ctrlKey: true }), false)).toBe(0);
    expect(qaNavigationDelta(key('KeyD', { metaKey: true }), false)).toBe(0);
    expect(qaNavigationDelta(key('KeyD', { shiftKey: true }), false)).toBe(0);
    expect(qaNavigationDelta(key('KeyD', { repeat: true }), false)).toBe(0);
  });
});
