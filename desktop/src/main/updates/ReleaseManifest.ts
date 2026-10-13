import { createPublicKey, verify } from 'node:crypto';
import { ACCOUNT_DISTRIBUTION } from '../../shared/accountDistribution';

export interface ReleaseClaims {
  iss: 'cluera.ai';
  aud: 'cluera-ai-desktop-test-update';
  product: 'cluera-ai';
  releaseId: string;
  channel: 'cluera-beta';
  version: string;
  platform: 'win32-x64';
  downloadUrl: string;
  sha256: string;
  minimumSupportedVersion: string;
  updateType: 'OPTIONAL' | 'RECOMMENDED' | 'REQUIRED';
  fileSizeBytes?: number;
  releaseNotes: string;
  releaseNotesUrl?: string;
  iat: number;
  exp: number;
}

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RELEASE_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid update manifest encoding.');
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== value) throw new Error('Non-canonical update manifest encoding.');
  return decoded;
}

export function compareVersions(a: string, b: string): number {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Invalid release version.');
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  if ([...left, ...right].some((value) => !Number.isSafeInteger(value))) throw new Error('Invalid release version.');
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function verifyReleaseManifest(token: string, publicKeyPem: string, trustedOrigins: string[], nowSeconds = Math.floor(Date.now() / 1_000), channel: 'stable' | 'beta' | 'cluera-beta' = 'cluera-beta'): ReleaseClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part || part.length > 16_000)) throw new Error('Invalid update manifest.');
  const header = JSON.parse(decodeCanonicalBase64Url(parts[0]).toString('utf8')) as { alg?: string; typ?: string };
  if (header.alg !== 'EdDSA' || header.typ !== 'CLUERA-RELEASE') throw new Error('Unsupported update signature.');
  const payload = decodeCanonicalBase64Url(parts[1]);
  const signature = decodeCanonicalBase64Url(parts[2]);
  if (signature.length !== 64) throw new Error('Invalid Ed25519 update signature length.');
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update verification key must be Ed25519.');
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) throw new Error('Update signature is invalid.');
  const claims = JSON.parse(payload.toString('utf8')) as ReleaseClaims;
  const audience = ACCOUNT_DISTRIBUTION.audience;
  if (channel !== 'cluera-beta' || claims.iss !== 'cluera.ai' || claims.aud !== audience
    || claims.product !== ACCOUNT_DISTRIBUTION.product
    || !RELEASE_ID.test(claims.releaseId) || claims.channel !== channel || claims.platform !== 'win32-x64'
    || typeof claims.version !== 'string' || !VERSION.test(claims.version)
    || typeof claims.minimumSupportedVersion !== 'string' || !VERSION.test(claims.minimumSupportedVersion)
    || compareVersions(claims.minimumSupportedVersion, claims.version) > 0
    || !['OPTIONAL', 'RECOMMENDED', 'REQUIRED'].includes(claims.updateType)
    || !/^[a-f0-9]{64}$/.test(claims.sha256)
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || claims.iat > nowSeconds + 300 || claims.exp <= nowSeconds || claims.exp <= claims.iat
    || claims.exp - claims.iat > 31 * 86_400
    || (claims.fileSizeBytes !== undefined && (!Number.isSafeInteger(claims.fileSizeBytes) || claims.fileSizeBytes <= 0 || claims.fileSizeBytes > 512 * 1024 * 1024))
    || typeof claims.releaseNotes !== 'string' || claims.releaseNotes.length > 10_000) {
    throw new Error('Update claims are invalid or expired.');
  }
  if (typeof claims.downloadUrl !== 'string') throw new Error('Update origin is not approved.');
  const installer = new URL(claims.downloadUrl);
  if (installer.protocol !== 'https:' || installer.username || installer.password || installer.hash
    || !installer.pathname.toLowerCase().endsWith('.exe') || !trustedOrigins.includes(installer.origin)) {
    throw new Error('Update origin is not approved.');
  }
  if (claims.releaseNotesUrl && new URL(claims.releaseNotesUrl).protocol !== 'https:') throw new Error('Update notes origin is invalid.');
  return claims;
}
