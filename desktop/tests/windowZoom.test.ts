import { describe, expect, it } from 'vitest';
import { defaultWindowZoom, MAX_ZOOM_FACTOR, MIN_ZOOM_FACTOR, nextZoomFactor, zoomBySteps } from '../src/main/windowZoom';

describe('window zoom controls', () => {
  it('chooses a bounded default from the logical opening size', () => {
    expect(defaultWindowZoom({ width: 420, height: 360 })).toBe(.85);
    expect(defaultWindowZoom({ width: 640, height: 640 })).toBe(1);
    expect(defaultWindowZoom({ width: 768, height: 728 })).toBe(1.14);
    expect(defaultWindowZoom({ width: 1536, height: 1456 })).toBe(1.25);
    expect(defaultWindowZoom({ width: 1000, height: 500 })).toBe(.85);
  });
  it('changes zoom in fixed steps and stays within readable bounds', () => {
    expect(nextZoomFactor(1, 'in')).toBe(1.1);
    expect(nextZoomFactor(1, 'out')).toBe(0.9);
    expect(nextZoomFactor(1.4, 'reset')).toBe(1);
    expect(nextZoomFactor(MAX_ZOOM_FACTOR, 'in')).toBe(MAX_ZOOM_FACTOR);
    expect(nextZoomFactor(MIN_ZOOM_FACTOR, 'out')).toBe(MIN_ZOOM_FACTOR);
    expect(zoomBySteps(.85, 'in', 5)).toBe(1.35);
    expect(zoomBySteps(1.2, 'in', 5)).toBe(MAX_ZOOM_FACTOR);
  });
});
