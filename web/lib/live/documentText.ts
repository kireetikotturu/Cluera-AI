/**
 * Reads the text of a résumé or notes file on the phone itself. The file is never sent anywhere: only the text that
 * comes out of it is used (and saved to the account when the customer chooses). PDF, Word (.docx), text and Markdown.
 */
export class DocumentError extends Error {}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** The account stores up to 120,000 bytes of text per document. */
export const MAX_TEXT_CHARS = 100_000;
const MAX_PDF_PAGES = 15;
const MAX_ZIP_ENTRIES = 3_000;
const MAX_XML_BYTES = 25 * 1024 * 1024;
export const PDF_WORKER_SRC = '/live/pdf.worker.min.mjs';

const readUint16 = (view: DataView, at: number): number => view.getUint16(at, true);
const readUint32 = (view: DataView, at: number): number => view.getUint32(at, true);

/** One file out of a .docx (a zip file), inflated with the browser's own decompressor. */
export async function readZipEntry(bytes: Uint8Array, wanted: string): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at -= 1) {
    if (readUint32(view, at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new DocumentError('This Word file could not be opened.');
  const entries = readUint16(view, end + 10);
  let cursor = readUint32(view, end + 16);
  if (entries > MAX_ZIP_ENTRIES) throw new DocumentError('This Word file could not be opened.');
  const decoder = new TextDecoder();
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.length || readUint32(view, cursor) !== 0x02014b50) break;
    const method = readUint16(view, cursor + 10);
    const compressed = readUint32(view, cursor + 20);
    const size = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28), extraLength = readUint16(view, cursor + 30), commentLength = readUint16(view, cursor + 32);
    const local = readUint32(view, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (size > MAX_XML_BYTES || local + 30 > bytes.length || readUint32(view, local) !== 0x04034b50) throw new DocumentError('This Word file could not be opened.');
    const start = local + 30 + readUint16(view, local + 26) + readUint16(view, local + 28);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method !== 8) throw new DocumentError('This Word file could not be opened.');
    if (typeof DecompressionStream === 'undefined') throw new DocumentError('This browser cannot open Word files. Save the résumé as PDF, or paste the text.');
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
    if (inflated.length > MAX_XML_BYTES) throw new DocumentError('This Word file is too large to read.');
    return inflated;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text of Word's document.xml: paragraphs become lines, tabs and table cells keep their gaps. */
export function wordXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\s*\/>/g, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, code: string) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? '';
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : '';
    });
}

/** Tidy text for the prompt: no repeated blank lines or spaces, never longer than the account allows. */
export function tidyText(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > MAX_TEXT_CHARS ? { text: clean.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: clean, truncated: false };
}

async function pdfText(bytes: Uint8Array, workerSrc: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  // No remote fonts: only the words are wanted.
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true, stopAtErrors: false });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= Math.min(pdf.numPages, MAX_PDF_PAGES); number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str + (item.hasEOL ? '\n' : ' ');
      }
      pages.push(line);
      page.cleanup();
    }
    return pages.join('\n\n');
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    const name = (error as { name?: string })?.name;
    throw new DocumentError(name === 'PasswordException' ? 'This PDF is password protected. Remove the password, or paste the text.' : 'This PDF could not be read. Paste the text instead.');
  } finally { void task.destroy(); }
}

export interface ReadResult { text: string; truncated: boolean }

/** The text inside a file. The kind is decided from the first bytes, not from the name. */
export async function readDocumentText(file: File, options: { pdfWorkerSrc?: string } = {}): Promise<ReadResult> {
  if (!file.size) throw new DocumentError('That file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new DocumentError('That file is larger than 15 MB. Use a smaller one, or paste the text.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  let raw: string;
  if (head.startsWith('%PDF')) raw = await pdfText(bytes, options.pdfWorkerSrc ?? PDF_WORKER_SRC);
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const xml = await readZipEntry(bytes, 'word/document.xml');
    if (!xml) throw new DocumentError('Only Word (.docx), PDF and text files can be read. Save the file as PDF or paste the text.');
    raw = wordXmlToText(new TextDecoder().decode(xml));
  } else if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new DocumentError('Old Word files (.doc) cannot be read. Save the résumé as .docx or PDF, or paste the text.');
  } else if (/\.(?:txt|md|markdown|text)$/i.test(file.name) || file.type.startsWith('text/')) {
    raw = new TextDecoder('utf-8').decode(bytes);
  } else throw new DocumentError('Only PDF, Word (.docx) and text files can be read. Paste the text instead.');
  const result = tidyText(raw);
  if (!result.text) throw new DocumentError('No readable text was found in that file. A scanned picture cannot be read; paste the text instead.');
  return result;
}
