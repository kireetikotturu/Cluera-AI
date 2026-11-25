/** Makes a résumé file as small as is reasonable before it is stored, without changing what it shows. Server only.
 *
 * PDF: files already in the KB range are kept. Larger ones (usually pictures and scans) have each page redrawn as a
 * compact picture, used only when that is much smaller and the redrawn pages are not blank. Links and selectable text
 * are not needed in the stored copy: the résumé's text is saved separately.
 * DOCX (a zip file): large pictures inside are shrunk and the file is packed again with the strongest compression.
 * Anything unexpected keeps the original file, so storing a résumé never fails because of compression. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export type ResumeFileKind = 'PDF' | 'DOCX';
export type ResumeCompression = 'original' | 'pdf-pages' | 'docx-repacked';
export interface CompressedResume { bytes: Buffer; compression: ResumeCompression }

/** PDFs below this are already small: redrawing them would only lose sharpness. */
export const PDF_KEEP_BELOW = 250 * 1024;
const PDF_MAX_PAGES = 12;
/** Readable first; a second, smaller pass only for PDFs that stay large. */
const PDF_PASSES = [{ dpi: 120, quality: 62 }, { dpi: 96, quality: 50 }] as const;
const PDF_SMALL_ENOUGH = 450 * 1024;
const MAX_ENTRIES = 3_000, MAX_UNPACKED = 150 * 1024 * 1024;
const IMAGE_KEEP_BELOW = 60 * 1024, IMAGE_MAX_SIDE = 1_100;
/** Pictures with more pixels than this are never decoded: a small file can claim an enormous picture. */
const MAX_PIXELS = 40_000_000;

// ── Zip (DOCX) ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface ZipEntry { name: string; data: Buffer }

/** Reads a zip file's entries. Throws on encrypted, zip64, oversized or damaged files. */
export function readZip(bytes: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Not a zip file.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || count === 0xffff || offset === 0xffffffff) throw new Error('Unsupported zip file.');
  const entries: ZipEntry[] = [];
  let unpacked = 0;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Damaged zip file.');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const packed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    unpacked += size;
    if (flags & 1 || packed === 0xffffffff || size === 0xffffffff || unpacked > MAX_UNPACKED || (method !== 0 && method !== 8)) throw new Error('Unsupported zip file.');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Damaged zip file.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + packed);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    if (data.length !== size) throw new Error('Damaged zip file.');
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Writes a zip file with the strongest standard compression (or stored when that is smaller). */
export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const checksum = crc32(entry.data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); header.copy(record, 6, 4, 30); record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34); record.writeUInt16LE(0, 36); record.writeUInt32LE(0, 38); record.writeUInt32LE(offset, 42);
    parts.push(header, name, body);
    central.push(Buffer.concat([record, name]));
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The pixel count a PNG or JPEG header declares, or null when it cannot be read. */
export function declaredPixels(data: Buffer, format: 'jpeg' | 'png'): number | null {
  if (format === 'png') return data.length > 24 && data.readUInt32BE(12) === 0x49484452 ? data.readUInt32BE(16) * data.readUInt32BE(20) : null;
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 < data.length;) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    // Start-of-frame markers carry the height and width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return data.readUInt16BE(offset + 5) * data.readUInt16BE(offset + 7);
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
}

/** A smaller copy of one picture, or null when it cannot be made smaller. A PNG with no see-through parts (a photo or
 * a screenshot) may become a JPEG. */
async function shrinkImage(data: Buffer, format: 'jpeg' | 'png'): Promise<{ data: Buffer; format: 'jpeg' | 'png' } | null> {
  const pixels = declaredPixels(data, format);
  if (pixels === null || pixels > MAX_PIXELS) return null;
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(data);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  if (format === 'jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
  context.drawImage(image, 0, 0, width, height);
  const choices: Array<{ data: Buffer; format: 'jpeg' | 'png' }> = [];
  if (format === 'png') choices.push({ data: Buffer.from(await canvas.encode('png')), format: 'png' });
  if (format === 'jpeg' || isOpaque(context.getImageData(0, 0, width, height).data)) choices.push({ data: Buffer.from(await canvas.encode('jpeg', 72)), format: 'jpeg' });
  const best = choices.sort((a, b) => a.data.length - b.data.length)[0];
  return best && best.data.length < data.length * 0.9 ? best : null;
}
function isOpaque(pixels: Uint8ClampedArray): boolean {
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < 250) return false;
  return true;
}

/** Points the document's links at a picture that is now a JPEG. */
function renamePicture(entries: ZipEntry[], from: string, to: string): void {
  const base = from.slice(from.lastIndexOf('/') + 1), renamed = to.slice(to.lastIndexOf('/') + 1);
  const link = new RegExp(`media/${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'])`, 'g');
  for (const entry of entries) {
    if (!entry.name.endsWith('.rels') && entry.name !== '[Content_Types].xml') continue;
    let xml = entry.data.toString('utf8').replace(link, `media/${renamed}`);
    if (entry.name === '[Content_Types].xml' && !/Extension\s*=\s*["']jpg["']/i.test(xml)) xml = xml.replace(/<\/Types>\s*$/, '<Default Extension="jpg" ContentType="image/jpeg"/></Types>');
    if (entry.name === '[Content_Types].xml') xml = xml.replace(new RegExp(`(PartName=["']/word/media/${renamed.replace(/\./g, '\\.')}["']\\s+ContentType=["'])image/png`, 'g'), '$1image/jpeg');
    entry.data = Buffer.from(xml, 'utf8');
  }
}

async function compressDocx(bytes: Buffer): Promise<Buffer> {
  const entries = readZip(bytes), names = new Set(entries.map(entry => entry.name.toLowerCase()));
  const types = entries.find(entry => entry.name === '[Content_Types].xml')?.data.toString('utf8') ?? '';
  for (const entry of entries) {
    const format = /^word\/media\/[^/]+\.jpe?g$/i.test(entry.name) ? 'jpeg' : /^word\/media\/[^/]+\.png$/i.test(entry.name) ? 'png' : null;
    if (!format || entry.data.length < IMAGE_KEEP_BELOW) continue;
    try {
      const smaller = await shrinkImage(entry.data, format);
      if (!smaller) continue;
      if (smaller.format !== format) {
        const jpegName = entry.name.replace(/\.png$/i, '.jpg');
        // Renaming needs a free name and a types list that can learn the new kind.
        if (names.has(jpegName.toLowerCase()) || !/<\/Types>\s*$/.test(types)) continue;
        renamePicture(entries, entry.name, jpegName);
        names.add(jpegName.toLowerCase());
        entry.name = jpegName;
      }
      entry.data = smaller.data;
    } catch { /* the original picture stays */ }
  }
  return writeZip(entries);
}

// ── PDF ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The fonts and tables the PDF reader needs, found next to the installed package. */
function pdfAssets(): { standardFontDataUrl: string; cMapUrl: string; cMapPacked: boolean; wasmUrl: string } | null {
  const roots: string[] = [];
  try { roots.push(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))); } catch { /* try the usual places */ }
  roots.push(path.join(process.cwd(), 'node_modules', 'pdfjs-dist'), path.join(process.cwd(), 'web', 'node_modules', 'pdfjs-dist'));
  const root = roots.find(candidate => existsSync(path.join(candidate, 'standard_fonts')));
  if (!root) return null;
  const folder = (name: string) => `${path.join(root, name).split(path.sep).join('/')}/`;
  return { standardFontDataUrl: folder('standard_fonts'), cMapUrl: folder('cmaps'), cMapPacked: true, wasmUrl: folder('wasm') };
}

interface PageImage { jpeg: Buffer; widthPoints: number; heightPoints: number; width: number; height: number }

/** A PDF whose every page is one JPEG picture of the original page, at the original page size. */
export function imagePdf(pages: PageImage[]): Buffer {
  const chunks: Buffer[] = [], offsets: number[] = [];
  let length = 0;
  const add = (chunk: Buffer | string) => { const data = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk; chunks.push(data); length += data.length; };
  const object = (id: number, body: string, stream?: Buffer) => {
    offsets[id] = length;
    add(`${id} 0 obj\n${body}\n`);
    if (stream) { add('stream\n'); add(stream); add('\nendstream\n'); }
    add('endobj\n');
  };
  const number = (value: number) => String(Math.round(value * 100) / 100);
  add('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] >>`);
  pages.forEach((page, index) => {
    const id = 3 + index * 3, w = number(page.widthPoints), h = number(page.heightPoints);
    const content = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /P Do Q`, 'binary');
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /P ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${content.length} >>`, content);
    object(id + 2, `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`, page.jpeg);
  });
  const xref = length, total = 3 + pages.length * 3;
  add(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) add(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** Redraws every page; null when this PDF should keep its original file. */
async function redrawPdf(bytes: Buffer, pass: { dpi: number; quality: number }, assets: NonNullable<ReturnType<typeof pdfAssets>>): Promise<Buffer | null> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // The file is a customer's upload: no form scripts (XFA), no fonts taken from the server, no enormous pictures.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...assets, useSystemFonts: false, enableXfa: false, maxImageSize: MAX_PIXELS, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > PDF_MAX_PAGES) return null;
    const pages: PageImage[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(pass.dpi / 72, 2_400 / Math.max(size.width, size.height)) });
      const width = Math.max(1, Math.round(viewport.width)), height = Math.max(1, Math.round(viewport.height));
      const canvas = createCanvas(width, height), context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: '#ffffff' }).promise;
      // A page that comes out blank may be something that could not be drawn (a scan, a font): keep the original then.
      if (isBlank(context.getImageData(0, 0, width, height).data)) return null;
      pages.push({ jpeg: Buffer.from(await canvas.encode('jpeg', pass.quality)), widthPoints: size.width, heightPoints: size.height, width, height });
      page.cleanup();
    }
    return imagePdf(pages);
  } finally { await task.destroy(); }
}
/** True when (almost) every sampled pixel is white. */
function isBlank(pixels: Uint8ClampedArray): boolean {
  let inked = 0, sampled = 0;
  for (let index = 0; index < pixels.length; index += 4 * 7) { sampled++; if (pixels[index] < 235 || pixels[index + 1] < 235 || pixels[index + 2] < 235) inked++; }
  return inked < sampled * 0.001;
}

async function compressPdf(bytes: Buffer): Promise<Buffer | null> {
  if (bytes.length <= PDF_KEEP_BELOW) return null;
  const assets = pdfAssets();
  if (!assets) return null;
  let best: Buffer | null = null;
  for (const pass of PDF_PASSES) {
    const redrawn = await redrawPdf(bytes, pass, assets);
    if (!redrawn) return null;
    if (!best || redrawn.length < best.length) best = redrawn;
    if (best.length <= PDF_SMALL_ENOUGH) break;
  }
  // Only worth losing the original when the saving is real.
  return best && best.length <= bytes.length * 0.75 ? best : null;
}

export async function compressResume(bytes: Buffer, kind: ResumeFileKind): Promise<CompressedResume> {
  try {
    if (kind === 'PDF') {
      const smaller = await compressPdf(bytes);
      return smaller ? { bytes: smaller, compression: 'pdf-pages' } : { bytes, compression: 'original' };
    }
    const packed = await compressDocx(bytes);
    return packed.length <= bytes.length * 0.95 ? { bytes: packed, compression: 'docx-repacked' } : { bytes, compression: 'original' };
  } catch (error) {
    console.warn(JSON.stringify({ component: 'cluera-resume-compression', result: 'kept-original', kind, cause: error instanceof Error ? error.name : 'unknown' }));
    return { bytes, compression: 'original' };
  }
}

/** The received file really is what it claims to be. */
export function looksLike(bytes: Buffer, kind: ResumeFileKind): boolean {
  if (kind === 'PDF') return bytes.subarray(0, 1_024).includes('%PDF-');
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  try { return readZip(bytes).some(entry => entry.name === 'word/document.xml'); } catch { return false; }
}
