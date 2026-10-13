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

/** Main-process session owner. Epoch fencing prevents late login/refresh/storage
 * completions restoring access after logout. Disk operations are serialized. */
export class AccountSessionManager {
  private view: AccountView = { mode: 'cluera-staging', state: 'signed-out' };
  private tokens?: AccountTokens;
  private expires = 0;
  private epoch = 0;
  private owner = new AbortController();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
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
    clearTimeout(this.refreshTimer); clearTimeout(this.expiryTimer);
    this.owner.abort(); this.tokens = undefined; this.expires = 0;
  }
  private current(epoch: number): void {
    if (this.closed || epoch !== this.epoch) throw new AccountApiError(401);
  }
  private async accept(tokens: AccountTokens, epoch: number, started: number, expectedUser?: string): Promise<AccountView> {
    this.current(epoch);
    if (expectedUser && tokens.userId !== expectedUser) throw new AccountApiError(401);
    // Subtract the entire round-trip, never extend token lifetime by network delay.
    const remaining = tokens.validForMilliseconds - (this.clock() - started);
    if (remaining <= 0) throw new AccountApiError(401);
    await this.enqueue(async () => { this.current(epoch); await this.store.write({ version: 1,
      userId: tokens.userId, refreshToken: tokens.refreshToken }); });
    this.current(epoch);
    this.tokens = tokens; this.expires = started + tokens.validForMilliseconds;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.invalidate(); this.publish({ mode: 'cluera-staging', state: 'unavailable', message: 'Sign in or retry to renew your session.' });
    }, Math.max(1, this.expires - this.clock()));
    this.expiryTimer.unref?.();
    const snapshot = await this.api.snapshot(tokens.accessToken);
    this.current(epoch);
    if (snapshot.account.userId !== tokens.userId || this.clock() >= this.expires) throw new AccountApiError(401);
    if (this.owner.signal.aborted) this.owner = new AbortController();
    const state = this.publish({ mode: 'cluera-staging', state: 'active', userId: tokens.userId,
      email: snapshot.account.email, availableMilliseconds: snapshot.usage.availableMilliseconds,
      reservedMilliseconds: snapshot.usage.reservedMilliseconds, spentMilliseconds: snapshot.usage.spentMilliseconds });
    clearTimeout(this.refreshTimer);
    // One expiration-based refresh, not account/usage polling. Short leases refresh halfway.
    const lifetime = this.expires - this.clock();
    this.refreshTimer = setTimeout(() => { void this.restore(); }, Math.max(1, lifetime - Math.min(60000, lifetime / 2)));
    this.refreshTimer.unref?.();
    return state;
  }
  private run(operation: (epoch: number) => Promise<AccountView>): Promise<AccountView> {
    if (this.closed) return Promise.reject(new AccountApiError(401));
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const pending = operation(epoch).catch(async (error: unknown) => {
      if (epoch !== this.epoch || this.closed) return this.status();
      this.invalidate();
      const status = error instanceof AccountApiError ? error.status : 503;
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
    });
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
    if(!this.tokens||this.clock()>=this.expires||this.view.state!=='active')throw new AccountApiError(401);
    // Reporting endpoint independently validates Auth + live session. Avoid a
    // second balance read on every UI sync; provider authorization is unchanged.
    return {accessToken:this.tokens.accessToken,signal:this.owner.signal};
  }
  rejectReportingAccess(status:401|403):void {
    ++this.epoch;this.invalidate();this.pending=undefined;
    if(status===401)void this.enqueue(()=>this.store.clear()).catch(()=>undefined);
    this.publish({mode:'cluera-staging',state:status===401?'signed-out':'suspended',message:new AccountApiError(status).message});
  }
  /** Main-only capability. Never register this return value on IPC. */
  async authorizeWork(): Promise<{ accessToken: string; signal: AbortSignal }> {
    if (this.pending) await this.pending;
    if (!this.tokens || this.clock() >= this.expires || this.view.state !== 'active') throw new AccountApiError(401);
    const epoch = this.epoch, tokens = this.tokens;
    try {
      const snapshot = await this.api.snapshot(tokens.accessToken); this.current(epoch);
      if (snapshot.account.userId !== tokens.userId || !this.tokens || this.clock() >= this.expires) throw new AccountApiError(401);
      this.publish({ ...this.view, availableMilliseconds: snapshot.usage.availableMilliseconds,
        reservedMilliseconds: snapshot.usage.reservedMilliseconds, spentMilliseconds: snapshot.usage.spentMilliseconds });
      return { accessToken: this.tokens.accessToken, signal: this.owner.signal };
    } catch (error) {
      if (epoch === this.epoch) { this.invalidate(); this.publish({ mode: 'cluera-staging',
        state: error instanceof AccountApiError && error.status === 403 ? 'suspended' : 'unavailable',
        message: 'Account verification is required before continuing.' }); }
      throw new AccountApiError(error instanceof AccountApiError ? error.status : 503);
    }
  }
  async logout(allDevices = false): Promise<AccountView> {
    const access = this.tokens?.accessToken;
    const epoch = ++this.epoch; this.invalidate(); this.pending = undefined;
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
