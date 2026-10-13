import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentProcessor, MAX_DOCUMENT_BYTES, readDocumentBytes } from '../src/main/documents/DocumentProcessor';
import { FileLibraryService } from '../src/main/app/FileLibraryService';
import type { Repositories } from '../src/main/database/Repositories';

vi.mock('pdf-parse', () => ({ default: vi.fn(async () => ({ text: 'PDF resume' })) }));
vi.mock('mammoth', () => ({ default: { extractRawText: vi.fn(async () => ({ value: 'DOCX resume' })) } }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(name: string, text = 'Candidate experience') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sigmaround-formats-')); roots.push(root);
  const file = path.join(root, name); await fs.writeFile(file, text);
  const addLibraryFile = vi.fn();
  const repo = { findLibraryFile: () => undefined, addLibraryFile } as unknown as Repositories;
  return { file, root, addLibraryFile, library: new FileLibraryService(repo, new DocumentProcessor(), path.join(root, 'library')) };
}
describe('shared resume extraction', () => {
  it.each(['pdf', 'docx', 'txt', 'md', 'markdown', 'TXT'])('accepts %s resumes using the existing extraction pipeline', async ext => {
    const { file, library, addLibraryFile } = await fixture(`resume.${ext}`);
    const result = await library.upload('resume', file);
    expect(result.text).toMatch(/resume|experience/);
    expect(result.category).toBe('resume');
    expect(addLibraryFile).toHaveBeenCalledTimes(1);
    expect(result.mimeType).toBe(ext === 'pdf' ? 'application/pdf' : ext === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ['md', 'markdown'].includes(ext) ? 'text/markdown' : 'text/plain');
  });
  it('rejects unsupported, empty, oversized and overlong resumes before persistence', async () => {
    const { file, library, addLibraryFile } = await fixture('resume.txt', '');
    await expect(library.upload('resume', file)).rejects.toThrow('20 MB');
    await expect(readDocumentBytes(file + '.exe')).rejects.toThrow('Unsupported');
    const handle = await fs.open(file, 'w'); await handle.truncate(MAX_DOCUMENT_BYTES + 1); await handle.close();
    await expect(library.upload('resume', file)).rejects.toThrow('20 MB');
    await fs.writeFile(file, 'a'.repeat(100_001));
    await expect(library.upload('resume', file)).rejects.toThrow('100,000');
    expect(addLibraryFile).not.toHaveBeenCalled();
  });
});
