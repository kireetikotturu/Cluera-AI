export type ZoomAction = 'in' | 'out' | 'reset';

export const MIN_ZOOM_FACTOR = 0.65;
export const MAX_ZOOM_FACTOR = 1.5;
export const ZOOM_STEP = 0.1;

/** Bounds are already in device-independent pixels, so do not apply DPI twice.
 * Run on workspace opening only, never during dragging/resizing or restoring. */
export function defaultWindowZoom(bounds: { width: number; height: number }): number {
  const fit = Math.min(bounds.width / 640, bounds.height / 640);
  return Math.round(Math.max(.85, Math.min(1.25, fit)) * 100) / 100;
}

export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'reset') return 1;
  const requested = current + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  return Math.round(Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, requested)) * 100) / 100;
}

export function zoomBySteps(current: number, action: Exclude<ZoomAction, 'reset'>, steps: number): number {
  let zoom = current;
  for (let step = 0; step < Math.max(0, Math.floor(steps)); step += 1) zoom = nextZoomFactor(zoom, action);
  return zoom;
}
