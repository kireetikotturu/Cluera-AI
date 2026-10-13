import WebSocket from 'ws';
import { z } from 'zod';
import { ACCOUNT_DISTRIBUTION } from '../../shared/accountDistribution';

// Migration-only transport. Not connected to startup, preload, renderer, or the
// legacy provider path until hosted acceptance and account ownership pass.
const endpoint = ACCOUNT_DISTRIBUTION.relayEndpoint;
const channel = z.enum(['interviewer', 'candidate']);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const incoming = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), protocol: z.literal(1) }).strict(),
  z.object({ type: z.literal('sessionEnded') }).strict(),
  z.object({ type: z.literal('answer'), id, text: z.string().max(128000) }).strict(),
  z.object({ type: z.literal('answerDone'), id }).strict(),
  z.object({ type: z.literal('audioReady'), channel }).strict(),
  z.object({ type: z.literal('transcript'), channel,
    event: z.enum(['StartOfTurn', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn', 'Update']),
    transcript: z.string().max(16000) }).strict(),
]);
const outgoing = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generate'), id, prompt: z.string().min(1).max(120000),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/).optional(),
    image: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      data: z.string().min(4).max(6666668).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict().optional() }).strict(),
  z.object({ type: z.literal('openAudio'), channel }).strict(),
  z.object({ type: z.literal('closeAudio'), channel }).strict(),
  z.object({ type: z.literal('forceEndTurn'), channel }).strict(),
  z.object({ type: z.literal('cancelGeneration') }).strict(),
]);
export type RelayCommand = z.infer<typeof outgoing>;
export type RelayOutput = Exclude<z.infer<typeof incoming>, { type: 'ready' | 'sessionEnded' }>;
export type StagingRelayConnection = {
  /** Aborted on owner logout, timeout, transport failure or server termination. */
  signal: AbortSignal;
  send(command: RelayCommand): void;
  writeAudio(source: z.infer<typeof channel>, pcm: Buffer): void;
  stop(): void;
};
const unavailable = () => new Error('Account relay unavailable.');

/** Main-process only. A WSS upgrade is NOT account authorization. No automatic
 * reconnect/replay (which could duplicate usage), credentials in headers/URLs,
 * provider secrets, persistence, raw error reporting or background polling. */
export function openStagingRelay(accessToken: string, owner: AbortSignal,
  receive: (event: RelayOutput) => void,
  connect: (url: string, options: WebSocket.ClientOptions) => WebSocket = (url, options) => new WebSocket(url, options),
): Promise<StagingRelayConnection> {
  if (owner.aborted || accessToken.length < 20 || accessToken.length > 12000) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    let peer: WebSocket | undefined, authorized = false, ended = false;
    let credential = accessToken;
    accessToken = '';
    const openingAudio = new Set<string>(), readyAudio = new Set<string>();
    const lifetime = new AbortController();
    let terminate: ReturnType<typeof setTimeout> | undefined;
    // Covers upgrade AND application authorization, including a proxy that keeps
    // a rejected upstream socket open. This is not a substitute for hosted tests.
    const deadline = setTimeout(() => finish(false), 20000);
    const onOwnerEnd = () => finish(true);
    function finish(graceful: boolean) {
      if (ended) return;
      ended = true; credential = ''; clearTimeout(deadline);
      openingAudio.clear(); readyAudio.clear();
      owner.removeEventListener('abort', onOwnerEnd);
      // Drop references before notifying callers; reentrant sends must fail.
      const socket = peer;
      lifetime.abort(); reject(unavailable());
      if (!socket || socket.readyState === WebSocket.CLOSED) return;
      if (!graceful || socket.readyState !== WebSocket.OPEN) { socket.terminate(); return; }
      terminate = setTimeout(() => socket.terminate(), 1000); terminate.unref();
      try {
        if (authorized && socket.bufferedAmount <= 256000) socket.send('{"type":"stop"}');
        socket.close(1000, 'Session ended.');
      } catch { socket.terminate(); }
    }
    function send(bytes: string | Buffer) {
      if (ended || !authorized || peer?.readyState !== WebSocket.OPEN) throw unavailable();
      if (peer.bufferedAmount > 256000) { finish(false); throw unavailable(); }
      try { peer.send(bytes, error => { if (error) finish(false); }); }
      catch { finish(false); throw unavailable(); }
    }
    owner.addEventListener('abort', onOwnerEnd, { once: true });
    try {
      peer = connect(endpoint, { handshakeTimeout: 12000, followRedirects: false,
        perMessageDeflate: false, maxPayload: 256000 });
      peer.once('open', () => {
        if (ended || owner.aborted) { finish(false); return; }
        try { peer!.send(JSON.stringify({ type: 'authenticate', accessToken: credential }), error => { if (error) finish(false); }); }
        catch { finish(false); }
        finally { credential = ''; }
      });
      peer.on('message', (raw, binary) => {
        if (ended) return;
        try {
          const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
          if (binary || bytes.length > 256000) throw unavailable();
          const event = incoming.parse(JSON.parse(bytes.toString()));
          // Terminal state is main-owned, never a renderer event or a retry.
          // Do not depend on a proxy forwarding the subsequent WS close frame.
          if (event.type === 'sessionEnded') { finish(false); return; }
          if (!authorized) {
            if (event.type !== 'ready') throw unavailable();
            authorized = true; clearTimeout(deadline);
            resolve({ signal: lifetime.signal,
              send(command) {
                const parsed = outgoing.safeParse(command);
                if (!parsed.success) throw unavailable();
                if (parsed.data.type === 'openAudio') {
                  if (openingAudio.has(parsed.data.channel) || readyAudio.has(parsed.data.channel)) throw unavailable();
                  openingAudio.add(parsed.data.channel);
                } else if (parsed.data.type === 'closeAudio') {
                  openingAudio.delete(parsed.data.channel); readyAudio.delete(parsed.data.channel);
                }
                send(JSON.stringify(parsed.data));
              },
              writeAudio(source, pcm) {
                if (!readyAudio.has(source) || !channel.safeParse(source).success || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length > 8192 || pcm.length % 2) throw unavailable();
                send(Buffer.concat([Buffer.from([source === 'interviewer' ? 0 : 1]), pcm]));
              },
              stop: () => finish(true) });
          } else {
            if (event.type === 'ready') throw unavailable();
            if (event.type === 'audioReady') {
              if (!openingAudio.delete(event.channel)) throw unavailable();
              readyAudio.add(event.channel);
            }
            receive(event);
          }
        } catch { finish(false); }
      });
      peer.on('unexpected-response', (_request, response) => { response.destroy(); finish(false); });
      peer.on('error', () => finish(false)); // Never surface dynamic upstream errors.
      peer.once('close', () => { clearTimeout(terminate); finish(false); });
      if (ended) peer.terminate();
      else if (owner.aborted) finish(true);
    } catch { finish(false); }
  });
}
