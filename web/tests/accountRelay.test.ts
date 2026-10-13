import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayConfig, STAGING_DATABASE, STAGING_SITE } from '../lib/accountRelay/config';
import { commandFrame, GEMINI_MODEL, DEEPGRAM_MODEL, secretFilter } from '../lib/accountRelay/protocol';
import { providerAdapters, type Providers } from '../lib/accountRelay/providers';
import { attachRelaySession } from '../lib/accountRelay/session';
import { createRelayServer } from '../lib/accountRelay/server';
import { createUsageCoordinator } from '../lib/usage/coordinator';

const secrets = { geminiKey: 'synthetic-gemini-secret-only', deepgramKey: 'synthetic-deepgram-secret-only',
  serviceKey: 'synthetic-service-secret-only', rateKey: Buffer.alloc(32, 7).toString('base64') };
const environment = () => ({ SIGMAROUND_ACCOUNTS_ENABLED: 'true', SIGMAROUND_ACCOUNT_RELAY_ENABLED: 'true',
  SIGMAROUND_ACCOUNT_ORIGIN: STAGING_SITE, NEXT_PUBLIC_SUPABASE_URL: STAGING_DATABASE,
  SUPABASE_SERVICE_ROLE_KEY: secrets.serviceKey, SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: secrets.rateKey,
  SIGMAROUND_MANAGED_GEMINI_API_KEY: secrets.geminiKey, SIGMAROUND_MANAGED_DEEPGRAM_API_KEY: secrets.deepgramKey });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
it('rejects provider bootstrap unavailability before any usage START or upstream operation',async()=>{
 const prepare=vi.fn(async()=>{throw Error('Provider unavailable.');});
 const h=harness({prepare});await h.login();h.peer.input({type:'generate',id:'bootstrap-check',prompt:'synthetic'});await tick();
 expect(prepare).toHaveBeenCalledOnce();expect(h.command).not.toHaveBeenCalled();expect(h.providers.generate).not.toHaveBeenCalled();expect(h.peer.readyState).toBe(WebSocket.CLOSED);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
class Peer extends EventEmitter {
  readyState = WebSocket.OPEN as number; bufferedAmount = 0; sent: any[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.close(); }
  ping() { this.emit('pong'); }
  input(value: object) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
type Command = Parameters<Parameters<typeof createUsageCoordinator>[0]>[0];
function harness(overrides: Partial<Providers> = {}, duration = 30000) {
  vi.useFakeTimers();
  const peer = new Peer();
  const command = vi.fn(async (input: Command) => input.action === 'STOP' ? { code: 'CLOSED' as const } :
    { code: 'ACTIVE' as const, ...input, serverTime: '2026-10-04T00:00:00Z', expiresAt: '2026-10-04T00:00:30Z',
      reservedMilliseconds: duration, allocation: 'TRIAL' as const, validForMilliseconds: duration });
  const audio = { write: vi.fn(), forceEndTurn: vi.fn(), close: vi.fn() };
  const providers: Providers = { generate: vi.fn(async (_input, guard, emit) => { guard.assertActive(); emit('hello'); }),
    audio: vi.fn(() => audio), ...overrides };
  const authorize = vi.fn(async () => ({ remainingTokenMs: 3600000, createRun: () => createUsageCoordinator(command) }));
  const session = attachRelaySession(peer as unknown as WebSocket, { authorize, providers });
  return { peer, command, providers, audio, session, authorize, async login() {
    peer.input({ type: 'authenticate', accessToken: 'synthetic-account-access-token' }); await tick();
  } };
}

describe('staging account relay boundaries', () => {
  it('does not announce audio readiness until the upstream callback, or after cancellation', async () => {
    let ready!: () => void;
    const audio = { write: vi.fn(), forceEndTurn: vi.fn(), close: vi.fn() };
    const h = harness({ audio: (_guard, _emit, _failed, opened) => { ready = opened!; return audio; } });
    await h.login(); h.peer.input({ type: 'openAudio', channel: 'interviewer' }); await tick();
    expect(h.peer.sent.filter(message => message.type === 'audioReady')).toHaveLength(0);
    ready(); expect(h.peer.sent.filter(message => message.type === 'audioReady')).toEqual([
      { type: 'audioReady', channel: 'interviewer' },
    ]);
    h.session.stop(); ready();
    expect(h.peer.sent.filter(message => message.type === 'audioReady')).toHaveLength(1);
    expect(audio.close).toHaveBeenCalledOnce();
  });
  it('never announces audio readiness when the upstream rejects its handshake', async () => {
    let failed!: () => void, ready!: () => void;
    const audio = { write: vi.fn(), forceEndTurn: vi.fn(), close: vi.fn() };
    const h = harness({ audio: (_guard, _emit, rejected, opened) => { failed = rejected; ready = opened!; return audio; } });
    await h.login(); h.peer.input({ type: 'openAudio', channel: 'candidate' }); await tick();
    failed(); ready();
    expect(h.peer.sent.some(message => message.type === 'audioReady')).toBe(false);
    expect(audio.close).toHaveBeenCalledOnce(); expect(h.peer.readyState).toBe(WebSocket.CLOSED);
  });
  it('closes even if the diagnostic sink throws, without weakening the auth deadline', async () => {
    vi.useFakeTimers(); const peer = new Peer();
    const authorize = vi.fn(); const audio = vi.fn(); const generate = vi.fn();
    const close = vi.spyOn(peer, 'close');
    attachRelaySession(peer as unknown as WebSocket, { authorize, providers: { audio, generate },
      observe() { throw Error('synthetic logging failure'); } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(close).toHaveBeenCalledWith(1008, 'Account session ended.');
    expect(peer.readyState).toBe(WebSocket.CLOSED);
    expect(authorize).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
  it('forces a non-responsive closing peer down at the original one-second deadline', async () => {
    vi.useFakeTimers(); const peer = new Peer();
    peer.close = vi.fn(() => { peer.readyState = WebSocket.CLOSING; });
    peer.terminate = vi.fn(() => { peer.readyState = WebSocket.CLOSED; peer.emit('close'); });
    const observe = vi.fn();
    attachRelaySession(peer as unknown as WebSocket, { authorize: vi.fn(),
      providers: { audio: vi.fn(), generate: vi.fn() }, observe });
    await vi.advanceTimersByTimeAsync(10000);
    expect(peer.close).toHaveBeenCalledWith(1008, 'Account session ended.');
    expect(peer.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.terminate).toHaveBeenCalledOnce();
    expect(observe.mock.calls.map(([event]) => event)).toEqual([
      'authorization_failed', 'close_requested', 'close_deadline_reached', 'socket_closed',
    ]);
  });
  it.each(['success', 'error', 'throw', 'stalled', 'backpressure'])('terminal write %s cannot delay or bypass policy closure', async mode => {
    vi.useFakeTimers(); const peer = new Peer(), observe = vi.fn();
    const authorize = vi.fn(), generate = vi.fn(), audio = vi.fn();
    const send = vi.fn((value: string, done?: (error?: Error) => void) => {
      peer.sent.push(JSON.parse(value));
      if (mode === 'throw') throw Error('private diagnostic must not escape');
      if (mode !== 'stalled') done?.(mode === 'error' ? Error('private error') : undefined);
    });
    peer.send = send;
    if (mode === 'backpressure') peer.bufferedAmount = 256001;
    peer.close = vi.fn(() => { peer.readyState = WebSocket.CLOSING; });
    peer.terminate = vi.fn(() => { peer.readyState = WebSocket.CLOSED; peer.emit('close'); });
    attachRelaySession(peer as unknown as WebSocket, { authorize, providers: { generate, audio }, observe });
    peer.input({ type: 'generate', id: 'unauthorized', prompt: 'must-not-run' }); await tick();
    expect(peer.sent).toEqual(mode === 'backpressure' ? [] : [{ type: 'sessionEnded' }]);
    expect(peer.close).toHaveBeenCalledWith(1008, 'Account session ended.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(peer.terminate).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled();
    expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
  });
  it('is explicitly disabled and rejects production/old staging targets', () => {
    expect(() => relayConfig({})).toThrow('configuration unavailable');
    expect(relayConfig(environment()).database).toBe(STAGING_DATABASE);
    expect(() => relayConfig({ ...environment(), SIGMAROUND_ACCOUNT_RELAY_ENABLED: 'false' })).toThrow();
    for (const target of ['https://bzccuqforilpifhiysjk.supabase.co', 'https://yyeouqokiwivdacjuzdq.supabase.co']) {
      expect(() => relayConfig({ ...environment(), NEXT_PUBLIC_SUPABASE_URL: target })).toThrow();
    }
    expect(() => relayConfig({ ...environment(), SIGMAROUND_MANAGED_GEMINI_API_KEY: '' })).toThrow();
    expect(GEMINI_MODEL).toBe('gemini-3.5-flash'); expect(DEEPGRAM_MODEL).toBe('flux-general-en');
  });
  it('rejects client identity, provider URL/model/key, counters and malformed image data', () => {
    const valid = { type: 'generate', id: 'q1', prompt: 'hello' };
    for (const field of ['userId', 'runId', 'sequence', 'minutes', 'url', 'apiKey', 'model']) {
      expect(commandFrame.safeParse({ ...valid, [field]: 'untrusted' }).success).toBe(false);
    }
    expect(commandFrame.safeParse({ ...valid, image: { mimeType: 'image/png', data: 'aGVsbG8=' } }).success).toBe(false);
  });
  it('redacts secrets split across SSE chunks without delaying normal answer text', () => {
    const filter = secretFilter([secrets.geminiKey]);
    expect(filter.push('An ordinary answer.')).toBe('An ordinary answer.');
    expect(filter.push('prefix synthetic-gem')).toBe('prefix ');
    expect(filter.push('ini-secret-')).toBe('');
    expect(filter.push('only suffix.')).toBe('[REDACTED] suffix.');
    expect(filter.push('', true)).toBe('');
  });
  it('authenticates without charging; shares one run for both audio channels and Gemini', async () => {
    const h = harness(); await h.login(); expect(h.command).not.toHaveBeenCalled();
    h.peer.input({ type: 'openAudio', channel: 'interviewer' });
    h.peer.input({ type: 'openAudio', channel: 'candidate' });
    h.peer.input({ type: 'generate', id: 'q1', prompt: 'hello' }); await tick();
    expect(h.command.mock.calls.map(([c]) => c.action)).toEqual(['START']);
    expect(h.providers.audio).toHaveBeenCalledTimes(2); expect(h.providers.generate).toHaveBeenCalledOnce();
    h.peer.emit('message', Buffer.from([0, 1, 2]), true); expect(h.audio.write).toHaveBeenCalledWith(Buffer.from([1, 2]));
    h.session.stop(); await tick(); expect(h.command.mock.calls.map(([c]) => c.action)).toEqual(['START', 'STOP']);
  });
  it('denies unauthenticated frames and duplicate authentication without upstream work', async () => {
    const h = harness(); h.peer.input({ type: 'generate', id: 'q1', prompt: 'hello' }); await tick();
    expect(h.command).not.toHaveBeenCalled(); expect(h.providers.generate).not.toHaveBeenCalled();
    expect(h.peer.readyState).toBe(WebSocket.CLOSED);
  });
  it('does not open a provider after disconnect during START and settles its late grant', async () => {
    const h = harness(); await h.login();
    let resolve!: (value: any) => void;
    const original = h.command.getMockImplementation()!;
    h.command.mockImplementationOnce(c => new Promise(r => { resolve = async () => r(await original(c)); }));
    h.peer.input({ type: 'openAudio', channel: 'interviewer' }); await tick();
    h.peer.close(); resolve(null); await tick();
    expect(h.providers.audio).not.toHaveBeenCalled();
    expect(h.command.mock.calls.map(([c]) => c.action)).toEqual(['START', 'STOP']);
  });
  it('terminates upstream/output at a short final reservation, no later callback leaks', async () => {
    let emit!: (text: string) => void, signal!: AbortSignal;
    const h = harness({ generate: async (_input, guard, send) => {
      signal = guard.signal; emit = send; await new Promise<void>(resolve => guard.signal.addEventListener('abort', () => resolve(), { once: true }));
    } }, 800);
    await h.login(); h.peer.input({ type: 'generate', id: 'q1', prompt: 'hello' }); await tick();
    await vi.advanceTimersByTimeAsync(800); expect(signal.aborted).toBe(true);
    expect(() => emit('too late')).toThrow(); expect(h.peer.sent.some(m => m.text === 'too late')).toBe(false);
  });
  it('stops work on checkpoint denial and cancellation; does not retain stale audio', async () => {
    const h = harness(); await h.login(); h.peer.input({ type: 'openAudio', channel: 'candidate' }); await tick();
    h.command.mockImplementationOnce(async () => ({ code: 'SUSPENDED' } as any));
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.audio.close).toHaveBeenCalled(); expect(h.peer.readyState).toBe(WebSocket.CLOSED);
  });
  it('rejects parallel Gemini calls and duplicate audio before they open twice', async () => {
    const h = harness({ generate: async () => new Promise(() => {}) }); await h.login();
    h.peer.input({ type: 'openAudio', channel: 'candidate' });
    h.peer.input({ type: 'openAudio', channel: 'candidate' }); await tick();
    expect(h.peer.readyState).toBe(WebSocket.CLOSED); expect(h.providers.audio).not.toHaveBeenCalled();
    const second = harness({ generate: async () => new Promise(() => {}) }); await second.login();
    second.peer.input({ type: 'generate', id: 'a', prompt: 'one' }); await tick();
    second.peer.input({ type: 'generate', id: 'b', prompt: 'two' }); await tick();
    expect(second.providers.generate).toBeDefined(); expect(second.peer.readyState).toBe(WebSocket.CLOSED);
  });
  it('bounds idle pre-start authentication and slow client buffers without spending', async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(10000);
    expect(h.peer.readyState).toBe(WebSocket.CLOSED); expect(h.command).not.toHaveBeenCalled();
    const slow = harness(); slow.peer.bufferedAmount = 256001; await slow.login();
    expect(slow.peer.readyState).toBe(WebSocket.CLOSED); expect(slow.command).not.toHaveBeenCalled();
  });
  it('bounds a half-open TCP connection with protocol ping/pong, without idle DB polling', async () => {
    const h = harness(); await h.login(); h.peer.ping = vi.fn();
    h.peer.input({ type: 'openAudio', channel: 'interviewer' }); await tick();
    await vi.advanceTimersByTimeAsync(20000); expect(h.peer.ping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000); expect(h.peer.readyState).toBe(WebSocket.CLOSED);
    expect(h.audio.close).toHaveBeenCalled();
    expect(h.command.mock.calls.map(([c]) => c.action)).toEqual(['START', 'CHECKPOINT', 'STOP']);
  });
});

describe('managed account provider adapters', () => {
  it('reports readiness only once after an authenticated upstream open, never for a late open after abort', () => {
    vi.useFakeTimers();
    class Upstream extends EventEmitter { readyState: number = WebSocket.CONNECTING; bufferedAmount = 0; send = vi.fn(); terminate = vi.fn(); }
    const socket = new Upstream(), ready = vi.fn(), failed = vi.fn(), abort = new AbortController();
    providerAdapters(secrets, { connect: () => socket as unknown as WebSocket })
      .audio({ signal: abort.signal, assertActive() {} }, vi.fn(), failed, ready);
    expect(ready).not.toHaveBeenCalled();
    socket.readyState = WebSocket.OPEN; socket.emit('open'); socket.emit('open');
    expect(ready).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
    abort.abort();
    const late = new Upstream(), cancelled = new AbortController(), lateReady = vi.fn();
    providerAdapters(secrets, { connect: () => late as unknown as WebSocket })
      .audio({ signal: cancelled.signal, assertActive() {} }, vi.fn(), failed, lateReady);
    cancelled.abort(); late.readyState = WebSocket.OPEN; late.emit('open');
    expect(lateReady).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });
  const generation = { type: 'generate' as const, id: 'q1', prompt: 'hello' };
  it('uses fixed Gemini destination, secret header only, filters metadata/errors and split secrets', async () => {
    const chunks = ['ordinary text ', 'synthetic-gemini-', 'secret-only'];
    const response = new Response(chunks.map(text => `data: ${JSON.stringify({ apiKey: secrets.deepgramKey,
      candidates: [{ content: { parts: [{ text }, { text: secrets.serviceKey, thought: true }] } }] })}\n\n`).join(''));
    const request = vi.fn(async () => response); const output: string[] = [];
    await providerAdapters(secrets, { fetch: request }).generate(generation, { signal: new AbortController().signal, assertActive() {} }, t => output.push(t));
    expect(output.join('')).toBe('ordinary text [REDACTED]');
    const [url, init] = request.mock.calls[0] as any;
    expect(url).toContain('/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
    expect(url).not.toContain(secrets.geminiKey); expect(init.redirect).toBe('error');
    expect(init.headers['x-goog-api-key']).toBe(secrets.geminiKey);
    expect(init.body).not.toContain(secrets.geminiKey);
  });
  it('aborts hanging Gemini transport on entitlement cancellation and hides raw errors', async () => {
    const abort = new AbortController(); let sentSignal!: AbortSignal;
    const request = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      sentSignal = init!.signal as AbortSignal;
      sentSignal.addEventListener('abort', () => reject(Error(secrets.geminiKey)), { once: true });
    }));
    const task = providerAdapters(secrets, { fetch: request }).generate(generation, { signal: abort.signal, assertActive() {} }, () => {});
    const result = expect(task).rejects.toThrow('Provider unavailable.'); abort.abort(); await result;
    expect(sentSignal.aborted).toBe(true);
  });
  it('bounds provider first-byte timeout and never forwards an upstream error body', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(Error(secrets.serviceKey)), { once: true });
    }));
    const task = providerAdapters(secrets, { fetch: request }).generate(generation, { signal: new AbortController().signal, assertActive() {} }, () => {});
    const result = expect(task).rejects.toThrow('Provider unavailable.'); await vi.advanceTimersByTimeAsync(15000); await result;
    const denied = providerAdapters(secrets, { fetch: async () => new Response(secrets.geminiKey, { status: 403 }) });
    await expect(denied.generate(generation, { signal: new AbortController().signal, assertActive() {} }, () => {})).rejects.toThrow('Provider unavailable.');
  });
  it('enforces Deepgram PCM rate/buffers and terminates the upstream on abort', () => {
    vi.useFakeTimers();
    class Upstream extends EventEmitter { readyState = WebSocket.OPEN; bufferedAmount = 0; send = vi.fn(); terminate = vi.fn(); }
    const socket = new Upstream(), connect = vi.fn(() => socket as unknown as WebSocket), abort = new AbortController();
    const emit = vi.fn(), failed = vi.fn();
    const audio = providerAdapters(secrets, { connect }).audio({ signal: abort.signal, assertActive() {} }, emit, failed);
    audio.write(Buffer.alloc(2560)); expect(socket.send).toHaveBeenCalledOnce();
    socket.emit('message', Buffer.from(JSON.stringify({ event: 'EndOfTurn', transcript: `hello ${secrets.deepgramKey}`, requestId: secrets.serviceKey })));
    expect(emit).toHaveBeenCalledWith({ event: 'EndOfTurn', transcript: 'hello [REDACTED]' });
    abort.abort(); expect(socket.terminate).toHaveBeenCalledOnce(); expect(() => audio.write(Buffer.alloc(2))).toThrow();
    expect(failed).not.toHaveBeenCalled();
    const next = providerAdapters(secrets, { connect }).audio({ signal: new AbortController().signal, assertActive() {} }, emit, failed);
    expect(() => next.write(Buffer.alloc(8193))).toThrow(); expect(failed).toHaveBeenCalledOnce();
  });
  it('bounds stalled Deepgram input and stops on provider failure', async () => {
    vi.useFakeTimers(); const socket = new EventEmitter() as WebSocket; socket.terminate = vi.fn();
    const failed = vi.fn();
    providerAdapters(secrets, { connect: () => socket }).audio({ signal: new AbortController().signal, assertActive() {} }, () => {}, failed);
    await vi.advanceTimersByTimeAsync(15000); expect(socket.terminate).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  });
});

describe('real local relay transport (no external provider or database)', () => {
  it('writes only a terminal frame before the policy close for invalid authentication', async () => {
    const authorize = vi.fn(async () => { throw Error('private authorization error'); });
    const generate = vi.fn(), audio = vi.fn(), events: string[] = [];
    const relay = createRelayServer({ authorize, providers: { generate, audio }, observe: event => events.push(event) });
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const port = (relay.server.address() as { port: number }).port;
    try {
      const peer = new WebSocket(`ws://127.0.0.1:${port}/v1/session`);
      const frames: unknown[] = []; peer.on('message', value => frames.push(JSON.parse(value.toString())));
      const closed = once(peer, 'close'); await once(peer, 'open');
      peer.send(JSON.stringify({ type: 'authenticate', accessToken: 'invalid-synthetic-account-token' }));
      const [code, reason] = await closed;
      expect(code).toBe(1008); expect(reason.toString()).toBe('Account session ended.');
      expect(frames).toEqual([{ type: 'sessionEnded' }]);
      expect(events).toContain('terminal_write_complete');
      expect(generate).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled();
    } finally { await relay.stop(); }
  });
  it('health is bounded; authenticates on the socket; rejects browser/query-token upgrades', async () => {
    const command = vi.fn(async () => ({ code: 'EXHAUSTED' as const }));
    const relay = createRelayServer({ authorize: async () => ({ remainingTokenMs: 60000, createRun: () => createUsageCoordinator(command) }),
      providers: { generate: async () => {}, audio: () => { throw Error('must not open'); } } },'a'.repeat(40));
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const port = (relay.server.address() as { port: number }).port;
    try {
      const health=await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await health.json()).toEqual({ ok: true });expect(health.headers.get('x-cluera-revision')).toBe('a'.repeat(40));
      for (const [path, origin] of [['/v1/session?token=synthetic', undefined], ['/v1/session', STAGING_SITE]]) {
        const peer = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
        const error = await new Promise<Error>(resolve => peer.once('error', resolve));
        expect(error.message).toContain('403');
      }
      const peer = new WebSocket(`ws://127.0.0.1:${port}/v1/session`); await once(peer, 'open');
      const ready = once(peer, 'message'); peer.send(JSON.stringify({ type: 'authenticate', accessToken: 'synthetic-account-access-token' }));
      expect(JSON.parse((await ready)[0].toString())).toEqual({ type: 'ready', protocol: 1 });
      const closed = once(peer, 'close'); peer.send(JSON.stringify({ type: 'openAudio', channel: 'interviewer' }));
      await closed; expect(command).toHaveBeenCalledOnce();
    } finally { await relay.stop(); }
  });
});
