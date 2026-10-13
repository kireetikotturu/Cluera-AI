import { describe, expect, it } from 'vitest';
import { areaPixels, selectionRect } from '../src/shared/shotGeometry';

describe('area capture geometry', () => {
  it('normalizes a reverse drag and clamps to the display', () => {
    expect(selectionRect({ x: 200, y: 150 }, { x: -20, y: 20 }, { width: 1920, height: 1080 }))
      .toEqual({ x: 0, y: 20, width: 200, height: 130 });
  });
  it.each([1, 1.25, 1.5, 2])('maps local DIP coordinates at scale %s', scale => {
    const crop = areaPixels({ x: 100, y: 80, width: 400, height: 300 }, { width: 1920, height: 1080 }, { width: 1920 * scale, height: 1080 * scale });
    expect(crop).toEqual({ x: 100 * scale, y: 80 * scale, width: 400 * scale, height: 300 * scale });
  });
  it('uses actual returned dimensions, preserving boundary pixels on a smaller thumbnail', () => {
    expect(areaPixels({ x: 11, y: 31, width: 500, height: 400 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }))
      .toEqual({ x: 7, y: 20, width: 334, height: 268 });
  });
  it('does not depend on a secondary monitor having positive global coordinates', () => {
    // Overlay-local x/y stay nonnegative on monitors left of/above the primary.
    expect(areaPixels({ x: 0, y: 0, width: 1280, height: 720 }, { width: 1280, height: 720 }, { width: 2560, height: 1440 }))
      .toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
  });
  it.each([
    { x: NaN, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 2, height: 100 },
    { x: -1, y: 0, width: 100, height: 100 },
    { x: 900, y: 0, width: 200, height: 100 },
  ])('rejects invalid or unreadable regions', rect => {
    expect(() => areaPixels(rect, { width: 1000, height: 800 }, { width: 1000, height: 800 })).toThrow();
  });
});
