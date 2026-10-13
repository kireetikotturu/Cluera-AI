import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';

export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown'];
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Bound allocation before reading/parsing; reject directories, empty or changing files. */
export async function readDocumentBytes(filePath: string): Promise<Buffer> {
  if (!DOCUMENT_EXTENSIONS.includes(path.extname(filePath).slice(1).toLowerCase())) {
    throw new Error('Unsupported document. Use PDF, DOCX, TXT, or Markdown.');
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_DOCUMENT_BYTES) throw new Error('Choose a non-empty document up to 20 MB.');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size) throw new Error('The document changed while reading. Select it again.');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

export class DocumentProcessor {
  async extract(filePath: string, bytes?: Buffer): Promise<{ text: string; mimeType: string; sizeBytes: number }> {
    const buffer = bytes ?? await readDocumentBytes(filePath);
    if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) throw new Error('Choose a non-empty document up to 20 MB.');
    const extension = path.extname(filePath).toLowerCase();
    let text = '';
    let mimeType = 'text/plain';
    if (extension === '.pdf') {
      text = (await pdf(buffer)).text;
      mimeType = 'application/pdf';
    } else if (extension === '.docx') {
      text = (await mammoth.extractRawText({ buffer })).value;
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else if (['.txt', '.md', '.markdown'].includes(extension)) {
      text = buffer.toString('utf8');
      mimeType = extension === '.txt' ? 'text/plain' : 'text/markdown';
    } else {
      throw new Error('Unsupported document. Use PDF, DOCX, TXT, or Markdown.');
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) throw new Error('No readable text was found in this document.');
    if (normalized.length > 2_000_000) throw new Error('The document contains too much text. Use up to 2,000,000 characters.');
    return { text: normalized, mimeType, sizeBytes: buffer.byteLength };
  }
}
