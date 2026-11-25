import { describe, expect, it } from 'vitest';
import { HighPass, LevelControl, limit, meterLevel, MicPipeline, Resampler } from '../lib/live/dsp';
import { CHUNK_SAMPLES } from '../lib/live/pcm';

const tone = (rate: number, hertz: number, amplitude: number, seconds: number): Float32Array =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) => amplitude * Math.sin(2 * Math.PI * hertz * index / rate));
const rms = (samples: ArrayLike<number>, from = 0): number => {
  let sum = 0; let count = 0;
  for (let index = from; index < samples.length; index += 1) { sum += samples[index] * samples[index]; count += 1; }
  return Math.sqrt(sum / Math.max(1, count));
};
/** A tone that starts and stops like words do, so the volume control sees speech and pauses. */
const speechLike = (rate: number, amplitude: number, seconds: number): Float32Array =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) => {
    const time = index / rate;
    return amplitude * Math.sin(2 * Math.PI * 300 * time) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * time));
  });

describe('resampling to 16 kHz', () => {
  it.each([48_000, 44_100, 32_000, 16_000, 8_000])('keeps a speech-range tone at the same level from %i Hz', rate => {
    const input = tone(rate, 1000, 0.5, 2);
    const resampler = new Resampler(rate, 16_000);
    const output = resampler.process(input);
    expect(Math.abs(output.length - Math.round(input.length * 16_000 / rate))).toBeLessThan(40);
    expect(rms(output, 400)).toBeGreaterThan(0.5 / Math.SQRT2 * 0.96);
    expect(rms(output, 400)).toBeLessThan(0.5 / Math.SQRT2 * 1.04);
  });
  it('removes sound above the speech range instead of folding it back into it', () => {
    for (const hertz of [10_000, 12_000, 15_000, 20_000]) {
      const output = new Resampler(48_000, 16_000).process(tone(48_000, hertz, 0.5, 1));
      expect(rms(output, 400)).toBeLessThan(0.5 / Math.SQRT2 * 0.03); // more than 30 dB down
    }
  });
  it('gives the same result however the sound is cut into pieces', () => {
    const input = tone(44_100, 440, 0.4, 1.5);
    const whole = new Resampler(44_100, 16_000).process(input);
    const pieces = new Resampler(44_100, 16_000);
    const parts: Float32Array[] = []; let offset = 0; const sizes = [441, 137, 882, 1, 3000, 255];
    for (let i = 0; offset < input.length; i += 1) { const size = sizes[i % sizes.length]; parts.push(pieces.process(input.subarray(offset, offset + size))); offset += size; }
    const joined = Float32Array.from(parts.flatMap(part => [...part]));
    expect(joined.length).toBe(whole.length);
    let worst = 0; for (let index = 0; index < whole.length; index += 1) worst = Math.max(worst, Math.abs(whole[index] - joined[index]));
    expect(worst).toBeLessThan(1e-5);
  });
});

describe('high-pass filter', () => {
  it('removes a constant offset and rumble but leaves speech frequencies alone', () => {
    const filter = new HighPass(16_000);
    const offset = filter.process(new Float32Array(16_000).fill(0.3));
    expect(Math.abs(offset[15_999])).toBeLessThan(0.01);
    expect(rms(new HighPass(16_000).process(tone(16_000, 30, 0.5, 1)), 4000)).toBeLessThan(0.5 / Math.SQRT2 * 0.45);
    expect(rms(new HighPass(16_000).process(tone(16_000, 1000, 0.5, 1)), 4000)).toBeGreaterThan(0.5 / Math.SQRT2 * 0.97);
  });
});

describe('volume control', () => {
  const run = (samples: Float32Array, boost = true): { out: Float32Array; control: LevelControl } => {
    const control = new LevelControl(); const out = new Float32Array(samples.length);
    for (let start = 0; start < samples.length; start += 320) { const block = samples.slice(start, start + 320); control.process(block, boost); out.set(block, start); }
    return { out, control };
  };
  it('lifts a quiet voice towards a steady level', () => {
    const { out, control } = run(speechLike(16_000, 0.03, 4));
    expect(rms(out, 32_000)).toBeGreaterThan(rms(speechLike(16_000, 0.03, 4), 32_000) * 3);
    expect(rms(out, 32_000)).toBeGreaterThan(0.05);
    expect(rms(out, 32_000)).toBeLessThan(0.14);
    expect(control.currentGain).toBeGreaterThan(2);
  });
  it('does not boost silence or steady background hiss', () => {
    const hiss = Float32Array.from({ length: 64_000 }, (_, index) => 0.002 * Math.sin(index * 12.9898) * Math.cos(index * 78.233));
    const { out, control } = run(hiss);
    expect(control.currentGain).toBeLessThan(1.5);
    expect(rms(out)).toBeLessThan(0.006);
  });
  it('leaves a loud voice alone and never goes beyond full scale', () => {
    const { out, control } = run(tone(16_000, 300, 0.95, 2));
    expect(control.currentGain).toBeLessThan(1.3);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(0.99);
    expect(limit(0.5)).toBe(0.5);
    expect(limit(5)).toBeLessThan(1);
    expect(limit(-5)).toBeGreaterThan(-1);
  });
  it('does nothing when the boost is off', () => {
    const input = speechLike(16_000, 0.03, 2);
    const { out } = run(input, false);
    expect(rms(out)).toBeCloseTo(rms(input), 3);
  });
  it('turns a level into 0 to 1 for the meter', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(0.0005)).toBeLessThan(0.05);
    expect(meterLevel(0.05)).toBeGreaterThan(0.5);
    expect(meterLevel(1)).toBe(1);
  });
});

describe('the whole path from microphone to 80 ms pieces', () => {
  it('turns 48 kHz float sound into whole 16-bit pieces and reports how loud the microphone is', () => {
    const pipeline = new MicPipeline(48_000);
    const input = speechLike(48_000, 0.05, 3);
    const chunks: Int16Array[] = [];
    for (let start = 0; start < input.length; start += 960) chunks.push(...pipeline.push(input.subarray(start, start + 960)));
    expect(chunks.length).toBeGreaterThan(30);
    expect(chunks.every(chunk => chunk.length === CHUNK_SAMPLES)).toBe(true);
    expect(pipeline.lastLevel).toBeGreaterThan(0.3);
    const last = chunks.at(-1)!;
    expect(rms(Array.from(last).map(value => value / 32768))).toBeGreaterThan(0.04);
  });
  it('does not change the sound passed in, and can switch the boost off', () => {
    const pipeline = new MicPipeline(16_000); pipeline.boost = false;
    const input = speechLike(16_000, 0.03, 1);
    const copy = input.slice();
    const chunks = pipeline.push(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
    expect(chunks.length).toBeGreaterThan(5);
    expect(rms(Array.from(chunks[chunks.length - 1]).map(value => value / 32768))).toBeLessThan(0.05);
  });
});
