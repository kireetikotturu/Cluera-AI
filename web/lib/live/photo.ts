/** A phone photo is far larger than the AI needs. It is reduced here so it uploads fast and is answered sooner. */
export const PHOTO_MAX_EDGE = 1_800;
export const PHOTO_MAX_BYTES = 800_000;
const PREVIEW_EDGE = 360;

export interface PreparedPhoto {
  /** Base64 JPEG without the data-URL prefix, ready for the relay. */
  data: string;
  mimeType: 'image/jpeg';
  /** A small picture for the screen. */
  preview: string;
  width: number;
  height: number;
  bytes: number;
}

export class PhotoError extends Error {}

/** The size that fits inside `edge` on the long side, never larger than the original. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const readAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new PhotoError('The photo could not be read.')));
  reader.onerror = () => reject(new PhotoError('The photo could not be read.'));
  reader.readAsDataURL(blob);
});

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release(): void }> {
  // Honours the way the phone was held, and needs no blob: address (the page does not allow them).
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch { /* fall back to an image element below */ }
  }
  const url = await readAsDataUrl(file);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new PhotoError('This photo format is not supported. Take the photo again with the camera.'));
    image.src = url;
  });
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => undefined };
}

const toBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob(blob => (blob ? resolve(blob) : reject(new PhotoError('The photo could not be prepared.'))), 'image/jpeg', quality);
});

function draw(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new PhotoError('The photo could not be prepared.');
  // JPEG has no transparency: a screenshot with a clear background would turn black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** Reduces a photo to at most 1800 px on the long side and about 800 KB, keeping small text readable. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/') && file.type !== '') throw new PhotoError('Choose a photo.');
  const decoded = await decode(file);
  try {
    if (decoded.width < 1 || decoded.height < 1) throw new PhotoError('The photo is empty.');
    let edge = PHOTO_MAX_EDGE;
    let quality = 0.82;
    let blob: Blob;
    for (let attempt = 0; ; attempt += 1) {
      const size = fitWithin(decoded.width, decoded.height, edge);
      blob = await toBlob(draw(decoded.source, size.width, size.height), quality);
      if (blob.size <= PHOTO_MAX_BYTES || attempt >= 6) break;
      // Lower the quality first, then the size: text stays sharper that way.
      if (quality > 0.6) quality -= 0.08; else edge = Math.round(edge * 0.82);
    }
    if (blob.size > 4_500_000) throw new PhotoError('The photo is too large. Take it again from a little further away.');
    const size = fitWithin(decoded.width, decoded.height, edge);
    const preview = fitWithin(decoded.width, decoded.height, PREVIEW_EDGE);
    const thumbnail = await readAsDataUrl(await toBlob(draw(decoded.source, preview.width, preview.height), 0.7));
    const dataUrl = await readAsDataUrl(blob);
    return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg', preview: thumbnail, width: size.width, height: size.height, bytes: blob.size };
  } finally { decoded.release(); }
}
