import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioCapture } from '../src/renderer/services/audioCapture';

class FakeTrack {
  readyState = 'live'; enabled = true; muted = false; label = 'Default - Headset Microphone';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  getSettings = () => ({ deviceId: 'default' });
  addEventListener = vi.fn();
}
const stream = (track: FakeTrack) => ({ getTracks: () => [track], getAudioTracks: () => [track] });
let processorPort: { onmessage: ((event: { data: Float32Array }) => void) | null };
const sent: Int16Array[] = [];
const reported: string[] = [];
let getUserMedia: ReturnType<typeof vi.fn>;
let devices: Array<{ kind: string; deviceId: string; groupId: string; label: string }>;

beforeEach(() => {
  sent.length = 0; reported.length = 0;
  getUserMedia = vi.fn();
  devices = [];
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => devices } });
  vi.stubGlobal('document', { baseURI: 'file:///app/index.html' });
  vi.stubGlobal('window', { electronAPI: {
    sendAudioChunk: (_source: string, chunk: ArrayBuffer) => sent.push(new Int16Array(chunk)),
    reportAudioError: (message: string) => reported.push(message),
  } });
  const node = () => ({ connect: vi.fn((next: unknown) => next), disconnect: vi.fn() });
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = 16_000; destination = {};
    audioWorklet = { addModule: async () => undefined };
    createMediaStreamSource = () => node();
    createGain = () => ({ ...node(), gain: { value: 1 } });
    resume = async () => undefined;
    close = async () => undefined;
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null as ((event: { data: Float32Array }) => void) | null };
    connect = vi.fn((next: unknown) => next); disconnect = vi.fn();
    constructor() { processorPort = this.port; }
  });
});
afterEach(() => vi.unstubAllGlobals());

const speak = () => processorPort.onmessage!({ data: new Float32Array(1_280).fill(0.5) });

it('sends silence, never the muted sound, while the microphone is muted, so the connection stays open', async () => {
  const track = new FakeTrack(); getUserMedia.mockResolvedValueOnce(stream(track));
  const capture = new AudioCapture('candidate'); await capture.start();
  speak(); expect(sent.at(-1)!.some(sample => sample !== 0)).toBe(true);
  track.muted = true; speak();
  expect(sent).toHaveLength(2); expect(sent.at(-1)!.every(sample => sample === 0)).toBe(true);
  track.muted = false; track.readyState = 'ended'; speak(); expect(sent).toHaveLength(2);
  await capture.stop();
});

it('releases a device that opens after the capture was stopped, and reports no error for it', async () => {
  const track = new FakeTrack(); let open!: (value: unknown) => void;
  getUserMedia.mockImplementationOnce(() => new Promise(resolve => { open = resolve; }));
  const capture = new AudioCapture('candidate');
  const starting = expect(capture.start()).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  await capture.stop(); open(stream(track)); await starting;
  expect(track.stop).toHaveBeenCalled(); expect(reported).toEqual([]);
});

it('a replaced capture never stops the one that replaced it', async () => {
  const first = new FakeTrack(), second = new FakeTrack(); let open!: (value: unknown) => void;
  getUserMedia.mockImplementationOnce(() => new Promise(resolve => { open = resolve; })).mockResolvedValueOnce(stream(second));
  const capture = new AudioCapture('candidate');
  const replaced = expect(capture.start()).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  await capture.start(); open(stream(first)); await replaced;
  expect(first.stop).toHaveBeenCalled(); expect(second.stop).not.toHaveBeenCalled();
  speak(); expect(sent).toHaveLength(1);
  await capture.stop();
});

it('treats only a change of the default device as a change, not headset entries coming and going', async () => {
  devices = [{ kind: 'audioinput', deviceId: 'default', groupId: 'a', label: 'Default - Laptop Mic' }, { kind: 'audioinput', deviceId: 'x', groupId: 'a', label: 'Laptop Mic' },
    { kind: 'audiooutput', deviceId: 'default', groupId: 'a', label: 'Default - Speakers' }];
  const input = await AudioCapture.microphoneSignature(), output = await AudioCapture.audioOutputSignature();
  devices.push({ kind: 'audioinput', deviceId: 'hfp', groupId: 'b', label: 'Headset (Hands-Free)' }, { kind: 'audiooutput', deviceId: 'hfp-out', groupId: 'b', label: 'Headset (Hands-Free)' });
  expect(await AudioCapture.microphoneSignature()).toBe(input); expect(await AudioCapture.audioOutputSignature()).toBe(output);
  devices[0] = { kind: 'audioinput', deviceId: 'default', groupId: 'b', label: 'Default - Headset' };
  expect(await AudioCapture.microphoneSignature()).not.toBe(input); expect(await AudioCapture.audioOutputSignature()).toBe(output);
});
