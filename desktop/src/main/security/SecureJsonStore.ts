import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';

/** Small encrypted JSON store backed by the operating-system credential protection API. */
export class SecureJsonStore<T extends object> {
  constructor(private readonly filePath: string) {}

  async read(): Promise<T | null> {
    try {
      const encrypted = await fs.readFile(this.filePath);
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable.');
      return JSON.parse(safeStorage.decryptString(encrypted)) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable.');
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    const temporary = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, encrypted, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
