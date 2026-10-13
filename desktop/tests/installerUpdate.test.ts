import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadInstaller, MAX_INSTALLER_BYTES } from '../src/main/updates/InstallerDownload';
import { UpdateManager } from '../src/main/updates/UpdateManager';
import { installerArguments } from '../src/main/updates/WindowsInstaller';
import { verifyReleaseManifest, type ReleaseClaims } from '../src/main/updates/ReleaseManifest';

const pair = generateKeyPairSync('ed25519');
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const bytes = Buffer.from('synthetic installer bytes - never executed');
const checksum = createHash('sha256').update(bytes).digest('hex');
const url = 'https://github.com/example/releases/download/v1.0.6-test/ClueraAITestSetup-1.0.6.exe';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'sigmaround-update-test-')); });
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
function claims(changes: Record<string, unknown> = {}): ReleaseClaims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'cluera.ai', aud: 'cluera-ai-desktop-test-update', product: 'cluera-ai', channel: 'cluera-beta',
    releaseId: '00000000-0000-4000-8000-000000000001', platform: 'win32-x64',
    version: '1.0.6', minimumSupportedVersion: '1.0.0', updateType: 'OPTIONAL',
    downloadUrl: url, sha256: checksum, fileSizeBytes: bytes.length, releaseNotes: 'Test fixes.', iat: now, exp: now + 3600, ...changes } as ReleaseClaims;
}
function token(release = claims()): string {
  const input = [ { alg: 'EdDSA', typ: 'CLUERA-RELEASE' }, release ]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
const downloadOptions = (fetcher: typeof fetch) => ({ directory, origins: ['https://github.com'],
  redirectOrigins: ['https://release-assets.githubusercontent.com'], fetcher,
  signal: new AbortController().signal, onProgress: vi.fn() });

describe('verified installer download', () => {
  it('streams approved redirects into an exclusive temporary file and verifies its bytes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302,
      headers: { Location: 'https://release-assets.githubusercontent.com/asset' } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }));
    const options = downloadOptions(fetcher);
    const artifact = await downloadInstaller(claims(), options);
    expect(await readFile(artifact.file)).toEqual(bytes);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(options.onProgress).toHaveBeenCalledWith(bytes.length, bytes.length);
    await artifact.dispose(); expect(await readdir(directory)).toEqual([]);
  });
  it.each(['http://github.com/asset.exe', 'https://evil.example/asset.exe', 'https://github.com@evil.example/a.exe',
    'https://github.com/a.exe#fragment'])('rejects an unapproved redirect %s before contacting it', async (location) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: location } }));
    await expect(downloadInstaller(claims(), downloadOptions(fetcher))).rejects.toThrow(/origin/);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(directory)).toEqual([]);
  });
  it('rejects corrupt, truncated, oversized and partial HTTP responses and removes them', async () => {
    for (const response of [new Response(Buffer.from('bad')), new Response(bytes, { status: 206 }),
      new Response(bytes, { headers: { 'Content-Length': String(MAX_INSTALLER_BYTES + 1) } }),
      new Response(bytes.subarray(0, 3), { headers: { 'Content-Length': String(bytes.length) } })]) {
      await expect(downloadInstaller(claims(), downloadOptions(vi.fn(async () => response)))).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    }
  });
  it('bounds redirect chains and supports cancellation', async () => {
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { Location: url } }));
    await expect(downloadInstaller(claims(), downloadOptions(loop))).rejects.toThrow(/redirect limit/);
    expect(loop).toHaveBeenCalledTimes(6);
    const controller = new AbortController(); controller.abort();
    await expect(downloadInstaller(claims(), { ...downloadOptions(vi.fn(async () => new Response(bytes))), signal: controller.signal })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  it('keeps the existing installation directory as the final unquoted NSIS argument', () => {
    expect(installerArguments('C:\\Users\\Test User\\Apps\\Cluera AI\\Cluera AI.exe'))
      .toEqual(['--updated', '/D=C:\\Users\\Test User\\Apps\\Cluera AI']);
    expect(() => installerArguments('C:\\bad\npath\\app.exe')).toThrow();
  });
});

function manager(fetcher: typeof fetch, channel: 'stable' | 'beta' | 'cluera-beta' = 'cluera-beta') {
  const actions: string[] = [];
  const installer = { supported: () => true, stopProviderWork: vi.fn(async () => { actions.push('stop'); }),
    verifyPublisher: vi.fn(async (_file: string) => { actions.push('publisher'); }),
    launch: vi.fn(async (_file: string) => { actions.push('launch'); }), quit: vi.fn(() => { actions.push('quit'); }) };
  const updates = new UpdateManager({ enforced: true, serverUrl: 'https://sigma.example', channel, publicKeyPem,
    trustedInstallerOrigins: ['https://github.com'], appVersion: '1.0.5', userDataPath: directory, fetcher,
    store: { read: async () => null, write: async () => undefined }, installer });
  return { updates, installer, actions };
}
describe('explicit update installation and session exclusion', () => {
  it('keeps pending session starts protected through stop and failed overlapping starts', async () => {
    const { updates } = manager(vi.fn());
    const finish = updates.beginSessionStart();
    updates.endSession();
    await expect(updates.install()).rejects.toThrow(/End the active session/);
    finish(true);
    const failedStart = updates.beginSessionStart(); failedStart(false);
    expect(updates.getStatus().sessionActive).toBe(true);
    updates.endSession(); expect(updates.getStatus().sessionActive).toBe(false);
    const failed = updates.beginSessionStart(); failed(false); failed(false);
    expect(updates.getStatus().sessionActive).toBe(false);
  });
  it('never downloads on initialize/check; explicit install revalidates approval, stops work, launches and quits', async () => {
    const release = token();
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input) === url
      ? new Response(bytes) : Response.json({ signedManifest: release, downloadUrl: 'https://evil.example/ignored.exe' }));
    const { updates, actions, installer } = manager(fetcher);
    await updates.initialize(); await updates.check();
    expect(fetcher.mock.calls.every(([input]) => String(input).endsWith('/api/cluera/update/test'))).toBe(true);
    expect(installer.launch).not.toHaveBeenCalled();
    const result = await updates.install();
    expect(result.installPhase).toBe('launching');
    expect(actions).toEqual(['stop', 'launch', 'quit']);
    expect(fetcher.mock.calls.filter(([input]) => String(input) === url)).toHaveLength(1);
  });
  it('defers both checks and installation for an active session', async () => {
    const fetcher = vi.fn(async () => Response.json({ signedManifest: token() }));
    const { updates, installer } = manager(fetcher);
    updates.beginSession();
    expect((await updates.check()).sessionActive).toBe(true);
    await expect(updates.install()).rejects.toThrow(/End the active session/);
    expect(fetcher).not.toHaveBeenCalled(); expect(installer.launch).not.toHaveBeenCalled();
    updates.endSession(); expect((await updates.check()).state).toBe('optional');
  });
  it('does not apply a required policy if a session started during the network check', async () => {
    let reply!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { reply = resolve; }));
    const { updates } = manager(fetcher);
    const checking = updates.check(); updates.beginSession();
    reply(Response.json({ signedManifest: token(claims({ updateType: 'REQUIRED' })) }));
    expect((await checking).state).not.toBe('required');
    expect(() => updates.assertSupported()).not.toThrow();
  });
  it('locks new sessions and duplicate installs synchronously', async () => {
    let reply!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { reply = resolve; }));
    const { updates, installer } = manager(fetcher);
    const installing = updates.install();
    expect(() => updates.beginSession()).toThrow(/in progress/);
    await expect(updates.install()).rejects.toThrow(/already/);
    reply(new Response(null, { status: 404 })); await installing;
    expect(installer.launch).not.toHaveBeenCalled(); expect(() => updates.beginSession()).not.toThrow();
  });
  it.each(['checksum', 'offline', 'withdrawn', 'older', 'publisher', 'launch'])('never quits or executes unverified updates: %s', async (failure) => {
    let checks = 0;
    const channel = failure === 'publisher' ? 'stable' : 'cluera-beta';
    const signed = token(claims({ ...(channel === 'stable' ? { channel, aud: 'sigmaround-desktop-update' as const } : {}),
      ...(failure === 'older' ? { version: '1.0.4' } : {}) }));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === url) return new Response(failure === 'checksum' ? Buffer.from('bad') : bytes);
      checks += 1;
      if (failure === 'offline') throw new Error('offline');
      if (failure === 'withdrawn' && checks > 1) return new Response(null, { status: 404 });
      return Response.json({ signedManifest: signed });
    });
    const { updates, installer } = manager(fetcher, channel);
    if (failure === 'publisher') installer.verifyPublisher.mockRejectedValue(new Error('unsigned'));
    if (failure === 'launch') installer.launch.mockRejectedValue(new Error('cannot launch'));
    expect((await updates.install()).installError).toBeTruthy();
    if (failure !== 'launch') expect(installer.launch).not.toHaveBeenCalled();
    expect(installer.quit).not.toHaveBeenCalled();
  });
  it('shows up to date on 404 but retains a signed required policy through a later 404', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
    const { updates } = manager(fetcher);
    expect((await updates.check()).state).toBe('current');
    fetcher.mockImplementation(async () => Response.json({ signedManifest: token(claims({ updateType: 'REQUIRED' })) }));
    expect((await updates.check()).state).toBe('required');
    fetcher.mockImplementation(async () => new Response(null, { status: 404 }));
    expect((await updates.check()).state).toBe('required');
  });
  it('rejects legacy/test cross-product manifests and signature headers', () => {
    const stable = token(claims({iss:'sigmaround.ai',product:undefined,channel:'stable',aud:'sigmaround-desktop-update'}));
    expect(() => verifyReleaseManifest(stable,publicKeyPem,['https://github.com'],Math.floor(Date.now()/1000),'cluera-beta')).toThrow();
    expect(() => verifyReleaseManifest(token(),publicKeyPem,['https://github.com'],Math.floor(Date.now()/1000),'beta')).toThrow();
  });
});
