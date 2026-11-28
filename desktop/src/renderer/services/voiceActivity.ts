/** Whether sound is being heard on each live audio stream, and how loud, for the side rail's waves. It is measured
 * from the audio the app is already recording and is only for drawing: it never changes what is captured or sent. */
export type VoiceSource = 'system' | 'candidate';
export interface VoiceState { speaking: boolean; level: number }

/** Quieter than this (dBFS) is never speech; speech must also stand above the background noise. */
const MIN_SPEECH_DB = -48;
const ABOVE_NOISE_DB = 9;
/** This much louder than the threshold draws the tallest wave. */
const FULL_WAVE_DB = 26;
/** Batches are about 20 ms: two loud ones in a row, so a click or a key press does not start the waves. */
const START_BATCHES = 2;
/** The waves carry on through the short gaps between words. */
export const HOLD_MS = 380;
/** While speaking, the size of the waves changes at most about 16 times a second. */
const UPDATE_MS = 60;
const SILENT: VoiceState = { speaking: false, level: 0 };

export class VoiceMeter {
  private noiseDb = -70;
  private loudInARow = 0;
  private lastSpeechAt = Number.NEGATIVE_INFINITY;
  private level = 0;
  private shown: VoiceState = SILENT;
  private shownAt = Number.NEGATIVE_INFINITY;

  /** What the screen shows now. */
  get current(): VoiceState { return this.shown; }

  /** One batch of 16 kHz audio heard at `at` (ms). Returns what to show when that changes, otherwise null. */
  hear(samples: Int16Array, at: number): VoiceState | null {
    let energy = 0;
    for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
    const rms = samples.length ? Math.sqrt(energy / samples.length) / 32_768 : 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    // The background follows a quieter moment at once and rises only slowly, so a steady hum is not speech.
    this.noiseDb = db < this.noiseDb ? Math.max(-80, db) : Math.min(-52, this.noiseDb + 0.03);
    const threshold = Math.max(MIN_SPEECH_DB, this.noiseDb + ABOVE_NOISE_DB);
    const loud = db > threshold;
    this.loudInARow = loud ? this.loudInARow + 1 : 0;
    if (loud && (this.shown.speaking || this.loudInARow >= START_BATCHES)) this.lastSpeechAt = at;
    const speaking = at - this.lastSpeechAt <= HOLD_MS;
    const target = speaking && loud ? Math.min(1, (db - threshold) / FULL_WAVE_DB) : 0;
    // Rise at once, fall gently.
    this.level = speaking ? Math.max(target, this.level * 0.86 + target * 0.14) : 0;
    return this.show({ speaking, level: Math.round(this.level * 100) / 100 }, at);
  }

  /** The stream stopped. */
  reset(): VoiceState | null {
    this.noiseDb = -70; this.loudInARow = 0; this.lastSpeechAt = Number.NEGATIVE_INFINITY; this.level = 0;
    return this.show(SILENT, this.shownAt);
  }

  private show(next: VoiceState, at: number): VoiceState | null {
    const same = next.speaking === this.shown.speaking;
    if (same && (!next.speaking || at - this.shownAt < UPDATE_MS || Math.abs(next.level - this.shown.level) < 0.08)) return null;
    this.shown = next; this.shownAt = at;
    return next;
  }
}

type Listener = (state: VoiceState) => void;
interface Stream { meter: VoiceMeter; listeners: Set<Listener>; heardAt: number; watch?: ReturnType<typeof setTimeout> }
const stream = (): Stream => ({ meter: new VoiceMeter(), listeners: new Set(), heardAt: 0 });
const streams: Record<VoiceSource, Stream> = { system: stream(), candidate: stream() };

function publish(source: VoiceSource, change: VoiceState | null): void {
  if (change) streams[source].listeners.forEach((listener) => listener(change));
}

/** Audio can stop arriving without a word (a device unplugged): the waves must never keep running then. */
function watch(source: VoiceSource): void {
  const entry = streams[source];
  entry.watch = setTimeout(() => {
    entry.watch = undefined;
    if (!entry.meter.current.speaking) return;
    if (performance.now() - entry.heardAt > HOLD_MS) silenceVoice(source); else watch(source);
  }, 500);
}

export function heardAudio(source: VoiceSource, samples: Int16Array): void {
  const entry = streams[source];
  entry.heardAt = performance.now();
  publish(source, entry.meter.hear(samples, entry.heardAt));
  if (entry.meter.current.speaking && !entry.watch) watch(source);
}

export function silenceVoice(source: VoiceSource): void {
  const entry = streams[source];
  if (entry.watch) { clearTimeout(entry.watch); entry.watch = undefined; }
  publish(source, entry.meter.reset());
}

/** Calls `listener` now and whenever what should be shown changes. */
export function watchVoice(source: VoiceSource, listener: Listener): () => void {
  streams[source].listeners.add(listener);
  listener(streams[source].meter.current);
  return () => { streams[source].listeners.delete(listener); };
}
