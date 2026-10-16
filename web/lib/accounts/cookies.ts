import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AccountConfig } from './config';
import { AccountError } from './config';

export type CookieKind = 'access' | 'refresh' | 'flow' | 'recovery';
export function seal(value: unknown, kind: CookieKind, config: AccountConfig, ttl: number, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.cookieKey, iv);
  cipher.setAAD(Buffer.from(`${config.origin}:${config.url}:${kind}:v2`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ value, exp: now + ttl * 1000 }), 'utf8'), cipher.final()]);
  const encoded = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  if (encoded.length > 3800) throw new AccountError('UNAVAILABLE', 503);
  return encoded;
}
export function unseal(value: string | undefined, kind: CookieKind, config: AccountConfig, now = Date.now()): unknown {
  if (!value || value.length > 3800 || !/^[\w-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', config.cookieKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${config.origin}:${config.url}:${kind}:v2`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    return Number.isSafeInteger(data.exp) && data.exp > now ? data.value : null;
  } catch { return null; }
}
export class AccountCookies {
  private readonly incoming = new Map<string, string>();
  private readonly outgoing: string[] = [];
  constructor(request: Request, private readonly config: AccountConfig) {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
      const at = part.indexOf('=');
      if (at > 0) this.incoming.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  private name(kind: CookieKind) { return `${this.config.secure ? '__Host-' : ''}sr-account-${kind}`; }
  get(kind: CookieKind): unknown { return unseal(this.incoming.get(this.name(kind)), kind, this.config); }
  set(kind: CookieKind, value: unknown, ttl: number): void {
    const encoded = ttl > 0 ? seal(value, kind, this.config, ttl) : '';
    this.outgoing.push(`${this.name(kind)}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${this.config.secure ? '; Secure' : ''}`);
  }
  clear(): void { for (const kind of ['access', 'refresh', 'flow', 'recovery'] as const) this.set(kind, null, 0); }
  apply(response: Response): Response {
    for (const cookie of this.outgoing) response.headers.append('Set-Cookie', cookie);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
}
