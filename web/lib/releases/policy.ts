import { z } from 'zod';
import { InvalidInputError } from '../http';

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const version = z.string().regex(versionPattern).refine((value) => value.split('.').every((part) => Number.isSafeInteger(Number(part))), {
  message: 'Version components must be safe integers.',
});
export const releaseInputSchema = z.object({
  channel: z.enum(['stable', 'beta']).default('stable'),
  version,
  platform: z.literal('win32-x64'),
  downloadUrl: z.url(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  minimumSupportedVersion: version,
  updateType: z.enum(['OPTIONAL', 'RECOMMENDED', 'REQUIRED']),
  fileSizeBytes: z.number().int().positive().max(512 * 1024 * 1024).optional(),
  releaseNotes: z.string().trim().max(10_000),
  releaseNotesUrl: z.union([z.url().refine((value) => {
    // URL format failures can still reach refinements. Never throw here:
    // the union must be able to accept the form's optional empty-string value.
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }, 'Release notes must use HTTPS without embedded credentials.'), z.literal('')]).optional(),
}).refine((value) => version.safeParse(value.minimumSupportedVersion).success
  && version.safeParse(value.version).success
  && compareVersions(value.minimumSupportedVersion, value.version) <= 0, {
  message: 'Minimum version cannot exceed the release version.', path: ['minimumSupportedVersion'],
});

export interface ReleaseRecord {
  id: string;
  channel: 'stable' | 'beta';
  version: string;
  platform: 'win32-x64';
  downloadUrl: string;
  sha256: string;
  minimumSupportedVersion: string;
  updateType: 'OPTIONAL' | 'RECOMMENDED' | 'REQUIRED';
  fileSizeBytes?: number;
  releaseNotes: string;
  releaseNotesUrl?: string;
  published: boolean;
  publishedAt: string;
}

export function compareVersions(a: string, b: string): number {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Invalid release version.');
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  if (partsA.length !== 3 || partsB.length !== 3 || [...partsA, ...partsB].some((part) => !Number.isSafeInteger(part) || part < 0)) throw new Error('Invalid release version.');
  for (let index = 0; index < 3; index += 1) {
    if (partsA[index] !== partsB[index]) return partsA[index] < partsB[index] ? -1 : 1;
  }
  return 0;
}

export function assertValidReleaseRecord(release: ReleaseRecord, channel: 'stable' | 'beta' = 'stable'): void {
  if (!z.uuid().safeParse(release.id).success || release.channel !== channel || release.platform !== 'win32-x64') {
    throw new Error('Unsupported release record.');
  }
  releaseInputSchema.parse(release);
  if (!/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error('Release checksum must be lowercase SHA-256.');
  assertTrustedInstallerUrl(release.downloadUrl);
}

export function trustedInstallerOrigins(): Set<string> {
  return new Set((process.env.RELEASE_DOWNLOAD_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const parsed = new URL(item);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid approved download origin.');
    return parsed.origin;
  }));
}

export function isTrustedInstallerUrl(value: string, origins = trustedInstallerOrigins()): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && !parsed.hash && parsed.pathname.toLowerCase().endsWith('.exe') && origins.has(parsed.origin);
  } catch { return false; }
}

export function assertTrustedInstallerUrl(value: string): void {
  if (!isTrustedInstallerUrl(value)) throw new InvalidInputError('Installer URL must use an approved HTTPS download origin.');
}
