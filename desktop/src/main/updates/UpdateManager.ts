import path from 'node:path';
import { ACCOUNT_DISTRIBUTION } from '../../shared/accountDistribution';
import type { UpdateStatus } from '../../shared/types';
import { SecureJsonStore } from '../security/SecureJsonStore';
import { compareVersions, verifyReleaseManifest, type ReleaseClaims } from './ReleaseManifest';
import { cleanupInstallerDownloads, downloadInstaller, verifyInstallerFile } from './InstallerDownload';

interface CachedManifest { version: 1; signedManifest: string }

export interface UpdateManagerOptions {
  enforced: boolean;
  serverUrl: string;
  publicKeyPem: string;
  trustedInstallerOrigins: string[];
  appVersion: string;
  userDataPath: string;
  store?: Pick<SecureJsonStore<CachedManifest>, 'read' | 'write'>;
  fetcher?: typeof fetch;
  channel?: 'stable' | 'beta' | 'cluera-beta';
  redirectOrigins?: string[];
  /** The Cluera TEST channel is unsigned. A pinned publisher opts into the
   * independent Authenticode gate; release hashes/signatures still apply. */
  requirePublisherVerification?: boolean;
  installer?: {
    supported(): boolean;
    stopProviderWork(): Promise<void>;
    verifyPublisher(file: string): Promise<void>;
    launch(file: string): Promise<void>;
    quit(): void;
  };
}

const unavailable: UpdateStatus = { state: 'unavailable', message: 'Update information is temporarily unavailable.' };

export class UpdateManager {
  private current: UpdateStatus = unavailable;
  private currentRelease: ReleaseClaims | null = null;
  private currentToken: string | null = null;
  private readonly store: Pick<SecureJsonStore<CachedManifest>, 'read' | 'write'>;
  private readonly fetcher: typeof fetch;
  private inFlight: Promise<UpdateStatus> | null = null;
  private sessionActive = false;
  private pendingSessionStarts = 0;
  private installPhase: NonNullable<UpdateStatus['installPhase']> = 'idle';
  private downloadedBytes = 0;
  private totalBytes: number | undefined;
  private installError: string | undefined;
  private installAbort: AbortController | null = null;

  constructor(private readonly options: UpdateManagerOptions) {
    this.store = options.store ?? new SecureJsonStore(path.join(options.userDataPath,
      options.channel === 'cluera-beta' ? 'secure-account-test-update-manifest.bin'
        : options.channel === 'beta' ? 'secure-test-update-manifest.bin' : 'secure-update-manifest.bin'));
    this.fetcher = options.fetcher ?? fetch;
  }

  async initialize(): Promise<UpdateStatus> {
    if (!this.options.enforced) {
      this.current = { state: 'current', message: 'Development build.' };
      return this.current;
    }
    await cleanupInstallerDownloads(path.join(this.options.userDataPath, 'updates'));
    try {
      const cached = await this.store.read();
      if (cached?.version === 1) this.apply(cached.signedManifest);
    } catch { /* A corrupt cached notice must never become an unsigned requirement. */ }
    return this.check();
  }

  getStatus(): UpdateStatus { return { ...this.current, installedVersion: this.options.appVersion,
    channel: this.options.channel ?? 'cluera-beta', sessionActive: this.hasSessionWork(), installPhase: this.installPhase,
    downloadedBytes: this.downloadedBytes, totalBytes: this.totalBytes, installError: this.installError }; }
  beginSession(): void {
    this.assertSupported();
    this.sessionActive = true;
  }
  endSession(): void { this.sessionActive = false; }
  beginSessionStart(): (started: boolean) => void {
    this.assertSupported();
    this.pendingSessionStarts += 1;
    let settled = false;
    return (started) => {
      if (settled) return;
      settled = true;
      this.pendingSessionStarts -= 1;
      if (started) this.sessionActive = true;
    };
  }
  private hasSessionWork(): boolean { return this.sessionActive || this.pendingSessionStarts > 0; }
  assertSupported(): void {
    if (this.installPhase !== 'idle') throw new Error('An update is in progress. Wait for it to finish before opening a session.');
    if (this.current.state === 'required') throw new Error('A Cluera security update is required to continue. Open the official download page.');
  }

  check(): Promise<UpdateStatus> {
    if (this.hasSessionWork() || this.installPhase !== 'idle') return Promise.resolve(this.getStatus());
    if (!this.options.enforced) return Promise.resolve(this.getStatus());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchAndVerify().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  cancelInstall(): void { this.installAbort?.abort(); }

  /** Called only by the explicit Update now IPC. No startup/background path installs. */
  async install(): Promise<UpdateStatus> {
    if (this.hasSessionWork()) throw new Error('End the active session before updating.');
    if (this.installPhase !== 'idle') throw new Error('An update is already in progress.');
    if (!this.options.enforced || !this.options.installer?.supported()) throw new Error('Install updates from the packaged Windows x64 app.');
    this.installPhase = 'verifying'; // Set synchronously, before any await: excludes new sessions/installs.
    this.installError = undefined;
    this.downloadedBytes = 0;
    const abort = new AbortController();
    this.installAbort = abort;
    let artifact: Awaited<ReturnType<typeof downloadInstaller>> | undefined;
    try {
      await this.inFlight;
      await this.fetchAndVerify(true);
      const release = this.currentRelease!;
      if (!release || compareVersions(this.options.appVersion, release.version) >= 0) throw new Error('No newer approved release is available.');
      abort.signal.throwIfAborted();
      this.installPhase = 'downloading';
      artifact = await downloadInstaller(release, { directory: path.join(this.options.userDataPath, 'updates'),
        origins: this.options.trustedInstallerOrigins, redirectOrigins: this.options.redirectOrigins ?? [],
        fetcher: this.fetcher, signal: abort.signal,
        onProgress: (bytes, total) => { this.downloadedBytes = bytes; this.totalBytes = total; } });
      this.installPhase = 'verifying';
      // Recheck approval after a potentially long download. Cached policy never authorizes execution.
      await this.fetchAndVerify(true);
      const latest = this.currentRelease!;
      if (latest.releaseId !== release.releaseId || latest.sha256 !== release.sha256
        || latest.downloadUrl !== release.downloadUrl || latest.version !== release.version) throw new Error('Release approval changed. Check for updates again.');
      // Current channel is unsigned TEST only; commercial publisher acceptance is separate.
      abort.signal.throwIfAborted();
      await this.options.installer.stopProviderWork();
      await verifyInstallerFile(artifact.file, release);
      if (this.options.requirePublisherVerification || this.options.channel === 'stable') {
        await this.options.installer.verifyPublisher(artifact.file);
        // Publisher verification may invoke an external OS process. Recheck the
        // approved bytes afterwards before handing the same file to Windows.
        await verifyInstallerFile(artifact.file, release);
      }
      abort.signal.throwIfAborted();
      this.installPhase = 'launching';
      this.installAbort = null;
      await this.options.installer.launch(artifact.file);
      this.options.installer.quit();
    } catch {
      await artifact?.dispose().catch(() => undefined);
      this.installPhase = 'idle';
      this.installError = abort.signal.aborted ? 'Update cancelled.'
        : 'Update could not be verified or started. Nothing was installed. Check your connection and approved release, then retry.';
    } finally { this.installAbort = null; }
    return this.getStatus();
  }

  officialDownloadPage(): string {
    const endpoint = new URL(this.options.serverUrl);
    if (endpoint.protocol !== 'https:') throw new Error('Official download page is unavailable.');
    return new URL(ACCOUNT_DISTRIBUTION.download,endpoint).toString();
  }

  private async fetchAndVerify(strict = false): Promise<UpdateStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7_000);
    try {
      const endpoint = new URL(ACCOUNT_DISTRIBUTION.feed,this.options.serverUrl);
      if (endpoint.protocol !== 'https:') throw new Error('Untrusted update endpoint.');
      const response = await this.fetcher(endpoint, { headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (this.hasSessionWork()) return this.getStatus();
      if (response.status === 404 && !strict) {
        if (this.current.state !== 'required') this.current = { state: 'current', message: "You're up to date. No newer approved release is published." };
        return this.getStatus();
      }
      if (!response.ok) throw new Error('Update service unavailable.');
      // Bound untrusted response size before JSON parsing.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing update response.');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 64_000) throw new Error('Update response too large.'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => undefined); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { signedManifest?: unknown };
      if (typeof body.signedManifest !== 'string') throw new Error('Missing signed manifest.');
      if (this.hasSessionWork()) return this.getStatus();
      const status = this.apply(body.signedManifest);
      await this.store.write({ version: 1, signedManifest: body.signedManifest });
      return status;
    } catch (error) {
      if (strict) throw error;
      if (this.current.state !== 'required') this.current = { ...this.current, state: 'unavailable', message: unavailable.message };
      return this.getStatus();
    }
    finally { clearTimeout(timer); }
  }

  private apply(token: string): UpdateStatus {
    const release: ReleaseClaims = verifyReleaseManifest(token, this.options.publicKeyPem, this.options.trustedInstallerOrigins,
      Math.floor(Date.now() / 1_000), this.options.channel ?? 'cluera-beta');
    if (this.currentRelease && (
      release.iat < this.currentRelease.iat
      || (release.iat === this.currentRelease.iat && token !== this.currentToken)
    )) throw new Error('A replayed signed update policy cannot replace the current policy.');
    const behind = compareVersions(this.options.appVersion, release.version) < 0;
    const belowMinimum = compareVersions(this.options.appVersion, release.minimumSupportedVersion) < 0;
    const state: UpdateStatus['state'] = !behind ? 'current'
      : belowMinimum || release.updateType === 'REQUIRED' ? 'required'
        : release.updateType === 'RECOMMENDED' ? 'recommended' : 'optional';
    this.current = { state, version: release.version, minimumSupportedVersion: release.minimumSupportedVersion,
      message: state === 'required' ? 'A security update is required to continue.'
        : state === 'current' ? "You're up to date." : `Version ${release.version} is available.`,
      releaseNotes: release.releaseNotes };
    this.currentRelease = release;
    this.currentToken = token;
    return this.getStatus();
  }
}
