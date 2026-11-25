import { CHUNK_SAMPLES, PcmChunker, TARGET_RATE } from './pcm';

/**
 * Cleaning up the phone's microphone before it is sent for transcription. Phones deliver raw sound at 44.1 or 48 kHz,
 * often quietly and with a low rumble; the transcriber wants 16 kHz and a steady level. Three small steps:
 *  1. a proper low-pass resampler (the earlier plain averaging let high sounds fold back into the speech range),
 *  2. a high-pass filter that removes rumble and DC offset,
 *  3. a gentle volume control that lifts a quiet voice to a steady level without boosting silence or background hiss.
 */

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const blackman = (x: number): number => (Math.abs(x) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x));

/** Streaming windowed-sinc resampler; keeps its state between calls, so sound can arrive in pieces of any size. */
export class Resampler {
  private readonly step: number;
  private readonly half: number;
  private readonly phases = 64;
  private readonly table: Float32Array;
  private history: Float32Array;
  private position: number;
  private readonly passthrough: boolean;

  constructor(readonly fromRate: number, readonly toRate: number = TARGET_RATE) {
    this.passthrough = fromRate === toRate;
    this.step = fromRate / toRate;
    // Cut off just under the output's Nyquist (when slowing down); about eight lobes of the filter on each side.
    const cutoff = 0.5 * Math.min(1, toRate / fromRate) * 0.94;
    this.half = Math.max(2, Math.ceil(8 * Math.max(1, this.step)));
    const taps = this.half * 2;
    this.table = new Float32Array(this.phases * taps);
    for (let phase = 0; phase < this.phases; phase += 1) {
      const fraction = phase / this.phases;
      let sum = 0;
      for (let tap = 0; tap < taps; tap += 1) {
        const distance = tap - this.half + 1 - fraction;
        const weight = 2 * cutoff * sinc(2 * cutoff * distance) * blackman(distance / this.half);
        this.table[phase * taps + tap] = weight; sum += weight;
      }
      // Every phase passes a constant level through unchanged.
      for (let tap = 0; tap < taps; tap += 1) this.table[phase * taps + tap] /= sum;
    }
    this.history = new Float32Array(this.half);
    this.position = this.half;
  }

  process(input: Float32Array): Float32Array {
    if (this.passthrough) return input;
    const history = new Float32Array(this.history.length + input.length);
    history.set(this.history); history.set(input, this.history.length);
    const taps = this.half * 2;
    const output: number[] = [];
    let position = this.position;
    while (true) {
      let base = Math.floor(position);
      let phase = Math.round((position - base) * this.phases);
      if (phase === this.phases) { base += 1; phase = 0; }
      if (base + this.half >= history.length) break;
      const offset = phase * taps, first = base - this.half + 1;
      let sum = 0;
      for (let tap = 0; tap < taps; tap += 1) sum += history[first + tap] * this.table[offset + tap];
      output.push(sum);
      position += this.step;
    }
    // Keep only what the next output still needs.
    const keepFrom = Math.max(0, Math.floor(position) - this.half);
    this.history = history.slice(keepFrom);
    this.position = position - keepFrom;
    return Float32Array.from(output);
  }
}

/** First-order high-pass (about 80 Hz): removes DC offset, handling thumps and the low rumble of a table or a vehicle. */
export class HighPass {
  private readonly a: number;
  private lastIn = 0;
  private lastOut = 0;
  constructor(rate: number, cutoff = 80) { this.a = Math.exp(-2 * Math.PI * cutoff / rate); }
  process(samples: Float32Array): Float32Array {
    for (let index = 0; index < samples.length; index += 1) {
      const input = samples[index];
      this.lastOut = this.a * (this.lastOut + input - this.lastIn);
      this.lastIn = input;
      samples[index] = this.lastOut;
    }
    return samples;
  }
}

export interface LevelOptions { target: number; maxGain: number; floor: number }
export const DEFAULT_LEVEL: LevelOptions = { target: 0.09, maxGain: 24, floor: 0.004 };

/** Gentle volume control. Blocks that are clearly speech are lifted towards a steady level; silence and hiss are not boosted. */
export class LevelControl {
  private gain = 1;
  private noise = 0.002;
  constructor(private readonly options: LevelOptions = DEFAULT_LEVEL) {}
  get currentGain(): number { return this.gain; }

  /** `samples` is changed in place. Returns the level of the block before any boost. */
  process(samples: Float32Array, boost = true): number {
    let energy = 0;
    for (let index = 0; index < samples.length; index += 1) energy += samples[index] * samples[index];
    const rms = Math.sqrt(energy / Math.max(1, samples.length));
    // The background level creeps up slowly and falls quickly, so speech is measured against the room around it.
    this.noise = rms < this.noise ? this.noise * 0.8 + rms * 0.2 : Math.min(0.03, this.noise * 1.002 + 1e-6);
    const speech = rms > Math.max(this.options.floor, this.noise * 3);
    let wanted = this.gain;
    if (!boost) wanted = 1;
    else if (speech) wanted = Math.min(this.options.maxGain, Math.max(1, this.options.target / rms));
    else wanted = 1 + (this.gain - 1) * 0.995; // hold, then fade away slowly
    // Lower quickly (a sudden loud sound), rise gradually.
    const blend = wanted < this.gain ? 0.6 : speech ? 0.15 : 1;
    const next = this.gain + (wanted - this.gain) * blend;
    const start = this.gain;
    const length = samples.length;
    for (let index = 0; index < length; index += 1) {
      const factor = start + (next - start) * ((index + 1) / length);
      samples[index] = limit(samples[index] * factor);
    }
    this.gain = next;
    return rms;
  }
}

/** Keeps peaks below full scale without flattening them: sound under 0.6 is untouched, louder sound is curved smoothly. */
export function limit(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= 0.6) return value;
  return Math.sign(value) * (0.6 + 0.38 * Math.tanh((magnitude - 0.6) / 0.38));
}

const toInt16 = (samples: Float32Array): Int16Array => {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    out[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
};

/** The microphone's level as 0 to 1 for a meter (roughly -60 dB to -12 dB). */
export function meterLevel(rms: number): number {
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 48));
}

/** Everything between the microphone's raw sound and the 80 ms pieces sent for transcription. */
export class MicPipeline {
  private readonly resampler: Resampler;
  private readonly highPass = new HighPass(TARGET_RATE);
  private readonly level = new LevelControl();
  private readonly chunker = new PcmChunker();
  /** Level (0 to 1) of the latest block, before any boost. */
  lastLevel = 0;
  boost = true;
  constructor(inputRate: number) { this.resampler = new Resampler(inputRate, TARGET_RATE); }

  push(samples: Float32Array): Int16Array[] {
    const resampled = this.resampler.process(samples.slice());
    if (!resampled.length) return [];
    this.highPass.process(resampled);
    this.lastLevel = meterLevel(this.level.process(resampled, this.boost));
    return this.chunker.push(toInt16(resampled));
  }
  reset(): void { this.chunker.reset(); }
}

export { CHUNK_SAMPLES };
