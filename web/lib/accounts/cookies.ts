import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AccountConfig } from './config';
import { AccountError } from './config';

export type CookieKind = 'access' | 'refresh' | 'flow' | 'recovery' | 'session' | 'recovery-lock';
export function seal(value: unknown, kind: CookieKind, config: AccountConfig, ttl: number, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.cookieKey, iv);
  cipher.setAAD(Buffer.from(`${config.origin}:${config.url}:${kind}:v2`));
  const payload={value,exp:now+ttl*1000,padding:''};
  if(kind==='flow'){
    // Eligible and obscured email outcomes must not differ by cookie length.
    // One current SDK verifier ring fits comfortably; keep the existing 3800 cap.
    const bytes=Buffer.byteLength(JSON.stringify(payload));
    if(bytes>2560)throw new AccountError('UNAVAILABLE',503);
    payload.padding='0'.repeat(2560-bytes);
  }
  const plaintext=kind==='flow'?JSON.stringify(payload):JSON.stringify({value,exp:payload.exp});
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const encoded = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  if (encoded.length > 3800) throw new AccountError('UNAVAILABLE', 503);
  return encoded;
}
function openEnvelope(value: string | undefined, kind: CookieKind, config: AccountConfig, now = Date.now()): {value:unknown;exp:number}|null {
  if (!value || value.length > 3800 || !/^[\w-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', config.cookieKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${config.origin}:${config.url}:${kind}:v2`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    return Number.isSafeInteger(data.exp) && data.exp > now ? {value:data.value,exp:data.exp} : null;
  } catch { return null; }
}
export function unseal(value: string | undefined, kind: CookieKind, config: AccountConfig, now = Date.now()): unknown {
  return openEnvelope(value,kind,config,now)?.value??null;
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
  get(kind: CookieKind): unknown {
    if(kind==='recovery')return this.recoveryState()?.sessionId??null;
    return unseal(this.incoming.get(this.name(kind)), kind, this.config);
  }
  recoveryState():{sessionId:string;resetUntil:number}|null{
    const lock=unseal(this.incoming.get(this.name('recovery-lock')),'recovery-lock',this.config);
    if(lock&&typeof lock==='object'&&!Array.isArray(lock)&&Object.keys(lock).length===2
      &&'sessionId'in lock&&typeof lock.sessionId==='string'&&/^[a-f0-9-]{36}$/.test(lock.sessionId)
      &&'resetUntil'in lock&&typeof lock.resetUntil==='number'&&Number.isSafeInteger(lock.resetUntil))return {sessionId:lock.sessionId,resetUntil:lock.resetUntil};
    const legacy=openEnvelope(this.incoming.get(this.name('recovery')),'recovery',this.config);
    return legacy&&typeof legacy.value==='string'?{sessionId:legacy.value,resetUntil:legacy.exp}:null;
  }
  recoveryResetAllowed(sessionId:string):boolean{
    const state=this.recoveryState();return state?.sessionId===sessionId&&state.resetUntil>Date.now();
  }
  private queue(kind:CookieKind,encoded:string,ttl:number){
    this.outgoing.push(`${this.name(kind)}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${this.config.secure ? '; Secure' : ''}`);
  }
  set(kind: CookieKind, value: unknown, ttl: number): void {
    const encoded = ttl > 0 ? seal(value, kind, this.config, ttl) : '';
    this.queue(kind,encoded,ttl);
  }
  retainPendingFlow():void {
    const prior=openEnvelope(this.incoming.get(this.name('flow')),'flow',this.config);
    // Re-encrypt to normalize headers without extending the signed deadline of
    // a previously pending flow. Empty state cannot authorize an exchange.
    const encoded=prior?seal(prior.value,'flow',this.config,0,prior.exp):seal({},'flow',this.config,3600);
    this.queue('flow',encoded,3600);
  }
  clearSession(): void {
    // A failed session read/login does not invalidate a separate pending email
    // attempt. Keep its sealed PKCE verifier and original deadline intact.
    for (const kind of ['access', 'refresh', 'recovery', 'session', 'recovery-lock'] as const) this.set(kind, null, 0);
  }
  clear(): void { this.clearSession(); this.set('flow', null, 0); }
  apply(response: Response): Response {
    for (const cookie of this.outgoing) response.headers.append('Set-Cookie', cookie);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
}
