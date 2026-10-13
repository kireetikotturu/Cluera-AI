import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { LibraryFile, LibraryFileCategory, LibraryFileContent } from '../../shared/types';
import { Repositories, type StoredLibraryFile } from '../database/Repositories';
import { DocumentProcessor, readDocumentBytes } from '../documents/DocumentProcessor';

export class FileLibraryService {
  constructor(
    private readonly repositories: Repositories,
    private readonly documents: DocumentProcessor,
    private readonly storageDirectory: string,
  ) {}

  list(): LibraryFile[] {
    return this.repositories.listLibraryFiles().map((file) => this.summary(file));
  }

  get(id: string): LibraryFileContent {
    const file = this.repositories.getLibraryFile(this.safeId(id));
    if (!file) throw new Error('The saved file no longer exists.');
    return this.content(file);
  }

  async upload(category: LibraryFileCategory, filePath: string): Promise<LibraryFileContent> {
    const safeCategory = this.safeCategory(category);
    const extension = path.extname(filePath).toLowerCase();
    const bytes = await readDocumentBytes(filePath);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const existing = this.repositories.findLibraryFile(safeCategory, contentHash);
    if (existing) {
      if (!this.isAvailable(existing)) await this.copyIntoLibrary(filePath, existing.storageName);
      return this.content(existing);
    }

    const extracted = await this.documents.extract(filePath, bytes);
    if (safeCategory === 'resume' && extracted.text.length > 100_000) throw new Error('The resume is too long. Use up to 100,000 extracted characters.');
    const id = randomUUID();
    const storageName = `${id}${extension}`;
    await this.copyIntoLibrary(filePath, storageName);
    const file: StoredLibraryFile = {
      id,
      category: safeCategory,
      name: path.basename(filePath),
      mimeType: extracted.mimeType,
      text: extracted.text,
      sizeBytes: extracted.sizeBytes,
      contentHash,
      storageName,
      createdAt: new Date().toISOString(),
    };
    try {
      this.repositories.addLibraryFile(file);
    } catch (error) {
      await fsp.rm(this.storagePath(storageName), { force: true }).catch(() => undefined);
      throw error;
    }
    return this.content(file);
  }

  async delete(id: string): Promise<void> {
    const file = this.repositories.getLibraryFile(this.safeId(id));
    if (!file) return;
    await fsp.rm(this.storagePath(file.storageName), { force: true });
    this.repositories.deleteLibraryFile(file.id);
  }

  private summary(file: StoredLibraryFile): LibraryFile {
    return {
      id: file.id,
      category: file.category,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      createdAt: file.createdAt,
      available: this.isAvailable(file),
    };
  }

  private content(file: StoredLibraryFile): LibraryFileContent {
    return { ...this.summary(file), text: file.text, libraryFileId: file.id };
  }

  private isAvailable(file: StoredLibraryFile): boolean {
    return fs.existsSync(this.storagePath(file.storageName));
  }

  private storagePath(storageName: string): string {
    if (!storageName || path.basename(storageName) !== storageName) throw new Error('Invalid saved-file storage name.');
    return path.join(this.storageDirectory, storageName);
  }

  private async copyIntoLibrary(source: string, storageName: string): Promise<void> {
    await fsp.mkdir(this.storageDirectory, { recursive: true });
    const destination = this.storagePath(storageName);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fsp.copyFile(source, temporary);
    try { await fsp.rename(temporary, destination); }
    catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private safeCategory(category: LibraryFileCategory): LibraryFileCategory {
    if (category !== 'resume' && category !== 'supporting') throw new Error('Unknown saved-file category.');
    return category;
  }

  private safeId(id: string): string {
    const normalized = String(id ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalized)) throw new Error('Invalid saved-file identifier.');
    return normalized;
  }
}
