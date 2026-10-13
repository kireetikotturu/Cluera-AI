import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ReleaseClaims } from './ReleaseManifest';

export const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

/** Only this updater's generated children; never touch customer history or credentials. */
export async function cleanupInstallerDownloads(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && /^installer-[A-Za-z0-9]{6}$/.test(entry.name)) {
      await rm(path.join(directory, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function assertDownloadOrigin(value: string, origins: string[]): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !origins.includes(url.origin)) {
    throw new Error('Installer download origin is not approved.');
  }
}

export async function verifyInstallerFile(file: string, release: ReleaseClaims): Promise<void> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += (chunk as Buffer).length;
    if (size > MAX_INSTALLER_BYTES) throw new Error('Installer exceeds the size limit.');
    hash.update(chunk as Buffer);
  }
  if (!size || (release.fileSizeBytes !== undefined && size !== release.fileSizeBytes)
    || hash.digest('hex') !== release.sha256) throw new Error('Installer SHA-256 or size verification failed.');
}

/** Streams directly to an exclusive file; never buffers the installer in memory. */
export async function downloadInstaller(release: ReleaseClaims, options: {
  directory: string;
  origins: string[];
  redirectOrigins: string[];
  fetcher?: typeof fetch;
  signal: AbortSignal;
  onProgress(bytes: number, total?: number): void;
}): Promise<{ file: string; dispose(): Promise<void> }> {
  assertDownloadOrigin(release.downloadUrl, options.origins);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(path.join(options.directory, 'installer-'));
  const file = path.join(folder, 'ClueraAITestSetup.exe');
  const dispose = (): Promise<void> => rm(folder, { recursive: true, force: true });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const deadline = setTimeout(abort, 15 * 60_000);
  let idle: ReturnType<typeof setTimeout>;
  const touch = (): void => { clearTimeout(idle); idle = setTimeout(abort, 30_000); };
  let response: Response | undefined;
  try {
    let url = release.downloadUrl;
    for (let redirects = 0; ; redirects += 1) {
      touch();
      assertDownloadOrigin(url, redirects === 0 ? options.origins : [...options.origins, ...options.redirectOrigins]);
      response = await (options.fetcher ?? fetch)(url, { redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' }, credentials: 'omit' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 5) throw new Error('Installer redirect limit exceeded.');
      url = new URL(location, url).toString();
    }
    if (!response.ok || response.status !== 200 || !response.body) throw new Error('Installer download failed.');
    const length = response.headers.get('content-length');
    const total = length === null ? undefined : Number(length);
    if (total !== undefined && (!Number.isSafeInteger(total) || total <= 0 || total > MAX_INSTALLER_BYTES
      || (release.fileSizeBytes !== undefined && release.fileSizeBytes !== total))) throw new Error('Installer size is invalid.');
    const handle = await open(file, 'wx', 0o600);
    const reader = response.body.getReader();
    let bytes = 0;
    let lastProgress = 0;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        bytes += value.byteLength;
        if (bytes > MAX_INSTALLER_BYTES || (release.fileSizeBytes !== undefined && bytes > release.fileSizeBytes)) {
          throw new Error('Installer exceeds the approved size.');
        }
        await handle.writeFile(value);
        if (Date.now() - lastProgress >= 500) { options.onProgress(bytes, release.fileSizeBytes ?? total); lastProgress = Date.now(); }
      }
      await handle.sync();
      if (total !== undefined && bytes !== total) throw new Error('Installer download is incomplete.');
      options.onProgress(bytes, release.fileSizeBytes ?? total);
    } finally { await reader.cancel().catch(() => undefined); await handle.close(); }
    await verifyInstallerFile(file, release);
    return { file, dispose };
  } catch (error) { await dispose(); throw error; }
  finally {
    clearTimeout(deadline); clearTimeout(idle!);
    options.signal.removeEventListener('abort', abort);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
