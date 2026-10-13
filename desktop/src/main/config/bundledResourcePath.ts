import path from 'node:path';

/** Keep production trust material under the integrity-checked app.asar root. */
export function bundledResourcePath(appPath: string, fileName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error('Invalid bundled resource name.');
  }
  return path.join(appPath, 'resources', fileName);
}
