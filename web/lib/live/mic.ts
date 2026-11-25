import { downsample, PcmChunker } from './pcm';

export class MicError extends Error {}

const explain = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked. Allow the microphone for this website in your browser settings, then tap Start again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this phone.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is being used by another app. Close it, then tap Start again.';
  return error instanceof Error && error.message ? error.message : 'The microphone could not be started.';
};

/**
 * The phone's microphone as 16 kHz sound in 80 ms pieces. It hears the room: the interviewer coming out of a speaker and
 * the customer's own voice alike, so echo cancellation is off (it would remove the interviewer's voice when the phone
 * itself plays the call) while the volume is levelled and steady noise is reduced.
 * Starting must happen in the tap that starts the session; phones only allow sound inside a tap.
 */
export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly chunker = new PcmChunker();
  private epoch = 0;

  async start(onChunk: (samples: Int16Array) => void, onProblem: (message: string) => void): Promise<void> {
    await this.stop();
    const epoch = ++this.epoch;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new MicError('This browser cannot use the microphone on this page. Open Cluera in Chrome or Safari.');
    }
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context || typeof AudioWorkletNode === 'undefined') {
      throw new MicError('This browser is too old to listen through the microphone. Update Chrome or Safari and try again.');
    }
    // Created and resumed first, still inside the tap, before the permission question can take any time.
    const context = new Context({ latencyHint: 'interactive' });
    this.context = context;
    void context.resume().catch(() => undefined);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false,
      });
      if (epoch !== this.epoch) throw new MicError('The microphone was closed.');
      if (!this.stream.getAudioTracks().length) throw new MicError('No microphone audio track is available.');
      await context.audioWorklet.addModule('/live/pcm-processor.js');
      if (epoch !== this.epoch) throw new MicError('The microphone was closed.');
      this.source = context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(context, 'pcm-processor');
      this.sink = context.createGain();
      this.sink.gain.value = 0;
      this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (epoch !== this.epoch) return;
        const track = this.stream?.getAudioTracks()[0];
        // A stopped, disabled or muted microphone sends nothing.
        if (!track || track.readyState !== 'live' || !track.enabled || track.muted) { this.chunker.reset(); return; }
        for (const chunk of this.chunker.push(downsample(event.data, context.sampleRate))) onChunk(chunk);
      };
      this.source.connect(this.node).connect(this.sink).connect(context.destination);
      await context.resume();
      if (context.state !== 'running') throw new MicError('The microphone could not start. Tap Start again.');
      this.stream.getAudioTracks()[0].addEventListener('ended', () => {
        if (epoch === this.epoch) onProblem('The microphone stopped. Tap Start to continue.');
      });
      // A phone call or another app can interrupt the sound; carry on when it is over.
      context.onstatechange = () => {
        if (epoch !== this.epoch) return;
        if ((context.state as string) === 'suspended' || (context.state as string) === 'interrupted') void context.resume().catch(() => undefined);
      };
    } catch (error) {
      await this.stop();
      throw error instanceof MicError ? error : new MicError(explain(error));
    }
  }

  /** Brings the sound back after the phone was locked or the page was in the background. */
  async revive(): Promise<void> {
    const context = this.context;
    if (context && (context.state as string) !== 'running') await context.resume().catch(() => undefined);
  }

  get running(): boolean { return Boolean(this.context && this.context.state === 'running' && this.stream?.getAudioTracks()[0]?.readyState === 'live'); }

  async stop(): Promise<void> {
    this.epoch += 1;
    if (this.node) this.node.port.onmessage = null;
    try { this.source?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch { /* already disconnected */ }
    this.source = this.node = this.sink = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    this.chunker.reset();
    if (context) { context.onstatechange = null; await context.close().catch(() => undefined); }
  }
}
