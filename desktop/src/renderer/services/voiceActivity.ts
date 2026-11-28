/** Whether the interviewer is speaking, and how loud, for the speaker button's waves. It is measured from the speaker
 * audio the app is already recording and is only for drawing: it never changes what is captured or sent. */
export interface VoiceState { speaking: boolean; level: number }

/** The speaker audio is a clean digital copy, so quiet speech counts too, even at a low volume. */
const MIN_SPEECH_DB = -55;
/** Speech must also stand above the background: a steady hum is not speech. */
const ABOVE_NOISE_DB = 8;
/** This much louder than the threshold draws the tallest wave. */
const FULL_WAVE_DB = 30;
/** Batches are about 20 ms: two loud ones in a row, so a click does not start the waves. */
const START_BATCHES = 2;
/** The waves carry on through the gaps between words and short pauses... */
export const HOLD_MS = 600;
/** ...and a little longer while the speech service says the interviewer's sentence is still going. */
export const OPEN_TURN_HOLD_MS = 1_500;
/** While speaking, the size of the waves changes at most about 16 times a second. */
const UPDATE_MS = 60;
const SILENT: VoiceState = { speaking: false, level: 0 };

export class VoiceMeter {
  private noiseDb = -75;
  private loudInARow = 0;
  private lastSpeechAt = Number.NEGATIVE_INFINITY;
  private level = 0;
  private shown: VoiceState = SILENT;
  private shownAt = Number.NEGATIVE_INFINITY;

  /** What the screen shows now. */
  get current(): VoiceState { return this.shown; }

  /** One batch of 16 kHz audio heard at `at` (ms). Returns what to show when that changes, otherwise null. */
  hear(samples: Int16Array, at: number, holdMs = HOLD_MS): VoiceState | null {
    let energy = 0;
    for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
    const rms = samples.length ? Math.sqrt(energy / samples.length) / 32_768 : 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    // The background follows a quieter moment at once and rises only slowly.
    this.noiseDb = db < this.noiseDb ? Math.max(-85, db) : Math.min(-50, this.noiseDb + 0.03);
    const threshold = Math.max(MIN_SPEECH_DB, this.noiseDb + ABOVE_NOISE_DB);
    const loud = db > threshold;
    this.loudInARow = loud ? this.loudInARow + 1 : 0;
    if (loud && (this.shown.speaking || this.loudInARow >= START_BATCHES)) this.lastSpeechAt = at;
    const speaking = at - this.lastSpeechAt <= holdMs;
    const target = speaking && loud ? Math.min(1, (db - threshold) / FULL_WAVE_DB) : 0;
    // Rise at once, fall gently.
    this.level = speaking ? Math.max(target, this.level * 0.86 + target * 0.14) : 0;
    return this.show({ speaking, level: Math.round(this.level * 100) / 100 }, at);
  }

  /** The stream stopped. */
  reset(): VoiceState | null {
    this.noiseDb = -75; this.loudInARow = 0; this.lastSpeechAt = Number.NEGATIVE_INFINITY; this.level = 0;
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
const meter = new VoiceMeter();
const listeners = new Set<Listener>();
let heardAt = 0;
let turnOpen = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const holdNow = (): number => (turnOpen ? OPEN_TURN_HOLD_MS : HOLD_MS);

function publish(change: VoiceState | null): void {
  if (change) listeners.forEach((listener) => listener(change));
}

/** Audio can stop arriving without a word (a device unplugged): the waves must never keep running then. */
function watch(): void {
  watchdog = setTimeout(() => {
    watchdog = undefined;
    if (!meter.current.speaking) return;
    if (performance.now() - heardAt > holdNow()) silenceSpeaker(); else watch();
  }, 500);
}

export function heardSpeaker(samples: Int16Array): void {
  heardAt = performance.now();
  publish(meter.hear(samples, heardAt, holdNow()));
  if (meter.current.speaking && !watchdog) watch();
}

export function silenceSpeaker(): void {
  if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
  publish(meter.reset());
}

/** The speech service has heard the start of the interviewer's sentence and not yet its end. */
export function setInterviewerTurnOpen(open: boolean): void { turnOpen = open; }

/** Calls `listener` now and whenever what should be shown changes. */
export function watchSpeaker(listener: Listener): () => void {
  listeners.add(listener);
  listener(meter.current);
  return () => { listeners.delete(listener); };
}
