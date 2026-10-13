import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLibraryService } from '../src/main/app/FileLibraryService';
import { Database } from '../src/main/database/Database';
import { Repositories } from '../src/main/database/Repositories';
import type { DocumentProcessor } from '../src/main/documents/DocumentProcessor';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('local file library', () => {
  it('deduplicates content, persists across restart, tolerates missing copies, and leaves session documents intact on delete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sigmaround-library-'));
    roots.push(root);
    const databasePath = path.join(root, 'sigmaround.sqlite');
    const storagePath = path.join(root, 'files');
    const resumePath = path.join(root, 'candidate.pdf');
    const contextPath = path.join(root, 'context.txt');
    const invalidResumePath = path.join(root, 'candidate.exe');
    await fs.writeFile(resumePath, 'resume-one');
    await fs.writeFile(contextPath, 'supporting-one');
    await fs.writeFile(invalidResumePath, 'not-a-pdf');

    const processor = {
      extract: vi.fn(async (filePath: string) => {
        const bytes = await fs.readFile(filePath);
        const extension = path.extname(filePath).toLowerCase();
        return {
          text: `Extracted ${bytes.toString('utf8')}`,
          mimeType: extension === '.pdf' ? 'application/pdf' : 'text/plain',
          sizeBytes: bytes.byteLength,
        };
      }),
    } as unknown as DocumentProcessor;

    let database = new Database(databasePath);
    await database.initialize();
    let repositories = new Repositories(database);
    let library = new FileLibraryService(repositories, processor, storagePath);

    const resume = await library.upload('resume', resumePath);
    const duplicate = await library.upload('resume', resumePath);
    const supporting = await library.upload('supporting', contextPath);
    expect(duplicate.id).toBe(resume.id);
    expect(library.list()).toHaveLength(2);
    expect(library.list().map((file) => file.category).sort()).toEqual(['resume', 'supporting']);
    await expect(library.upload('resume', invalidResumePath)).rejects.toThrow('Use PDF, DOCX, TXT, or Markdown');

    const session = repositories.saveSession({
      title: 'Library safety', role: 'Engineer', company: '', interviewType: 'mixed', language: 'English',
      answerStyle: 'Natural', answerLength: 'short', jobDescription: 'Role', resumeText: resume.text,
      instructions: '', selectedModel: 'gemini-3.5-flash',
    });
    repositories.addDocument(session.id, supporting.name, 'supporting', supporting.mimeType, supporting.text, supporting.sizeBytes);

    await fs.writeFile(resumePath, 'resume-two');
    const sameNameDifferentContent = await library.upload('resume', resumePath);
    expect(sameNameDifferentContent.id).not.toBe(resume.id);
    expect(sameNameDifferentContent.name).toBe(resume.name);
    expect(library.list().filter((file) => file.category === 'resume')).toHaveLength(2);

    const storedResume = repositories.getLibraryFile(resume.id)!;
    await fs.rm(path.join(storagePath, storedResume.storageName));
    expect(library.list().find((file) => file.id === resume.id)?.available).toBe(false);
    expect(library.get(resume.id).text).toBe(resume.text);

    database.close();
    database = new Database(databasePath);
    await database.initialize();
    repositories = new Repositories(database);
    library = new FileLibraryService(repositories, processor, storagePath);
    expect(library.list()).toHaveLength(3);
    await library.delete(resume.id);
    expect(library.list().some((file) => file.id === resume.id)).toBe(false);
    expect(repositories.getDetail(session.id)?.documents.some((document) => document.name === supporting.name)).toBe(true);
    database.close();
  });
});
