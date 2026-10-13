class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = Math.max(128, Math.round(sampleRate / 50));
    this.batch = new Float32Array(this.batchSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(input.length - sourceOffset, this.batchSize - this.offset);
      this.batch.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
      this.offset += count;
      sourceOffset += count;
      if (this.offset === this.batchSize) {
        const complete = this.batch;
        this.port.postMessage(complete, [complete.buffer]);
        this.batch = new Float32Array(this.batchSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
