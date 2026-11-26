import { z } from 'zod';
import type { AccountLogin, AccountView } from '../../shared/accounts';
import { AccountApi, AccountApiError, accountRefreshToken, type AccountTokens } from './AccountApi';

const savedSession = z.object({ version: z.literal(1), userId: z.string().uuid(),
  refreshToken: accountRefreshToken }).strict();
type SavedSession = z.infer<typeof savedSession>;
/** Production supplies SecureJsonStore. This interface never has a renderer implementation. */
export interface AccountSessionStore {
  read(): Promise<unknown>;
  write(value: SavedSession): Promise<void>;
  clear(): Promise<void>;
}

/** A check of the account this recent, with the same token, is used again: the relay and every server call check the
 * account themselves, and asking again before each of them slowed answers and could reach the service's rate limit. */
export const VERIFIED_FOR_MS = 60_000;
/** After a network or service problem the saved sign-in is tried again after these waits, then once a minute. */
export const RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const;
const RECONNECTING = 'Reconnecting to your account…';

/** Main-process session owner. Epoch fencing prevents late login/refresh/storage
 * completions restoring access after logout. Disk operations are serialized.
 * Only the sign-in service ends a sign-in (401, or 403 for a suspended account). A slow or missing network, a rate
 * limit or a service problem never shows the sign-in page: the account stays signed in, the saved sign-in is kept and
 * it is tried again until it works. An expired token is never used meanwhile. */
export class AccountSessionManager {
  private view: AccountView = { mode: 'cluera-staging', state: 'signed-out' };
  private tokens?: AccountTokens;
  private expires = 0;
  private epoch = 0;
  private owner = new AbortController();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private verified?: { token: string; at: number };
  private pending?: Promise<AccountView>;
  private disk: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly store: AccountSessionStore, private readonly api = new AccountApi(),
    private readonly changed: (view: AccountView) => void = () => undefined,
    private readonly clock: () => number = () => performance.now()) {}

  status(): AccountView { return { ...this.view }; }
  private publish(view: AccountView): AccountView {
    this.view = { ...view, mode: 'cluera-staging' }; this.changed(this.status()); return this.status();
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.disk.then(action); this.disk = next.catch(() => undefined); return next;
  }
  private invalidate(): void {
    clearTimeout(this.refreshTimer); clearTimeout(this.expiryTimer); clearTimeout(this.retryTimer);
    this.owner.abort(); this.tokens = undefined; this.expires = 0; this.verified = undefined;
  }
  private current(epoch: number): void {
    if (this.closed || epoch !== this.epoch) throw new AccountApiError(401);
  }
  private usable(): boolean { return Boolean(this.tokens) && this.clock() < this.expires; }
  /** The signed-in view without the "reconnecting" note. */
  private settled(): AccountView {
    const { reconnecting: _reconnecting, message: _message, ...rest } = this.view;
    return rest;
  }
  /** The access token ran out before it could be renewed: it is not used again, but the sign-in stays. */
  private expired(): void {
    this.tokens = undefined; this.expires = 0; this.verified = undefined;
    if (this.view.state !== 'active') return;
    this.publish({ ...this.view, reconnecting: true, message: RECONNECTING });
    if (!this.pending) void this.restore().catch(() => undefined);
  }
  private scheduleRetry(status: number): void {
    const wait = status === 429 ? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
      : RETRY_DELAYS_MS[Math.min(this.retries, RETRY_DELAYS_MS.length - 1)];
    this.retries += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { void this.restore().catch(() => undefined); }, wait);
    this.retryTimer.unref?.();
  }
  private async accept(tokens: AccountTokens, epoch: number, started: number, expectedUser?: string): Promise<AccountView> {
    this.current(epoch);
    if (expectedUser && tokens.userId !== expectedUser) throw new AccountApiError(401);
    // The renewed sign-in is saved first: the old saved one stops working once a new one has been issued.
    await this.enqueue(async () => { this.current(epoch); await this.store.write({ version: 1,
      userId: tokens.userId, refreshToken: tokens.refreshToken }); });
    this.current(epoch);
    // Subtract the entire round-trip, never extend token lifetime by network delay. A token that is already too old
    // (the computer slept during the request) is asked for again; it does not end the sign-in.
    if (tokens.validForMilliseconds - (this.clock() - started) <= 0) throw new AccountApiError(503);
    this.tokens = tokens; this.expires = started + tokens.validForMilliseconds; this.verified = undefined;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => { if (epoch === this.epoch) this.expired(); }, Math.max(1, this.expires - this.clock()));
    this.expiryTimer.unref?.();
    const snapshot = await this.api.snapshot(tokens.accessToken);
    this.current(epoch);
    if (snapshot.account.userId !== tokens.userId) throw new AccountApiError(401);
    if (this.clock() >= this.expires) throw new AccountApiError(503);
    this.verified = { token: tokens.accessToken, at: this.clock() };
    this.retries = 0; clearTimeout(this.retryTimer);
    if (this.owner.signal.aborted) this.owner = new AbortController();
    const state = this.publish({ mode: 'cluera-staging', state: 'active', userId: tokens.userId,
      email: snapshot.account.email, availableMilliseconds: snapshot.usage.availableMilliseconds,
      reservedMilliseconds: snapshot.usage.reservedMilliseconds, spentMilliseconds: snapshot.usage.spentMilliseconds });
    clearTimeout(this.refreshTimer);
    // One expiration-based refresh, not account/usage polling. Short leases refresh halfway.
    const lifetime = this.expires - this.clock();
    this.refreshTimer = setTimeout(() => { void this.restore().catch(() => undefined); }, Math.max(1, lifetime - Math.min(60000, lifetime / 2)));
    this.refreshTimer.unref?.();
    return state;
  }
  /** `resumable`: renewing a saved sign-in, so a network or service problem is tried again by itself. */
  private run(operation: (epoch: number) => Promise<AccountView>, resumable = false): Promise<AccountView> {
    if (this.closed) return Promise.reject(new AccountApiError(401));
    if (this.pending) return this.pending;
    clearTimeout(this.retryTimer);
    const epoch = this.epoch;
    const pending = operation(epoch).catch(async (error: unknown) => {
      if (epoch !== this.epoch || this.closed) return this.status();
      const status = error instanceof AccountApiError ? error.status : 503;
      if (status !== 401 && status !== 403) {
        if (this.view.state === 'active') {
          this.scheduleRetry(status);
          if (!this.usable()) return this.publish({ ...this.view, reconnecting: true, message: RECONNECTING });
          return this.view.reconnecting ? this.publish(this.settled()) : this.status();
        }
        if (resumable) {
          this.invalidate();
          this.scheduleRetry(status);
          return this.publish({ mode: 'cluera-staging', state: 'unavailable', reconnecting: true, message: new AccountApiError(status).message });
        }
      }
      this.invalidate();
      if (status === 401) await this.enqueue(() => this.store.clear()).catch(() => undefined);
      if (epoch !== this.epoch || this.closed) return this.status();
      return this.publish({ mode: 'cluera-staging', state: status === 401 ? 'signed-out' : status === 403 ? 'suspended' : 'unavailable',
        message: new AccountApiError(status).message });
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending; return pending;
  }
  login(input: AccountLogin): Promise<AccountView> {
    if (this.pending) return this.pending;
    // Do not silently switch account ownership while protected work is running.
    if (this.view.state === 'active') return Promise.resolve(this.status());
    this.publish({ mode: 'cluera-staging', state: 'checking' });
    return this.run(async epoch => {
      const started = this.clock(); const result = await this.api.login(input);
      return this.accept(result, epoch, started);
    });
  }
  restore(): Promise<AccountView> {
    return this.run(async epoch => {
      await this.disk; this.current(epoch);
      const raw = await this.store.read(); this.current(epoch);
      if (raw === null) { this.invalidate(); return this.publish({ mode: 'cluera-staging', state: 'signed-out' }); }
      const saved = savedSession.safeParse(raw);
      if (!saved.success) throw new AccountApiError(401);
      const started = this.clock();
      const result = await this.api.refresh(saved.data.refreshToken);
      return this.accept(result, epoch, started, saved.data.userId);
    }, true);
  }
  /** Main-only browser handoff. The callback is never supplied over IPC. */
  loginExternal(acquire:(signal:AbortSignal)=>Promise<AccountTokens>):Promise<AccountView>{
    if(this.pending)return this.pending;
    if(this.view.state==='active')return Promise.resolve(this.status());
    if(this.owner.signal.aborted)this.owner=new AbortController();
    this.publish({mode:'cluera-staging',state:'checking'});
    return this.run(async epoch=>{const started=this.clock();return this.accept(await acquire(this.owner.signal),epoch,started);});
  }
  /** Main-only capability. Never register this return value on IPC. */
  async reportingCapability():Promise<{accessToken:string;signal:AbortSignal}> {
    if(this.pending)await this.pending;
    if(this.view.state!=='active')throw new AccountApiError(401);
    // While the sign-in is being renewed this means "try again later" (503), never a sign-out.
    if(!this.usable())throw new AccountApiError(503);
    // Reporting endpoint independently validates Auth + live session. Avoid a
    // second balance read on every UI sync; provider authorization is unchanged.
    return {accessToken:this.tokens!.accessToken,signal:this.owner.signal};
  }
  rejectReportingAccess(status:401|403):void {
    if(status===401){
      // A rejected access token may only have run out: renewing it decides whether the saved sign-in still works.
      this.verified=undefined;
      if(this.view.state==='active')void this.restore().catch(()=>undefined);
      return;
    }
    ++this.epoch;this.invalidate();this.pending=undefined;
    this.publish({mode:'cluera-staging',state:'suspended',message:new AccountApiError(403).message});
  }
  /** Time left on the account, including time held for running work; undefined when it cannot be read now. */
  async remainingMilliseconds(): Promise<number | undefined> {
    try {
      if (this.pending) await this.pending;
      if (this.view.state !== 'active' || !this.usable()) return undefined;
      const snapshot = await this.api.snapshot(this.tokens!.accessToken);
      return snapshot.usage.availableMilliseconds + snapshot.usage.reservedMilliseconds;
    } catch { return undefined; }
  }
  /** Main-only capability. Never register this return value on IPC. */
  async authorizeWork(): Promise<{ accessToken: string; signal: AbortSignal }> {
    if (this.pending) await this.pending;
    if (this.view.state === 'active' && !this.usable()) await this.restore();
    if (this.view.state !== 'active') throw new AccountApiError(401);
    if (!this.usable()) throw new AccountApiError(503);
    const epoch = this.epoch, tokens = this.tokens!;
    const granted = { accessToken: tokens.accessToken, signal: this.owner.signal };
    if (this.verified?.token === tokens.accessToken && this.clock() - this.verified.at < VERIFIED_FOR_MS) return granted;
    try {
      const snapshot = await this.api.snapshot(tokens.accessToken); this.current(epoch);
      if (snapshot.account.userId !== tokens.userId) throw new AccountApiError(401);
      if (this.tokens === tokens) this.verified = { token: tokens.accessToken, at: this.clock() };
      this.publish({ ...this.settled(), availableMilliseconds: snapshot.usage.availableMilliseconds,
        reservedMilliseconds: snapshot.usage.reservedMilliseconds, spentMilliseconds: snapshot.usage.spentMilliseconds });
      return granted;
    } catch (error) {
      const status = error instanceof AccountApiError ? error.status : 503;
      if (epoch !== this.epoch) throw new AccountApiError(status);
      if (status === 403) {
        this.invalidate(); this.publish({ mode: 'cluera-staging', state: 'suspended', message: new AccountApiError(403).message });
        throw new AccountApiError(403);
      }
      if (status === 401) {
        // The token was rejected: renewing it signs out only when the saved sign-in is rejected too.
        this.verified = undefined;
        await this.restore();
        if (this.view.state === 'active' && this.usable() && this.tokens!.accessToken !== tokens.accessToken) {
          return { accessToken: this.tokens!.accessToken, signal: this.owner.signal };
        }
        throw new AccountApiError(401);
      }
      // A network problem, time-out or rate limit is no verdict on this sign-in. The current token is still used:
      // the server checks the account again on every call.
      if (this.tokens === tokens && this.usable()) return granted;
      throw new AccountApiError(status);
    }
  }
  async logout(allDevices = false): Promise<AccountView> {
    const access = this.tokens?.accessToken;
    const epoch = ++this.epoch; this.invalidate(); this.pending = undefined; this.retries = 0;
    this.publish({ mode: 'cluera-staging', state: 'signed-out' });
    let failed = allDevices && !access;
    await this.enqueue(() => this.store.clear()).catch(() => { failed = true; });
    if (access) await this.api.logout(access, allDevices).catch(() => { failed = true; });
    // Local work is stopped even if the server is offline; don't claim remote revocation.
    if (failed && epoch === this.epoch && this.view.state === 'signed-out') return this.publish({ mode: 'cluera-staging', state: 'signed-out',
      message: 'Local access stopped. Session removal could not be fully confirmed; retry when online.' });
    return this.status();
  }
  dispose(): void { this.closed = true; ++this.epoch; this.invalidate(); }
}
