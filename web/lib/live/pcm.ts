/** Speech is sent to the live service as 16 kHz, 16-bit mono sound, in pieces of 80 ms (what Flux recommends). */
export const TARGET_RATE = 16_000;
export const CHUNK_SAMPLES = 1_280;

/** Averages the samples that fall into each 16 kHz step: simple, fast and good enough for speech. */
export function downsample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Int16Array {
  const clamp = (value: number): number => Math.max(-1, Math.min(1, value));
  const scale = (value: number): number => (value < 0 ? value * 0x8000 : value * 0x7fff);
  if (fromRate === toRate) return Int16Array.from(input, sample => scale(clamp(sample)));
  const ratio = fromRate / toRate;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = scale(clamp(sum / Math.max(1, end - start)));
  }
  return output;
}

/** Collects the small pieces the microphone delivers into whole 80 ms chunks. */
export class PcmChunker {
  private pending = new Int16Array(0);
  /** Adds samples and returns every complete chunk now available. */
  push(samples: Int16Array): Int16Array[] {
    const combined = new Int16Array(this.pending.length + samples.length);
    combined.set(this.pending);
    combined.set(samples, this.pending.length);
    const chunks: Int16Array[] = [];
    let offset = 0;
    while (combined.length - offset >= CHUNK_SAMPLES) {
      chunks.push(combined.slice(offset, offset + CHUNK_SAMPLES));
      offset += CHUNK_SAMPLES;
    }
    this.pending = combined.slice(offset);
    return chunks;
  }
  reset(): void { this.pending = new Int16Array(0); }
}
