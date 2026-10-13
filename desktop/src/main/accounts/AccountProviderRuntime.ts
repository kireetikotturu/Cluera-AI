import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { AudioSourceDescriptor, TranscriptEvent, TurnEvent } from '../../shared/types';
import { parseFluxMessage } from '../stt/DeepgramRecognizer';
import type { SpeechRecognizer } from '../stt/SpeechRecognizer';
import { openStagingRelay, type RelayOutput, type StagingRelayConnection } from './StagingRelayClient';

type Channel = 'interviewer' | 'candidate';
type Authority = { authorizeWork(): Promise<{ accessToken: string; signal: AbortSignal }> };
const failure = () => new Error('Account provider session ended. Check your connection and account balance.');
const image = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().min(4).max(6666668) }).strict();
const requestBody = z.object({ contents: z.array(z.object({ role: z.literal('user'),
  parts: z.array(z.union([z.object({ text: z.string().min(1).max(120000) }).strict(),
    z.object({ inlineData: image }).strict()])).min(1).max(2) }).strict()).length(1),
  generationConfig: z.unknown().optional(), modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/).optional() }).strict();

/** One account owner, one WSS session, one server usage reservation shared by
 * Gemini and both audio channels. Never replays commands or reconnects itself. */
export class AccountProviderRuntime {
  private connection?: StagingRelayConnection;
  private connecting?: Promise<StagingRelayConnection>;
  private lifetime = new AbortController();
  private epoch = 0;
  private preparing = false;
  private lastGeneration = -Infinity;
  private readonly listeners = new Map<Channel, (event: RelayOutput) => void>();
  private generation?: { id: string; chunk(text: string): void; finish(error?: Error): void };
  private cancellation?: { id:string; settled:Promise<boolean>; resolve(value:boolean):void; timer:ReturnType<typeof setTimeout> };
  constructor(private readonly account: Authority, private readonly connect = openStagingRelay,
    private readonly stopped: () => void = () => undefined,
    private readonly context?: (prompt:string,signal:AbortSignal)=>Promise<string>,
    private readonly activity:(active:boolean)=>void=()=>undefined) {}

  private receive = (event: RelayOutput): void => {
    if(event.type==='answerDone' && event.id===this.cancellation?.id){
      const waiting=this.cancellation;this.cancellation=undefined;clearTimeout(waiting.timer);waiting.resolve(true);return;
    }
    if (event.type === 'answer' && event.id === this.generation?.id) this.generation.chunk(event.text);
    else if (event.type === 'answerDone' && event.id === this.generation?.id) this.generation.finish();
    else if (event.type === 'audioReady' || event.type === 'transcript') this.listeners.get(event.channel)?.(event);
  };
  private ensure(): Promise<StagingRelayConnection> {
    if (this.connection && !this.connection.signal.aborted) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    const epoch = this.epoch;
    const attempt = (async () => {
      const auth = await this.account.authorizeWork();
      if (epoch !== this.epoch) throw failure();
      const owner = AbortSignal.any([auth.signal, this.lifetime.signal]);
      const connection = await this.connect(auth.accessToken, owner, this.receive);
      if (epoch !== this.epoch || owner.aborted || connection.signal.aborted) { connection.stop(); throw failure(); }
      this.connection = connection;
      this.activity(true);
      connection.signal.addEventListener('abort', () => { if (epoch === this.epoch) { this.stop(); this.stopped(); } }, { once: true });
      return connection;
    })().catch(() => { throw failure(); }).finally(() => { if (this.connecting === attempt) this.connecting = undefined; });
    this.connecting = attempt; return attempt;
  }
  stop(): void {
    ++this.epoch;
    this.lastGeneration = -Infinity;
    const old = this.connection; this.connection = undefined; this.connecting = undefined;
    this.lifetime.abort(); this.lifetime = new AbortController();
    if(this.cancellation){clearTimeout(this.cancellation.timer);this.cancellation.resolve(false);this.cancellation=undefined;}
    this.generation?.finish(failure()); this.listeners.clear(); old?.stop();
    if(old)this.activity(false);
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
          const timer=setTimeout(()=>this.stop(),5000);timer.unref?.();
          this.cancellation={id,settled,resolve,timer};
          try { connection.send({ type: 'cancelGeneration' }); } catch { this.stop(); }
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
    timeout = setTimeout(abort, 65000); timeout.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    try { connection.send({ type: 'generate', id, prompt, ...(parsed.modelId ? { modelId: parsed.modelId } : {}), ...(images[0] ? { image: images[0].inlineData } : {}) }); }
    catch { finish(failure()); }
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }
  recognizer(source: AudioSourceDescriptor): SpeechRecognizer {
    return new AccountSpeechRecognizer(this, source);
  }
  async openAudio(channel: Channel, receive: (event: RelayOutput) => void, signal: AbortSignal): Promise<StagingRelayConnection> {
    const epoch = this.epoch, connection = await this.ensure();
    if (epoch !== this.epoch || signal.aborted || this.listeners.has(channel)) {
      if (epoch === this.epoch && !this.generation && this.listeners.size === 0) this.stop();
      throw failure();
    }
    this.listeners.set(channel, receive);
    try { connection.send({ type: 'openAudio', channel }); } catch {
      this.listeners.delete(channel);
      if (!this.generation && this.listeners.size === 0) this.stop();
      throw failure();
    }
    return connection;
  }
  closeAudio(channel: Channel): void {
    if (!this.listeners.delete(channel)) return;
    if (this.connection && !this.connection.signal.aborted) {
      try { this.connection.send({ type: 'closeAudio', channel }); } catch { this.stop(); }
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
  private connection?: StagingRelayConnection;
  private ready = false;
  private channel: Channel;
  private closeListener?: () => void;
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
              try { this.connection?.send({ type:'forceEndTurn', channel:this.channel }); }
              catch { this.error(failure()); void this.stop(); }
            }, 3200);
            this.forceEnd.unref?.();
          }
        }
      }, this.owner.signal).then(connection => {
        this.connection = connection;
        this.closeListener = () => { this.ready = false; fail(); if (!this.owner.signal.aborted) this.error(failure()); };
        connection.signal.addEventListener('abort', this.closeListener, { once: true });
        if (connection.signal.aborted) this.closeListener();
      }, fail);
    });
  }
  sendAudio(pcm: Buffer): void {
    if (!this.ready || this.owner.signal.aborted) return; // no unbounded pre-readiness PCM queue
    try { this.connection?.writeAudio(this.channel, pcm); } catch { this.ready = false; this.error(failure()); void this.stop(); }
  }
  async stop(): Promise<void> {
    clearTimeout(this.forceEnd); this.lastTranscript = '';
    this.ready = false; this.owner.abort(); this.runtime.closeAudio(this.channel);
    if (this.closeListener) this.connection?.signal.removeEventListener('abort', this.closeListener);
    this.connection = undefined;
  }
  onPartialTranscript(callback: (value: TranscriptEvent) => void): void { this.partial = callback; }
  onFinalTranscript(callback: (value: TranscriptEvent) => void): void { this.final = callback; }
  onTurnEvent(callback: (value: TurnEvent) => void): void { this.turn = callback; }
  onError(callback: (error: Error) => void): void { this.error = callback; }
}
