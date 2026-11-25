import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { AudioSourceDescriptor, TranscriptEvent, TurnEvent } from '../../shared/types';
import { parseFluxMessage } from '../stt/DeepgramRecognizer';
import type { SpeechRecognizer } from '../stt/SpeechRecognizer';
import { openStagingRelay, type RelayCommand, type RelayOutput, type StagingRelayConnection } from './StagingRelayClient';

type Channel = 'interviewer' | 'candidate';
type Authority = { authorizeWork(): Promise<{ accessToken: string; signal: AbortSignal }> };
/** What the live page is told while the audio connection is being restored. */
export type ConnectionState = 'reconnecting' | 'restored' | 'failed';
const failure = () => new Error('Account provider session ended. Check your connection and account balance.');
/** One answer failed on the provider's side; audio and the session are still running. */
const answerFailure = () => new Error('The AI model could not answer this time. Please ask again, or choose another model in Settings.');
const image = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().min(4).max(6666668) }).strict();
const requestBody = z.object({ contents: z.array(z.object({ role: z.literal('user'),
  parts: z.array(z.union([z.object({ text: z.string().min(1).max(120000) }).strict(),
    z.object({ inlineData: image }).strict()])).min(1).max(2) }).strict()).length(1),
  generationConfig: z.unknown().optional(), modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/).optional() }).strict();

/** The relay ends a connection when its sign-in token runs out, when the network blinks, when the server restarts
 * or when a large screenshot upload starves the heartbeat. While the account is still signed in, live audio is
 * reconnected after these waits; once they are used up, or too many reconnects happen in a short time, the
 * session ends exactly as it always did. */
export const RECONNECT_DELAYS_MS = [300, 1_200, 3_000, 6_000, 10_000] as const;
export const MAX_RECONNECTS = 6;
/**
 * A connection that keeps ending soon after it opens is not helped by connecting again at once: the first wait grows
 * with every recent loss (a multiple of the first reconnect delay), so a service that is briefly unhappy is given
 * time instead of being hit again and again, and the session still gives up after MAX_RECONNECTS.
 */
const RECOVERY_SPACING = [1, 4, 10, 20, 30, 40] as const;
export const RECONNECT_WINDOW_MS = 120_000;

/** One account owner, one WSS session, one server usage reservation shared by
 * Gemini and both audio channels. Commands are never replayed: after a lost connection only the audio channels
 * are opened again, on a new connection with a freshly authorized token. */
export class AccountProviderRuntime {
  private connection?: StagingRelayConnection;
  private connecting?: Promise<StagingRelayConnection>;
  private lifetime = new AbortController();
  private authSignal?: AbortSignal;
  private epoch = 0;
  private sessionRef?: string;
  private preparing = false;
  private recovering = false;
  private recoveries: number[] = [];
  private lastGeneration = -Infinity;
  private readonly listeners = new Map<Channel, (event: RelayOutput) => void>();
  private readonly interrupted = new Map<Channel, (reconnecting: boolean) => void>();
  private generation?: { id: string; chunk(text: string): void; finish(error?: Error): void };
  private cancellation?: { id:string; settled:Promise<boolean>; resolve(value:boolean):void; timer:ReturnType<typeof setTimeout> };
  constructor(private readonly account: Authority, private readonly connect = openStagingRelay,
    private readonly stopped: () => void = () => undefined,
    private readonly context?: (prompt:string,signal:AbortSignal)=>Promise<string>,
    private readonly activity:(active:boolean)=>void=()=>undefined,
    private readonly notify:(state:ConnectionState)=>void=()=>undefined,
    private readonly reconnectDelays: readonly number[] = RECONNECT_DELAYS_MS) {}

  private receive = (event: RelayOutput): void => {
    if(event.type==='answerDone' && event.id===this.cancellation?.id){
      const waiting=this.cancellation;this.cancellation=undefined;clearTimeout(waiting.timer);waiting.resolve(true);return;
    }
    if (event.type === 'answer' && event.id === this.generation?.id) this.generation.chunk(event.text);
    else if (event.type === 'answerDone' && event.id === this.generation?.id) this.generation.finish();
    else if (event.type === 'answerFailed' && event.id === this.generation?.id) this.generation.finish(answerFailure());
    else if (event.type === 'audioReady' || event.type === 'transcript') this.listeners.get(event.channel)?.(event);
  };
  /** The app session that the next connection serves (none between sessions). */
  useSession(sessionId: string | undefined): void { this.sessionRef = sessionId; }
  private ensure(): Promise<StagingRelayConnection> {
    if (this.connection && !this.connection.signal.aborted) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    const epoch = this.epoch;
    const attempt = (async () => {
      const auth = await this.account.authorizeWork();
      if (epoch !== this.epoch) throw failure();
      this.authSignal = auth.signal;
      const owner = AbortSignal.any([auth.signal, this.lifetime.signal]);
      const connection = await this.connect(auth.accessToken, owner, this.receive, undefined, this.sessionRef);
      if (epoch !== this.epoch || owner.aborted || connection.signal.aborted) { connection.stop(); throw failure(); }
      this.connection = connection;
      this.activity(true);
      connection.signal.addEventListener('abort', () => { if (epoch === this.epoch) void this.lost(connection); }, { once: true });
      return connection;
    })().catch(() => { throw failure(); }).finally(() => { if (this.connecting === attempt) this.connecting = undefined; });
    this.connecting = attempt; return attempt;
  }
  /**
   * The connection ended. If the account is still signed in and audio was live, open it again so a transient problem
   * does not end the interview or assignment. Logout, account changes and a deliberate stop end everything at once.
   */
  private async lost(failed: StagingRelayConnection): Promise<void> {
    if (this.connection !== failed) return;
    const epoch = this.epoch;
    const channels = [...this.listeners.keys()];
    this.connection = undefined; this.connecting = undefined;
    this.activity(false);
    if (this.cancellation) { clearTimeout(this.cancellation.timer); this.cancellation.resolve(false); this.cancellation = undefined; }
    this.generation?.finish(failure()); // only the answer being written is lost
    if (this.authSignal?.aborted) { this.stop(); this.stopped(); return; }
    if (!channels.length) { this.stop(); return; } // nothing live to keep: the next question connects again by itself
    if (this.recovering) return; // the running recovery tries again with this connection gone
    const now = Date.now();
    this.recoveries = this.recoveries.filter(at => now - at < RECONNECT_WINDOW_MS);
    if (this.recoveries.length >= MAX_RECONNECTS) { this.giveUp(epoch); return; }
    this.recoveries.push(now);
    this.recovering = true;
    try {
      this.notify('reconnecting');
      for (const interrupt of this.interrupted.values()) interrupt(true);
      const spacing = (this.reconnectDelays[0] ?? 0) * RECOVERY_SPACING[Math.min(this.recoveries.length, RECOVERY_SPACING.length) - 1];
      for (const [index, base] of this.reconnectDelays.entries()) {
        const wait = index === 0 ? Math.max(base, spacing) : base;
        try { await delay(wait, undefined, { signal: this.lifetime.signal }); } catch { return; }
        if (epoch !== this.epoch) return;
        try {
          const connection = await this.ensure();
          if (epoch !== this.epoch) return;
          for (const channel of channels) if (this.listeners.has(channel)) connection.send({ type: 'openAudio', channel });
          this.notify('restored');
          return;
        } catch {
          if (epoch !== this.epoch) return;
          if (this.authSignal?.aborted) break; // signed out meanwhile: no point trying again
        }
      }
      this.giveUp(epoch);
    } finally { this.recovering = false; }
  }
  private giveUp(epoch: number): void {
    if (epoch !== this.epoch) return;
    for (const interrupt of [...this.interrupted.values()]) interrupt(false);
    this.notify('failed');
    this.stop(); this.stopped();
  }
  stop(): void {
    ++this.epoch;
    this.recoveries = [];
    this.lastGeneration = -Infinity;
    const old = this.connection; this.connection = undefined; this.connecting = undefined;
    this.lifetime.abort(); this.lifetime = new AbortController();
    if(this.cancellation){clearTimeout(this.cancellation.timer);this.cancellation.resolve(false);this.cancellation=undefined;}
    this.generation?.finish(failure()); this.listeners.clear(); this.interrupted.clear(); old?.stop();
    if(old)this.activity(false);
  }
  /** The live connection, or an error while it is being restored. Audio is simply skipped during that time. */
  writeAudio(channel: Channel, pcm: Buffer): void {
    const connection = this.connection;
    if (!connection || connection.signal.aborted) throw failure();
    connection.writeAudio(channel, pcm);
  }
  sendControl(command: RelayCommand): void {
    const connection = this.connection;
    if (!connection || connection.signal.aborted) throw failure();
    connection.send(command);
  }
  /** Adapts existing prompt/screenshot construction to the bounded relay protocol.
   * Server chooses provider/model/generation policy; no URL or key is accepted. */
  async generate(body: string, signal: AbortSignal): Promise<Response> {
    if (signal.aborted || body.length > 7000000) throw failure();
    let parsed: z.infer<typeof requestBody>;
    try { parsed = requestBody.parse(JSON.parse(body)); } catch { throw failure(); }
    const parts = parsed.contents[0].parts;
    let prompt = parts.filter((part): part is { text: string } => 'text' in part).map(part => part.text).join('\n');
    const images = parts.filter((part): part is { inlineData: z.infer<typeof image> } => 'inlineData' in part);
    if (!prompt || prompt.length > 120000 || images.length > 1 || this.generation || this.preparing) throw failure();
    const epoch = this.epoch;
    let connection: StagingRelayConnection;
    this.preparing = true;
    try {
      if(this.cancellation && !await this.cancellation.settled)throw failure();
      if(this.context)prompt=await this.context(prompt,signal);
      if(signal.aborted||epoch!==this.epoch||prompt.length>120000)throw failure();
      connection = await this.ensure();
      // Respect the relay's unchanged generation-rate boundary after a quick
      // cancellation/completion without reconnecting or interrupting live audio.
      const wait = 1100 - (performance.now() - this.lastGeneration);
      if (wait > 0) await delay(wait, undefined, { signal: AbortSignal.any([signal, connection.signal]) });
    } catch {
      if (epoch === this.epoch && !this.generation && this.listeners.size === 0) this.stop();
      throw failure();
    }
    finally { this.preparing = false; }
    if (signal.aborted || epoch !== this.epoch || this.generation) {
      if (epoch === this.epoch && !this.generation && this.listeners.size === 0) this.stop();
      throw failure();
    }
    this.lastGeneration = performance.now();
    const id = randomUUID(), encoder = new TextEncoder();
    let control!: ReadableStreamDefaultController<Uint8Array>, ended = false, emitted = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const abort = () => finish(failure(), true);
    const finish = (error?: Error, cancel = false, consumerCancelled = false) => {
      if (ended) return; ended = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
      if (this.generation?.id === id) this.generation = undefined;
      if (cancel && !connection.signal.aborted) {
        if(this.listeners.size===0)this.stop();
        else {
          let resolve!:(value:boolean)=>void;
          const settled=new Promise<boolean>(done=>{resolve=done;});
          // If the relay does not confirm the cancellation in time, drop this connection; live audio is then reopened.
          const timer=setTimeout(()=>connection.stop(),5000);timer.unref?.();
          this.cancellation={id,settled,resolve,timer};
          try { connection.send({ type: 'cancelGeneration' }); } catch { connection.stop(); }
        }
      }
      if (!consumerCancelled) { if (error) control.error(error); else control.close(); }
      // Even a send failure must release an otherwise idle usage reservation.
      if(!cancel && this.listeners.size===0)this.stop();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { control = controller; },
      cancel() { finish(undefined, true, true); },
    }, { highWaterMark: 256000, size: chunk => chunk.byteLength });
    this.generation = { id, finish, chunk: text => {
      if (ended) return;
      const bytes = encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`);
      emitted += bytes.length;
      if (emitted > 1500000 || (control.desiredSize ?? 0) < bytes.length) { finish(failure(), true); return; }
      control.enqueue(bytes);
    } };
    timeout = setTimeout(abort, 100000); timeout.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    // The Short/Medium/Detailed setting already reaches this point as the request's token limit; pass it on so
    // the model stops at the right length instead of running to the server maximum.
    const limit = (parsed.generationConfig as { maxOutputTokens?: unknown } | undefined)?.maxOutputTokens;
    const maxTokens = typeof limit === 'number' && Number.isInteger(limit) && limit >= 100 && limit <= 4000 ? limit : undefined;
    try { connection.send({ type: 'generate', id, prompt, ...(parsed.modelId ? { modelId: parsed.modelId } : {}), ...(maxTokens ? { maxTokens } : {}), ...(images[0] ? { image: images[0].inlineData } : {}) }); }
    catch { finish(failure()); }
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }
  recognizer(source: AudioSourceDescriptor): SpeechRecognizer {
    return new AccountSpeechRecognizer(this, source);
  }
  async openAudio(channel: Channel, receive: (event: RelayOutput) => void, signal: AbortSignal,
    interrupted?: (reconnecting: boolean) => void): Promise<StagingRelayConnection> {
    const epoch = this.epoch, connection = await this.ensure();
    if (epoch !== this.epoch || signal.aborted || this.listeners.has(channel)) {
      if (epoch === this.epoch && !this.generation && this.listeners.size === 0) this.stop();
      throw failure();
    }
    this.listeners.set(channel, receive);
    if (interrupted) this.interrupted.set(channel, interrupted);
    try { connection.send({ type: 'openAudio', channel }); } catch {
      this.listeners.delete(channel); this.interrupted.delete(channel);
      if (!this.generation && this.listeners.size === 0) this.stop();
      throw failure();
    }
    return connection;
  }
  closeAudio(channel: Channel): void {
    this.interrupted.delete(channel);
    if (!this.listeners.delete(channel)) return;
    if (this.connection && !this.connection.signal.aborted) {
      try { this.connection.send({ type: 'closeAudio', channel }); } catch { this.connection.stop(); }
    }
    if(this.listeners.size===0&&!this.generation)this.stop();
  }
}

class AccountSpeechRecognizer implements SpeechRecognizer {
  private partial: (value: TranscriptEvent) => void = () => undefined;
  private final: (value: TranscriptEvent) => void = () => undefined;
  private turn: (value: TurnEvent) => void = () => undefined;
  private error: (error: Error) => void = () => undefined;
  private owner = new AbortController();
  private ready = false;
  private channel: Channel;
  private forceEnd?: ReturnType<typeof setTimeout>;
  private lastTranscript = '';
  constructor(private readonly runtime: AccountProviderRuntime, private readonly source: AudioSourceDescriptor) {
    this.channel = source.role === 'local_candidate' ? 'candidate' : 'interviewer';
  }
  async start(): Promise<void> {
    if (this.owner.signal.aborted) throw failure();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); this.owner.signal.removeEventListener('abort', abort); };
      const fail = () => { if (!settled) { settled = true; cleanup(); reject(failure()); } };
      const abort = () => fail();
      const timer = setTimeout(() => { fail(); void this.stop(); }, 30000); timer.unref?.();
      this.owner.signal.addEventListener('abort', abort, { once: true });
      void this.runtime.openAudio(this.channel, event => {
        if (this.owner.signal.aborted) return;
        if (event.type === 'audioReady') { this.ready = true; if (!settled) { settled = true; cleanup(); resolve(); } }
        else if (event.type === 'transcript' && this.ready) {
          const parsed = parseFluxMessage(JSON.stringify(event), this.source);
          if (parsed.transcriptEvent) (parsed.transcriptEvent.isFinal ? this.final : this.partial)(parsed.transcriptEvent);
          if (parsed.turnEvent) this.turn(parsed.turnEvent);
          if (event.event === 'EndOfTurn') { clearTimeout(this.forceEnd); this.lastTranscript = ''; }
          else if (event.transcript && event.transcript !== this.lastTranscript) {
            clearTimeout(this.forceEnd); this.lastTranscript = event.transcript;
            this.forceEnd = setTimeout(() => {
              if (!this.ready || this.owner.signal.aborted) return;
              // A failed send only means the connection is being restored; the next turn will force-end normally.
              try { this.runtime.sendControl({ type:'forceEndTurn', channel:this.channel }); } catch { /* connection restoring */ }
            }, 3200);
            this.forceEnd.unref?.();
          }
        }
      }, this.owner.signal, reconnecting => {
        // The connection was lost. Audio is skipped until it is restored (the relay then confirms with audioReady
        // again); only when it cannot be restored does this source fail, as it always did.
        this.ready = false; clearTimeout(this.forceEnd); this.lastTranscript = '';
        if (!reconnecting && !this.owner.signal.aborted) { fail(); this.error(failure()); }
      }).then(undefined, fail);
    });
  }
  sendAudio(pcm: Buffer): void {
    if (!this.ready || this.owner.signal.aborted) return; // no unbounded pre-readiness PCM queue
    // While the link is busy or being restored this chunk is skipped; the runtime reports a real, final failure.
    try { this.runtime.writeAudio(this.channel, pcm); } catch { /* skipped; a lost connection is reported through the runtime */ }
  }
  async stop(): Promise<void> {
    clearTimeout(this.forceEnd); this.lastTranscript = '';
    this.ready = false; this.owner.abort(); this.runtime.closeAudio(this.channel);
  }
  onPartialTranscript(callback: (value: TranscriptEvent) => void): void { this.partial = callback; }
  onFinalTranscript(callback: (value: TranscriptEvent) => void): void { this.final = callback; }
  onTurnEvent(callback: (value: TurnEvent) => void): void { this.turn = callback; }
  onError(callback: (error: Error) => void): void { this.error = callback; }
}
