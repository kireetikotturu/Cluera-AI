export interface ShotRect { x: number; y: number; width: number; height: number }
export interface ShotSize { width: number; height: number }
export const MIN_AREA_DIP = 24;

/** Coordinates are local to one overlay, not global physical screen pixels. */
export function selectionRect(start: { x: number; y: number }, end: { x: number; y: number }, viewport: ShotSize): ShotRect {
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  const x1 = clamp(start.x, viewport.width), y1 = clamp(start.y, viewport.height);
  const x2 = clamp(end.x, viewport.width), y2 = clamp(end.y, viewport.height);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function areaPixels(rect: ShotRect, viewport: ShotSize, image: ShotSize): ShotRect {
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, image.width, image.height].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0
    || rect.x < 0 || rect.y < 0 || rect.width < MIN_AREA_DIP || rect.height < MIN_AREA_DIP
    || rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1) {
    throw new Error('Select a larger area inside one display (at least 24 × 24).');
  }
  // Use the actual thumbnail dimensions; capture APIs may return a smaller image
  // than requested. Flooring the start and ceiling the end preserves edge text.
  const x = Math.floor(rect.x * image.width / viewport.width);
  const y = Math.floor(rect.y * image.height / viewport.height);
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * image.width / viewport.width));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * image.height / viewport.height));
  if (right - x < 32 || bottom - y < 32) throw new Error('This area is too small to read. Select a larger region.');
  return { x, y, width: right - x, height: bottom - y };
}
