import type { DesktopCaptureSource } from '../../shared/types';

function downsample(input: Float32Array, fromRate: number, toRate = 16_000): Int16Array {
  if (fromRate === toRate) return Int16Array.from(input, (sample) => Math.max(-1, Math.min(1, sample)) * 0x7fff);
  const ratio = fromRate / toRate;
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
  groupId?: string;
  matchesDefaultOutput?: boolean;
}

export function isAutomaticMicrophoneAlias(device: MicrophoneDevice): boolean {
  const label = device.label.trim().toLowerCase();
  return device.deviceId === 'default'
    || device.deviceId === 'communications'
    || /^(?:system\s+)?default(?:\s|[-:])/.test(label)
    || /^communications?(?:\s|[-:])/.test(label);
}

export function selectAutomaticSystemAudioSource(sources: DesktopCaptureSource[]): DesktopCaptureSource | undefined {
  const score = (source: DesktopCaptureSource): number => {
    const name = source.name.toLowerCase();
    // Windows loopback is the actual audio source. A display is only the
    // stable Chromium authorization anchor and avoids presenting audio as a
    // tab/window-share workflow. Fall back to a window only when no display
    // source is available.
    let value = source.id.startsWith('screen:') ? 1_000 : 20;
    if (/cluera|sigmaround/.test(name)) value -= 1_000;
    return value;
  };
  return sources.reduce<DesktopCaptureSource | undefined>((best, source) => (
    !best || score(source) > score(best) ? source : best
  ), undefined);
}

export function selectAutomaticMicrophone(devices: MicrophoneDevice[]): MicrophoneDevice | undefined {
  const loopbackLike = (device: MicrophoneDevice): boolean => (
    /stereo mix|what u hear|loopback|wave out|monitor of|cable output|vb-audio|virtual audio output/.test(device.label.toLowerCase())
  );
  const usable = devices.filter((device) => !loopbackLike(device));
  const systemDefault = usable.find((device) => device.deviceId === 'default')
    ?? usable.find((device) => /^(?:system\s+)?default(?:\s|[-:])/i.test(device.label.trim()));
  if (systemDefault) return systemDefault;
  const communicationsDefault = usable.find((device) => device.deviceId === 'communications')
    ?? usable.find((device) => /^communications?(?:\s|[-:])/i.test(device.label.trim()));
  if (communicationsDefault) return communicationsDefault;

  const score = (device: MicrophoneDevice): number => {
    const label = device.label.toLowerCase();
    let value = 0;
    // Chromium occasionally omits its default aliases. In that case, use the
    // microphone paired with the current output before falling back to names.
    if (device.matchesDefaultOutput) value += 600;
    if (/bluetooth|headset|headphone|earbud|earphone|airpod|buds|hands[- ]?free|\bhfp\b|\bhsp\b/.test(label)) value += 180;
    if (/\busb\b|wireless|gaming/.test(label)) value += 45;
    if (/\bmic(?:rophone)?\b/.test(label)) value += 20;
    if (/internal|built[- ]?in|microphone array|integrated/.test(label)) value -= 20;
    return value;
  };
  return usable.reduce<MicrophoneDevice | undefined>((best, device) => (
    !best || score(device) > score(best) ? device : best
  ), undefined);
}

export class AudioCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private pending = new Int16Array(0);
  private captureEpoch = 0;

  constructor(private readonly source: 'system' | 'candidate' = 'system') {}

  static async listMicrophones(): Promise<MicrophoneDevice[]> {
    const inputs = (devices: MediaDeviceInfo[]): MicrophoneDevice[] => {
      const defaultOutput = devices.find((device) => device.kind === 'audiooutput' && device.deviceId === 'default')
        ?? devices.find((device) => device.kind === 'audiooutput' && /\bdefault\b/i.test(device.label));
      return devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
          groupId: device.groupId,
          matchesDefaultOutput: Boolean(defaultOutput?.groupId && device.groupId && defaultOutput.groupId === device.groupId),
        }));
    };
    const known = await navigator.mediaDevices.enumerateDevices();
    if (known.some((device) => device.kind === 'audioinput' && Boolean(device.label))) return inputs(known);

    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    try {
      return inputs(await navigator.mediaDevices.enumerateDevices());
    } finally {
      permissionStream.getTracks().forEach((track) => track.stop());
    }
  }

  static async audioOutputSignature(): Promise<string> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => `${device.deviceId}\u0000${device.groupId}\u0000${device.label}`)
      .sort()
      .join('\u0001');
  }

  async start(deviceId?: string): Promise<{ deviceId: string; label: string }> {
    await this.stop();
    const epoch = ++this.captureEpoch;
    try {
      if (this.source === 'candidate') {
        const microphoneConstraints = (selectedDeviceId?: string): MediaStreamConstraints => ({
          audio: {
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        try {
          this.stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
        } catch (error) {
          const name = error instanceof DOMException ? error.name : '';
          if (!deviceId || (name !== 'NotFoundError' && name !== 'OverconstrainedError')) throw error;
          this.stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints());
        }
      } else {
        this.stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      }
      // Keep the display video track alive even though it is never rendered or stored.
      // Chromium can end the associated Windows loopback audio when that track is stopped.
      if (!this.stream.getAudioTracks().length) throw new Error(this.source === 'candidate'
        ? 'No microphone audio track is available.'
        : 'Windows did not expose a system-output audio track. Check the active output device and reconnect Audio Output.');
      this.context = new AudioContext({ latencyHint: 'interactive' });
      // Vite copies this same-origin static module beside index.html in both
      // development and packaged builds; no blob: script exception is needed.
      const workletUrl = new URL('./pcm-processor.js', document.baseURI).toString();
      await this.context.audioWorklet.addModule(workletUrl);
      this.sourceNode = this.context.createMediaStreamSource(this.stream);
      this.processor = new AudioWorkletNode(this.context, 'pcm-processor');
      this.silentGain = this.context.createGain();
      this.silentGain.gain.value = 0;
      this.processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (epoch === this.captureEpoch) this.push(downsample(event.data, this.context?.sampleRate ?? 48_000));
      };
      this.sourceNode.connect(this.processor).connect(this.silentGain).connect(this.context.destination);
      await this.context.resume();
      if (this.context.state !== 'running') throw new Error(this.source === 'candidate'
        ? 'The microphone audio processor could not start.'
        : 'The meeting audio processor could not start.');
      const track = this.stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => {
        if (epoch === this.captureEpoch) window.electronAPI.reportAudioError(
          this.source === 'candidate' ? 'Candidate microphone capture stopped.' : 'Windows audio-output capture stopped. Reconnect Audio Output.',
        );
      });
      const settings = track?.getSettings();
      return {
        deviceId: settings?.deviceId ?? deviceId ?? '',
        label: track?.label || (this.source === 'candidate' ? 'Default microphone' : 'Windows audio output'),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Audio capture failed.';
      window.electronAPI.reportAudioError(`${this.source === 'candidate' ? 'Candidate microphone' : 'Audio output'}: ${message}`);
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.captureEpoch += 1;
    if (this.processor) this.processor.port.onmessage = null;
    this.sourceNode?.disconnect();
    this.processor?.disconnect();
    this.silentGain?.disconnect();
    this.sourceNode = null;
    this.processor = null;
    this.silentGain = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context) await this.context.close();
    this.context = null;
    this.pending = new Int16Array(0);
  }

  private push(samples: Int16Array): void {
    const track = this.stream?.getAudioTracks()[0];
    // Do not forward a stale, ended, disabled, or hardware-muted candidate
    // track. This makes Cluera AI's own capture state authoritative while
    // preserving the completely separate display-loopback system path.
    if (!track || track.readyState !== 'live' || !track.enabled || (this.source === 'candidate' && track.muted)) {
      this.pending = new Int16Array(0);
      return;
    }
    const chunkSamples = 1_280; // 80ms at 16 kHz, recommended by Flux.
    const combined = new Int16Array(this.pending.length + samples.length);
    combined.set(this.pending);
    combined.set(samples, this.pending.length);
    let offset = 0;
    while (combined.length - offset >= chunkSamples) {
      const chunk = combined.slice(offset, offset + chunkSamples);
      window.electronAPI.sendAudioChunk(this.source, chunk.buffer);
      offset += chunkSamples;
    }
    this.pending = combined.slice(offset);
  }
}
