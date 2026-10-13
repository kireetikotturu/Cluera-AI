import { describe, expect, it } from 'vitest';
import { dashboardWindowBounds, diagonalResizeBounds, floatingLauncherBounds, sessionWindowBounds } from '../src/main/windowLayout';

describe('session window layout', () => {
  it('opens the dashboard at 45% width and 80% height at the work-area top center', () => {
    expect(dashboardWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 528,
      y: 6,
      width: 864,
      height: 832,
    });
  });

  it('uses 40% width and 70% height at the work-area top center', () => {
    expect(sessionWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 576,
      y: 6,
      width: 768,
      height: 728,
    });
  });

  it('honors an offset display work area', () => {
    expect(sessionWindowBounds({ x: 1920, y: 20, width: 1600, height: 900 })).toEqual({
      x: 2400,
      y: 26,
      width: 640,
      height: 630,
    });
  });

  it('keeps usable minimum dimensions on small logical screens', () => {
    expect(sessionWindowBounds({ x: 0, y: 0, width: 900, height: 500 })).toEqual({
      x: 240, y: 6, width: 420, height: 360,
    });
  });

  it('handles negative monitor coordinates and large work areas', () => {
    expect(sessionWindowBounds({ x: -3840, y: -20, width: 3840, height: 2080 })).toEqual({
      x: -2688, y: -14, width: 1536, height: 1456,
    });
  });

  it('uses a suitable fixed fallback when display measurements are unavailable', () => {
    expect(sessionWindowBounds({ x: 0, y: 0, width: 0, height: 0 })).toEqual({
      x: 0, y: 6, width: 1200, height: 800,
    });
  });

  it('places a collapsed launcher at the horizontal center just below the work-area top', () => {
    expect(floatingLauncherBounds({ x: 1920, y: 20, width: 1600, height: 900 })).toEqual({
      x: 2698,
      y: 26,
      width: 44,
      height: 44,
    });
  });

  it('locks dashboard handle movement to one diagonal delta and respects both limits', () => {
    const origin = { x: 480, y: 0, width: 960, height: 700 };
    expect(diagonalResizeBounds(origin, 80, 25, { width: 420, height: 360 }, { width: 1440, height: 1040 })).toEqual({
      x: 480, y: 0, width: 1040, height: 780,
    });
    expect(diagonalResizeBounds(origin, -900, -50, { width: 420, height: 360 }, { width: 1440, height: 1040 })).toEqual({
      x: 480, y: 0, width: 620, height: 360,
    });
    expect(diagonalResizeBounds(origin, 900, 40, { width: 420, height: 360 }, { width: 1440, height: 1040 })).toEqual({
      x: 480, y: 0, width: 1300, height: 1040,
    });
  });
});
