import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DocumentError, MAX_TEXT_CHARS, readDocumentText, tidyText, wordXmlToText } from '../lib/live/documentText';

/** A small zip file with the given entries, built the way Word builds a .docx. */
function zip(entries: Array<{ name: string; data: string; stored?: boolean }>): Uint8Array {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8'); const body = entry.stored ? raw : deflateRawSync(raw); const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.stored ? 0 : 8, 10); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    parts.push(local, name, body); central.push(header, name); offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}
const word = (paragraphs: string[]) => `<?xml version="1.0"?><w:document><w:body>${paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
const file = (bytes: Uint8Array | string, name: string, type = '') => new File([bytes as BlobPart], name, { type });

function pdf(lines: string[]): Uint8Array {
  const stream = `BT /F1 14 Tf 20 150 Td ${lines.map(line => `(${line}) Tj 0 -22 Td`).join(' ')} ET`;
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 220]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe('reading a résumé on the phone', () => {
  it('reads a Word file: paragraphs become lines and special characters come out right', async () => {
    const bytes = zip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'word/document.xml', data: word(['Ravi Kumar', 'Java &amp; Spring Boot', 'Caf&#233; &lt;3']) }]);
    const result = await readDocumentText(file(bytes, 'cv.docx'));
    expect(result.text).toBe('Ravi Kumar\nJava & Spring Boot\nCafé <3');
    expect(result.truncated).toBe(false);
  });
  it('reads a stored (uncompressed) entry too, and keeps table cells and tabs apart', async () => {
    const xml = '<w:document><w:p><w:r><w:t>Skills</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Java</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:t>A</w:t></w:p></w:tc><w:tc><w:p><w:t>B</w:t></w:p></w:tc></w:tr></w:tbl></w:document>';
    const result = await readDocumentText(file(zip([{ name: 'word/document.xml', data: xml, stored: true }]), 'cv.docx'));
    expect(result.text).toContain('Skills Java');
    expect(wordXmlToText(xml)).toContain('A\n');
  });
  it('reads text and Markdown files, and decides the kind from the bytes rather than the name', async () => {
    expect((await readDocumentText(file('Ravi Kumar\n\n\n\nJava   developer', 'cv.txt'))).text).toBe('Ravi Kumar\n\nJava developer');
    expect((await readDocumentText(file('# Notes\n- Java', 'notes.md', 'text/markdown'))).text).toContain('# Notes');
    const docx = zip([{ name: 'word/document.xml', data: word(['Hello there']) }]);
    expect((await readDocumentText(file(docx, 'resume.txt'))).text).toBe('Hello there');
  });
  it('reads a PDF', async () => {
    const worker = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href;
    const result = await readDocumentText(file(pdf(['Ravi Kumar', 'Java Spring Boot']), 'cv.pdf'), { pdfWorkerSrc: worker });
    expect(result.text.replace(/\s+/g, ' ')).toContain('Ravi Kumar');
    expect(result.text.replace(/\s+/g, ' ')).toContain('Java Spring Boot');
  }, 30_000);
  it('says plainly what it cannot read', async () => {
    const message = async (input: File) => (await readDocumentText(input).catch(error => error as Error)).message;
    expect(await message(file('', 'empty.txt'))).toContain('empty');
    expect(await message(file(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'old.doc'))).toContain('.doc');
    expect(await message(file(new Uint8Array([1, 2, 3, 4, 5, 6]), 'picture.png', 'image/png'))).toContain('Only PDF');
    expect(await message(file(zip([{ name: 'other.xml', data: '<x/>' }]), 'sheet.xlsx'))).toContain('Only Word');
    expect(await message(file('   \n  ', 'blank.txt'))).toContain('No readable text');
    expect(await message(file(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'broken.docx'))).toContain('could not be opened');
    expect(await readDocumentText(file('x', 'a.txt')).catch(error => error)).not.toBeInstanceOf(DocumentError);
  });
  it('tidies the text and never returns more than the account can keep', () => {
    expect(tidyText('a \t b\r\n\r\n\r\n\r\nc\u0000').text).toBe('a b\n\nc');
    const long = tidyText('word '.repeat(40_000));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(MAX_TEXT_CHARS);
  });
});
