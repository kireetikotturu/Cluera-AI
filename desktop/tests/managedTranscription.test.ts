import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DeepgramRecognizer } from '../src/main/stt/DeepgramRecognizer';
import type { AudioSourceDescriptor } from '../src/shared/types';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    static sockets: Array<unknown> = [];
    readyState = 1;
    constructor(readonly url: string) { super(); (this.constructor as typeof WebSocket & { sockets: unknown[] }).sockets.push(this); }
    send() {}
    close() { this.emit('close'); }
  } };
});
type TestSocket = { url: string; emit(event: string, value?: unknown): void };
const sockets = (WebSocket as unknown as { sockets: TestSocket[] }).sockets;
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function recognizer() {
  return new DeepgramRecognizer({ apiKey: '', model: '', language: 'en', eotThreshold: .75, maxReconnects: 2,
    managed: source => ({ url: `wss://example.test/api/managed/deepgram?source=${source}`, headers: {} }),
  }, { role: 'local_candidate' } as AudioSourceDescriptor);
}
describe('Managed transcription reconnect bounds', () => {
  it('does not reset retry limits when only the relay, not the provider, opens', async () => {
    const client = recognizer(); const errors = vi.fn(); client.onError(errors);
    const started = client.start(); sockets[0].emit('open'); await started;
    expect(sockets[0].url).toContain('source=candidate');
    sockets[0].emit('close'); await vi.advanceTimersByTimeAsync(750);
    sockets[1].emit('open'); sockets[1].emit('close'); await vi.advanceTimersByTimeAsync(1500);
    sockets[2].emit('open'); sockets[2].emit('close'); await vi.advanceTimersByTimeAsync(10000);
    expect(sockets).toHaveLength(3);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'Deepgram connection could not be restored.' }));
    await client.stop();
  });
  it('resets backoff only after the backend forwards the provider Connected event', async () => {
    const client = recognizer(); const started = client.start(); sockets[0].emit('open'); await started;
    sockets[0].emit('close'); await vi.advanceTimersByTimeAsync(750);
    sockets[1].emit('open'); sockets[1].emit('message', Buffer.from('{"type":"Connected"}'));
    sockets[1].emit('close'); await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(3);
    sockets[2].emit('open'); await client.stop();
  });
});
