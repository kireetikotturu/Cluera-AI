import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('bundled same-origin PCM AudioWorklet', () => {
  it('registers and transfers 20 ms audio batches without blob scripts', () => {
    const source = readFileSync('src/renderer/public/pcm-processor.js', 'utf8');
    const postMessage = vi.fn();
    let Processor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
    class AudioWorkletProcessorStub { port = { postMessage }; }
    runInNewContext(source, {
      AudioWorkletProcessor: AudioWorkletProcessorStub,
      Float32Array,
      Math,
      sampleRate: 48_000,
      registerProcessor: (name: string, constructor: typeof Processor) => {
        expect(name).toBe('pcm-processor');
        Processor = constructor;
      },
    });
    expect(Processor).toBeDefined();
    const worklet = new Processor!();
    for (let frame = 0; frame < 8; frame += 1) {
      expect(worklet.process([[new Float32Array(128).fill(0.25)]])).toBe(true);
    }
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [samples, transfers] = postMessage.mock.calls[0] as [Float32Array, ArrayBuffer[]];
    expect(samples.length).toBe(960);
    expect(samples[0]).toBe(0.25);
    expect(transfers).toEqual([samples.buffer]);
    expect(worklet.process([])).toBe(true);
  });
});
