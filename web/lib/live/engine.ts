import type { QuestionIntent } from '../../../desktop/src/shared/types';
import { IntentDetector } from '../../../desktop/src/main/interview/IntentDetector';
import { AutoQuestionAssembler } from '../../../desktop/src/main/interview/autoQuestionAssembler';
import { mergeFinalTranscriptText } from '../../../desktop/src/main/interview/mergeTranscript';
import { TurnPrefixFilter } from '../../../desktop/src/main/interview/turnPrefixFilter';
import { AnswerStream } from '../../../desktop/src/renderer/services/answerStream';
import { buildAnswerContext, indexSetup, type DocumentIndex } from './context';
import { extractKeyterms } from './keyterms';
import { photoPrompt, PHOTO_QUESTION, questionPrompt } from './prompt';
import { CONNECT_TIMEOUT_MS, RelayLink } from './relayLink';
import type {
  AccessGrant, LiveSetup, LiveSnapshot, LiveStatus, LiveTurn, RelayIncoming, SocketLike, TurnSource,
} from './types';

/** After a lost connection the live audio is opened again on a fresh one. The same waits as the Windows app. */
export const RECONNECT_DELAYS_MS = [300, 1_200, 3_000, 6_000, 10_000] as const;
export const MAX_RECONNECTS = 6;
export const RECONNECT_WINDOW_MS = 120_000;
const RECOVERY_SPACING = [1, 4, 10, 20, 30, 40] as const;
/** The relay allows one new answer per second; a new request waits for this long after the last one. */
const GENERATION_SPACING_MS = 1_100;
const CANCEL_ACK_MS = 5_000;
const AUDIO_READY_MS = 30_000;
/** The sign-in behind a live connection lasts at most an hour; it is renewed this long before it ends. */
const RENEW_BEFORE_MS = 40_000;
const FORCE_END_MS = 3_200;

export interface EngineDeps {
  access(): Promise<AccessGrant>;
  openSocket(url: string): SocketLike;
  now?(): number;
}

interface Generation {
  turnId: string;
  cancelled: boolean;
  /** An automatic question may be replaced when the speaker carries on; a typed question or a photo may not. */
  interruptible: boolean;
  /** The relay has finished this answer (its last piece may still be showing). */
  relayDone: boolean;
  settle(): void;
  settled: Promise<void>;
}

const MAX_TOKENS = { short: 800, medium: 1_500, detailed: 3_000 } as const;
/** A question heard while a typed question or a photo is still being answered waits this long for its turn. */
const DEFERRED_QUESTION_MS = 25_000;

const wordsOf = (text: string): string[] => text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const gramsOf = (words: string[], size: number): Set<string> => {
  const grams = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) grams.add(words.slice(index, index + size).join(' '));
  return grams;
};
/**
 * The microphone hears the customer too. Reading an answer aloud must not be taken for a new question, even when the
 * answer itself contains a question ("Why does this matter? Because..."). True when most of what was heard is
 * (almost word for word) in one of the recent answers.
 */
export function isReadingAnAnswer(heard: string, answers: readonly string[]): boolean {
  const words = wordsOf(heard);
  if (words.length < 4) return false;
  const size = words.length >= 7 ? 3 : 2;
  const wanted = gramsOf(words, size);
  if (!wanted.size) return false;
  const threshold = size === 3 ? 0.75 : 0.8;
  return answers.some(answer => {
    const known = gramsOf(wordsOf(answer), size);
    let hits = 0;
    for (const gram of wanted) if (known.has(gram)) hits += 1;
    return hits / wanted.size >= threshold;
  });
}
const initial = (): LiveSnapshot => ({
  status: 'idle', message: '', paused: false, autoAnswer: true, heard: '', collected: '', turns: [], activeTurnId: null,
  startedAt: 0, modelId: '', answerLength: 'medium', questionSequence: 0,
});

/**
 * The live session of one phone: it listens through the relay, joins the pieces of a spoken question, asks the AI and
 * shows the answer as it is written. It follows the Windows app's rules, so a question is answered the same way on both.
 * The screen only reads `snapshot()` and calls the methods below.
 */
export class LiveEngine {
  private snap: LiveSnapshot = initial();
  private readonly listeners = new Set<() => void>();
  private setup!: LiveSetup;
  private index!: DocumentIndex;
  /** Words the transcriber should listen for harder (role, company, name, technologies). */
  private keyterms: string[] = [];
  private link: RelayLink | undefined;
  private audioReady = false;
  private epoch = 0;
  private running = false;
  private recovering = false;
  private recoveries: number[] = [];
  private generation: Generation | undefined;
  private requestSequence = 0;
  private lastGenerateAt = -Infinity;
  private lastQuestion = '';
  private deferred: { text: string; at: number } | undefined;
  private lastTranscript = '';
  private forceEndTimer: ReturnType<typeof setTimeout> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelAck: { id: string; resolve(): void; timer: ReturnType<typeof setTimeout> } | undefined;
  private counter = 0;
  private readonly photos = new Map<string, { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }>();
  private readonly detector = new IntentDetector();
  private readonly filter = new TurnPrefixFilter();
  private readonly assembler = new AutoQuestionAssembler({ ready: question => { void this.answerAssembled(question); } });
  private readonly stream = new AnswerStream(text => this.appendAnswer(text));
  private streamTurn = '';

  constructor(private readonly deps: EngineDeps) {}

  // ── What the screen reads ────────────────────────────────────────────────────────────────────────────────────────
  snapshot = (): LiveSnapshot => this.snap;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<LiveSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
  private status(status: LiveStatus, message = ''): void { this.update({ status, message }); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  // ── Start and stop ───────────────────────────────────────────────────────────────────────────────────────────────
  /** Opens the live connection and the microphone channel. Resolves when the relay confirms that audio is ready. */
  async start(setup: LiveSetup): Promise<void> {
    this.shutdown();
    this.setup = { ...setup };
    this.index = indexSetup(setup);
    try { this.keyterms = extractKeyterms(setup); } catch { this.keyterms = []; }
    this.running = true;
    const epoch = ++this.epoch;
    this.snap = { ...initial(), status: 'connecting', message: 'Connecting…', autoAnswer: setup.autoAnswer, startedAt: this.now(),
      modelId: setup.modelId, answerLength: setup.answerLength };
    this.update({});
    try {
      await this.connect();
      await this.waitForAudio(epoch);
    } catch (error) {
      if (epoch === this.epoch) this.end('error', error instanceof Error ? error.message : 'The live session could not start.');
      throw error;
    }
  }

  private waitForAudio(epoch: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (epoch !== this.epoch) { reject(new Error('The live session was closed.')); return; }
        if (this.audioReady) { resolve(); return; }
        setTimeout(check, 25);
      };
      check();
    });
  }

  /** Stops everything. The questions and answers so far stay on the screen. */
  stop(): void {
    if (!this.running && this.snap.status === 'ended') return;
    this.end('ended', '');
  }

  private end(status: 'ended' | 'error', message: string): void {
    this.running = false;
    this.shutdown();
    const turns = this.snap.turns.map(turn => turn.state === 'writing'
      ? { ...turn, state: turn.answer.trim() ? 'done' as const : 'cancelled' as const } : turn);
    this.update({ status, message, turns, activeTurnId: null, heard: '', collected: '' });
  }

  /** Cancels timers and drops the connection without changing what the screen shows. */
  private shutdown(): void {
    ++this.epoch;
    const old = this.link;
    this.link = undefined;
    try { old?.stop(); } catch { /* closing anyway */ }
    this.audioReady = false;
    this.recovering = false;
    this.recoveries = [];
    this.generation = undefined;
    this.requestSequence += 1;
    this.stream.dispose();
    this.assembler.discard();
    this.filter.endTurn();
    this.lastQuestion = '';
    this.lastTranscript = '';
    for (const timer of [this.forceEndTimer, this.renewTimer, this.readyTimer]) clearTimeout(timer);
    this.forceEndTimer = this.renewTimer = this.readyTimer = undefined;
    if (this.cancelAck) { clearTimeout(this.cancelAck.timer); this.cancelAck.resolve(); this.cancelAck = undefined; }
    this.photos.clear();
  }

  // ── Connection ───────────────────────────────────────────────────────────────────────────────────────────────────
  private async connect(): Promise<void> {
    const epoch = this.epoch;
    const grant = await this.deps.access();
    if (epoch !== this.epoch) throw new Error('The live session was closed.');
    let self: RelayLink | undefined;
    const link = await RelayLink.connect(() => this.deps.openSocket(grant.relayEndpoint), grant.accessToken, {
      onEvent: event => { if (self && self === this.link) this.onEvent(event); },
      onClose: () => { if (self) this.onLinkClosed(self); },
    }, CONNECT_TIMEOUT_MS, this.setup.id);
    self = link;
    if (epoch !== this.epoch) { link.drop(); throw new Error('The live session was closed.'); }
    this.link = link;
    this.audioReady = false;
    link.send({ type: 'openAudio', channel: 'interviewer', ...(this.keyterms.length ? { keyterms: this.keyterms } : {}) });
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => { if (epoch === this.epoch && this.link === link && !this.audioReady) link.drop(); }, AUDIO_READY_MS);
    this.scheduleRenewal(grant.expiresInMs, epoch, link);
  }

  /** The sign-in behind this connection ends soon: continue on a fresh one between two answers. */
  private scheduleRenewal(expiresInMs: number, epoch: number, link: RelayLink): void {
    clearTimeout(this.renewTimer);
    const deadline = this.now() + expiresInMs;
    const attempt = (): void => {
      if (epoch !== this.epoch || this.link !== link) return;
      if (this.generation && deadline - this.now() > 8_000) { this.renewTimer = setTimeout(attempt, 2_000); return; }
      link.drop();
    };
    this.renewTimer = setTimeout(attempt, Math.max(1_000, expiresInMs - RENEW_BEFORE_MS));
  }

  private onLinkClosed(link: RelayLink): void {
    if (this.link !== link) return;
    this.link = undefined;
    // A connection that ended before the audio was ever ready may have been refused because of the extra words sent
    // with it (an older relay does not know them): the next one is opened without them.
    if (!this.audioReady && this.keyterms.length) this.keyterms = [];
    this.audioReady = false;
    clearTimeout(this.forceEndTimer); clearTimeout(this.readyTimer);
    this.lastTranscript = '';
    if (this.cancelAck) { clearTimeout(this.cancelAck.timer); this.cancelAck.resolve(); this.cancelAck = undefined; }
    this.failActiveAnswer('The connection dropped while the answer was being written. Tap Retry.');
    if (!this.running) return;
    void this.recover();
  }

  private async recover(): Promise<void> {
    if (this.recovering) return;
    const epoch = this.epoch;
    const stamp = this.now();
    this.recoveries = this.recoveries.filter(at => stamp - at < RECONNECT_WINDOW_MS);
    if (this.recoveries.length >= MAX_RECONNECTS) { this.giveUp(epoch); return; }
    this.recoveries.push(stamp);
    this.recovering = true;
    this.status('reconnecting', 'Reconnecting…');
    try {
      const spacing = RECONNECT_DELAYS_MS[0] * RECOVERY_SPACING[Math.min(this.recoveries.length, RECOVERY_SPACING.length) - 1];
      for (const [position, base] of RECONNECT_DELAYS_MS.entries()) {
        await new Promise<void>(resolve => setTimeout(resolve, position === 0 ? Math.max(base, spacing) : base));
        if (epoch !== this.epoch) return;
        try { await this.connect(); return; } catch { if (epoch !== this.epoch) return; }
      }
      this.giveUp(epoch);
    } finally { this.recovering = false; }
  }

  private giveUp(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.end('error', 'The live connection was lost and could not be restored. Your questions and answers so far are kept. Check your internet and your remaining time, then start again.');
  }

  /** The phone woke up (screen on again). After a long sleep the old connection may be dead, so start on a fresh one. */
  wake(hiddenMs: number): void {
    if (!this.running || this.recovering || !this.link) return;
    if (hiddenMs > 8_000 && !this.generation) this.link.drop();
  }

  // ── Messages from the relay ──────────────────────────────────────────────────────────────────────────────────────
  private onEvent(event: Exclude<RelayIncoming, { type: 'ready' | 'sessionEnded' }>): void {
    switch (event.type) {
      case 'audioReady':
        this.audioReady = true; clearTimeout(this.readyTimer);
        this.status('listening', this.snap.paused ? 'Paused' : '');
        break;
      case 'transcript': this.onTranscript(event.event, event.transcript); break;
      case 'answer': if (this.generation?.turnId === event.id && !this.generation.cancelled) this.stream.push(event.id, event.text); break;
      case 'answerDone': this.onAnswerDone(event.id); break;
      case 'answerFailed': this.onAnswerFailed(event.id); break;
    }
  }

  // ── Listening ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** One 80 ms piece of 16 kHz sound from the microphone. While paused, silence is sent so the connection stays open. */
  pushAudio(samples: Int16Array): void {
    const link = this.link;
    if (!link || !this.audioReady) return;
    try { link.writeAudio('interviewer', this.snap.paused ? new Int16Array(samples.length) : samples); } catch { /* the link is closing */ }
  }

  private spokenDisplay(spoken: string): string {
    const base = this.snap.autoAnswer ? this.assembler.pending : this.snap.collected;
    return base ? mergeFinalTranscriptText(base, spoken) : spoken;
  }

  private onTranscript(event: 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn' | 'Update', transcript: string): void {
    if (this.snap.paused || !this.running) return;
    const text = transcript.trim();
    if (event === 'StartOfTurn') this.assembler.hold();
    if (event === 'TurnResumed') {
      this.assembler.hold();
      this.lastQuestion = '';
      if (this.generation?.interruptible && !this.generation.cancelled) void this.cancelCurrent('interrupted');
    }
    const spoken = this.filter.observe(text);
    if (event === 'EndOfTurn') {
      clearTimeout(this.forceEndTimer); this.lastTranscript = '';
      this.filter.endTurn();
      if (!spoken.trim() && !(this.snap.autoAnswer ? this.assembler.pending : this.snap.collected)) { this.update({ heard: '' }); return; }
      if (this.snap.autoAnswer) {
        this.assembler.turnEnded(spoken);
        this.update({ heard: this.assembler.pending });
      } else {
        const collected = mergeFinalTranscriptText(this.snap.collected, spoken);
        this.update({ collected, heard: collected });
      }
      return;
    }
    if (!spoken.trim()) return;
    if (this.snap.autoAnswer) this.assembler.hold();
    this.update({ heard: this.spokenDisplay(spoken) });
    if (text && text !== this.lastTranscript) {
      this.lastTranscript = text;
      clearTimeout(this.forceEndTimer);
      // The speech service sometimes waits a long time before it decides the speaker has finished.
      this.forceEndTimer = setTimeout(() => {
        try { if (this.audioReady) this.link?.send({ type: 'forceEndTurn', channel: 'interviewer' }); } catch { /* connection restoring */ }
      }, FORCE_END_MS);
    }
  }

  /** The speaker stayed quiet long enough: send the collected question to the AI. */
  private async answerAssembled(text: string): Promise<void> {
    const question = text.trim();
    if (!question || !this.running || this.snap.paused || !this.snap.autoAnswer) return;
    if (question.split(/\s+/).length < 2) { this.update({ heard: '' }); return; }
    await this.processQuestion(question, { source: 'voice', force: false, interruptible: true });
  }

  // ── Questions ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** A question typed on the phone. */
  ask(text: string): Promise<boolean> {
    return this.processQuestion(text, { source: 'typed', force: true, interruptible: false });
  }

  /** The question collected so far (Auto Answer off): the customer pressed Send. */
  sendCollected(): Promise<boolean> {
    const text = this.snap.collected.trim() || this.snap.heard.trim();
    this.assembler.discard();
    return this.processQuestion(text, { source: 'voice', force: true, interruptible: false });
  }

  /** A photo of a question. `data` is base64 without the data-URL prefix. */
  async askPhoto(input: { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; preview: string; note: string }): Promise<boolean> {
    if (!this.running) return false;
    if (!this.setup.modelReadsImages) {
      this.update({ message: 'This AI model cannot read photos. Choose another model in Settings, then try again.' });
      return false;
    }
    const note = input.note.trim();
    return this.processQuestion(note || PHOTO_QUESTION, { source: 'photo', force: true, interruptible: false, photo: input });
  }

  retry(turnId: string): Promise<boolean> {
    const turn = this.snap.turns.find(item => item.id === turnId);
    if (!turn || turn.state === 'writing') return Promise.resolve(false);
    const photo = this.photos.get(turnId);
    this.update({ turns: this.snap.turns.filter(item => item.id !== turnId) });
    this.photos.delete(turnId);
    this.lastQuestion = '';
    return this.processQuestion(turn.question, { source: turn.source, force: true, interruptible: false,
      photo: photo && turn.photo ? { ...photo, preview: turn.photo, note: turn.question === PHOTO_QUESTION ? '' : turn.question } : undefined });
  }

  private intentFor(text: string, force: boolean): QuestionIntent {
    let intent = this.detector.detect(text);
    if (this.setup.kind === 'assignment' && !intent.isAnswerNeeded && intent.intent === 'NO_ANSWER_NEEDED') {
      intent = { ...intent, isAnswerNeeded: true, intent: 'GENERAL_QUESTION', confidence: 0.8 };
    }
    if (force && (!intent.isComplete || !intent.isAnswerNeeded)) {
      intent = { ...intent, isComplete: true, isAnswerNeeded: true, intent: 'GENERAL_QUESTION', confidence: 1 };
    }
    return intent;
  }

  private async processQuestion(raw: string, options: {
    source: TurnSource; force: boolean; interruptible: boolean;
    photo?: { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; preview: string; note: string };
  }): Promise<boolean> {
    const display = raw.trim();
    if (!display || !this.running) return false;
    if (!options.force && (this.snap.paused || display === this.lastQuestion)) return false;
    // The customer reading an answer out loud is not a new question.
    if (!options.force && options.source === 'voice' && isReadingAnAnswer(display,
      this.snap.turns.slice(-3).map(turn => turn.answer).filter(Boolean))) {
      this.update({ heard: '', message: 'Heard you reading the answer' });
      return false;
    }
    // An automatic question never replaces a typed question or a photo that is still being answered; it waits its turn.
    if (!options.force && this.generation && !this.generation.interruptible && !this.generation.cancelled) {
      this.deferred = { text: display, at: this.now() };
      return false;
    }
    this.lastQuestion = display;
    const intent = this.intentFor(display, options.force);
    if (!intent.isComplete) { this.update({ message: 'Waiting for the rest of the question' }); return false; }
    if (!intent.isAnswerNeeded) { this.update({ message: 'No answer needed', heard: '' }); return false; }
    const request = ++this.requestSequence;
    const turn: LiveTurn = {
      id: `q${this.now().toString(36)}${(++this.counter).toString(36)}`, question: display, answer: '', at: new Date(this.now()).toISOString(),
      model: this.setup.modelId, source: options.source, state: 'writing',
      ...(options.photo ? { photo: options.photo.preview } : {}),
    };
    if (options.photo) this.photos.set(turn.id, { data: options.photo.data, mimeType: options.photo.mimeType });
    this.update({ turns: [...this.snap.turns, turn], activeTurnId: turn.id, heard: '', collected: '', message: '',
      questionSequence: this.snap.questionSequence + 1 });
    this.assembler.discard();
    const context = buildAnswerContext(this.setup, this.index, intent, this.snap.turns.filter(item => item.id !== turn.id));
    const prompt = options.photo ? photoPrompt(context, options.photo.note) : questionPrompt(context);
    await this.generate(turn, prompt, request, options.interruptible, options.photo && { mimeType: options.photo.mimeType, data: options.photo.data });
    return true;
  }

  // ── Answers ──────────────────────────────────────────────────────────────────────────────────────────────────────
  private async generate(turn: LiveTurn, prompt: string, request: number, interruptible: boolean,
    image?: { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }): Promise<void> {
    const epoch = this.epoch;
    const abandoned = (): boolean => epoch !== this.epoch || request !== this.requestSequence;
    if (this.generation) await this.cancelCurrent('replaced');
    const wait = GENERATION_SPACING_MS - (this.now() - this.lastGenerateAt);
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
    if (abandoned()) { this.discardTurn(turn.id); return; }
    const link = this.link;
    if (!link || !this.audioReady) {
      this.finishTurn(turn.id, 'failed', 'The live connection is getting ready. Tap Retry in a moment.');
      return;
    }
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.generation = { turnId: turn.id, cancelled: false, interruptible, relayDone: false, settle, settled };
    this.streamTurn = turn.id;
    this.stream.start(turn.id);
    this.lastGenerateAt = this.now();
    this.update({ message: 'Writing answer…' });
    try {
      link.send({ type: 'generate', id: turn.id, prompt, ...(this.setup.modelId ? { modelId: this.setup.modelId } : {}),
        maxTokens: MAX_TOKENS[this.snap.answerLength], ...(image ? { image } : {}) });
    } catch {
      this.generation = undefined; settle();
      this.finishTurn(turn.id, 'failed', 'The live connection is getting ready. Tap Retry in a moment.');
    }
  }

  private appendAnswer(text: string): void {
    const id = this.streamTurn;
    if (!text || !id) return;
    this.update({ turns: this.snap.turns.map(turn => (turn.id === id && turn.state === 'writing' ? { ...turn, answer: turn.answer + text } : turn)) });
  }

  private onAnswerDone(id: string): void {
    if (this.cancelAck?.id === id) { clearTimeout(this.cancelAck.timer); this.cancelAck.resolve(); this.cancelAck = undefined; return; }
    const generation = this.generation;
    if (!generation || generation.turnId !== id || generation.cancelled) return;
    generation.relayDone = true;
    this.stream.complete(id, () => {
      if (this.generation !== generation) return;
      this.generation = undefined; generation.settle();
      const turn = this.snap.turns.find(item => item.id === id);
      if (!turn?.answer.trim()) this.finishTurn(id, 'failed', 'The AI sent an empty answer. Tap Retry.');
      else this.finishTurn(id, 'done');
    });
  }

  private onAnswerFailed(id: string): void {
    if (this.cancelAck?.id === id) { clearTimeout(this.cancelAck.timer); this.cancelAck.resolve(); this.cancelAck = undefined; return; }
    const generation = this.generation;
    if (!generation || generation.turnId !== id) return;
    this.stream.flush(); this.stream.dispose();
    this.generation = undefined; generation.settle();
    this.finishTurn(id, 'failed', 'The AI could not answer this time. Tap Retry, or choose another model in Settings.');
  }

  private failActiveAnswer(note: string): void {
    const generation = this.generation;
    if (!generation) return;
    this.generation = undefined; this.stream.flush(); this.stream.dispose(); generation.settle();
    if (generation.cancelled) this.discardTurn(generation.turnId);
    else this.finishTurn(generation.turnId, 'failed', note);
  }

  /** A question heard while another was being answered gets its turn now, if it is still fresh. */
  private afterAnswer(): void {
    const waiting = this.deferred;
    if (!waiting || this.generation || !this.running) return;
    this.deferred = undefined;
    if (this.now() - waiting.at > DEFERRED_QUESTION_MS || this.snap.paused || !this.snap.autoAnswer) return;
    void this.processQuestion(waiting.text, { source: 'voice', force: false, interruptible: true });
  }

  private finishTurn(id: string, state: 'done' | 'failed' | 'cancelled', note?: string): void {
    this.update({
      turns: this.snap.turns.map(turn => (turn.id === id ? { ...turn, state, ...(note ? { note } : {}) } : turn)),
      activeTurnId: this.snap.activeTurnId === id ? null : this.snap.activeTurnId,
      message: this.snap.message === 'Writing answer…' ? '' : this.snap.message,
    });
    queueMicrotask(() => this.afterAnswer());
  }

  /** Removes a question whose answer never started (it was replaced by a newer one). */
  private discardTurn(id: string): void {
    queueMicrotask(() => this.afterAnswer());
    this.photos.delete(id);
    this.update({ turns: this.snap.turns.filter(turn => turn.id !== id), activeTurnId: this.snap.activeTurnId === id ? null : this.snap.activeTurnId });
  }

  /** Asks the relay to stop the answer being written and waits until it confirms, so a new one may start. */
  private async cancelCurrent(why: 'interrupted' | 'replaced' | 'manual'): Promise<void> {
    const generation = this.generation;
    if (!generation || generation.cancelled) { await generation?.settled; return; }
    generation.cancelled = true;
    this.stream.flush(); this.stream.dispose();
    const link = this.link;
    const partial = this.snap.turns.find(turn => turn.id === generation.turnId)?.answer.trim();
    // A question the speaker is still asking is dropped; one the customer asked for keeps what was written.
    if (why !== 'interrupted' && partial) this.finishTurn(generation.turnId, 'cancelled');
    else this.discardTurn(generation.turnId);
    // The relay had already finished this answer: there is nothing to stop and no confirmation will come.
    if (!link?.open || generation.relayDone) { this.generation = undefined; generation.settle(); return; }
    const acknowledged = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // The relay did not confirm in time: a fresh connection is safer than a rejected next request.
        if (this.cancelAck?.id === generation.turnId) { this.cancelAck = undefined; link.drop(); }
        resolve();
      }, CANCEL_ACK_MS);
      this.cancelAck = { id: generation.turnId, resolve: () => { clearTimeout(timer); resolve(); }, timer };
    });
    try { link.send({ type: 'cancelGeneration' }); } catch { link.drop(); }
    await acknowledged;
    if (this.generation === generation) this.generation = undefined;
    generation.settle();
    this.update({ message: '' });
  }

  /** The customer stops the answer that is being written. */
  stopAnswer(): Promise<void> { return this.cancelCurrent('manual'); }

  // ── Settings that can change during a session ────────────────────────────────────────────────────────────────────
  pause(paused: boolean): void {
    if (paused === this.snap.paused) return;
    this.assembler.discard(); this.filter.endTurn(); clearTimeout(this.forceEndTimer); this.lastTranscript = '';
    this.update({ paused, heard: '', collected: '', message: paused ? 'Paused' : '' });
  }

  setAutoAnswer(enabled: boolean): void {
    if (enabled === this.snap.autoAnswer) return;
    this.assembler.discard();
    this.update({ autoAnswer: enabled, heard: '', collected: '' });
  }

  setModel(modelId: string, readsImages: boolean): void {
    this.setup = { ...this.setup, modelId, modelReadsImages: readsImages };
    this.update({ modelId });
  }

  setAnswerLength(answerLength: LiveSetup['answerLength']): void {
    this.setup = { ...this.setup, answerLength };
    this.update({ answerLength });
  }

  /** Forget what was heard so far so it is never shown or sent. */
  clearInput(): void {
    this.filter.discard(); this.assembler.discard();
    this.update({ heard: '', collected: '' });
  }

  setInstructions(instructions: string): void { if (this.setup) this.setup = { ...this.setup, instructions }; }
}
