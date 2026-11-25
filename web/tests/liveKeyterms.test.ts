import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { providerAdapters } from '../lib/accountRelay/providers';
import { commandFrame } from '../lib/accountRelay/protocol';

const secrets = { deepgramKey: 'synthetic-deepgram-secret-only', serviceKey: 'sb_secret_synthetic-service-secret-only', rateKey: Buffer.alloc(32, 7).toString('base64') };
class Upstream extends EventEmitter { readyState = 0; bufferedAmount = 0; send = vi.fn(); terminate = vi.fn(); }
const guard = () => ({ signal: new AbortController().signal, assertActive() {} });

function open(options?: { keyterms?: string[] }) {
  const sockets: Upstream[] = []; const urls: string[] = [];
  const connect = vi.fn((url: string) => { urls.push(url); const socket = new Upstream(); sockets.push(socket); return socket as unknown as WebSocket; });
  const failed = vi.fn(), ready = vi.fn();
  const connection = providerAdapters(secrets, { connect }).audio(guard(), vi.fn(), failed, ready, options);
  return { sockets, urls, failed, ready, connection };
}
const refuse = (socket: Upstream, statusCode: number) => socket.emit('unexpected-response', {}, { statusCode, destroy: vi.fn() });

describe('words to listen for harder', () => {
  it('adds each word to the live-transcription request, spaces and symbols encoded', () => {
    const { urls } = open({ keyterms: ['Spring Boot', 'Node.js', 'C++', 'CI/CD'] });
    expect(urls[0]).toContain('&keyterm=Spring%20Boot&keyterm=Node.js&keyterm=C%2B%2B&keyterm=CI%2FCD');
  });
  it('sends nothing extra when there are none, and drops anything that is not a plain word', () => {
    expect(open().urls[0]).toBe('wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.75&eot_timeout_ms=4500');
    const { urls } = open({ keyterms: ['Java', 'a=b', 'bad%20', 'x\ny', '', '  ', 'Java', 'q'.repeat(41), 'ok&co'] });
    expect(urls[0].match(/keyterm=/g)).toHaveLength(2);
    expect(urls[0]).toContain('keyterm=Java');
    expect(urls[0]).toContain('keyterm=ok%26co');
  });
  it('keeps at most 25', () => {
    const { urls } = open({ keyterms: Array.from({ length: 40 }, (_, index) => `Term${index}`) });
    expect(urls[0].match(/keyterm=/g)).toHaveLength(25);
  });
  it('opens the connection again without them once if the service refuses the request, so the session still works', () => {
    const { sockets, urls, failed, ready } = open({ keyterms: ['Kubernetes'] });
    refuse(sockets[0], 400);
    expect(sockets[0].terminate).toHaveBeenCalled();
    expect(urls).toHaveLength(2);
    expect(urls[1]).not.toContain('keyterm');
    expect(failed).not.toHaveBeenCalled();
    // Late events of the first connection change nothing.
    sockets[0].emit('close', 1006, Buffer.from(''));
    expect(failed).not.toHaveBeenCalled();
    sockets[1].readyState = 1; sockets[1].emit('open');
    expect(ready).toHaveBeenCalledOnce();
    // A second refusal ends the connection as it always did.
    const second = open({ keyterms: ['Kubernetes'] });
    refuse(second.sockets[0], 422); refuse(second.sockets[1], 400);
    expect(second.failed).toHaveBeenCalledOnce();
  });
  it('does not retry for a sign-in or rate problem, or once audio was already accepted', () => {
    const denied = open({ keyterms: ['Kubernetes'] });
    refuse(denied.sockets[0], 401);
    expect(denied.urls).toHaveLength(1); expect(denied.failed).toHaveBeenCalledOnce();
    const accepted = open({ keyterms: ['Kubernetes'] });
    accepted.sockets[0].readyState = 1; accepted.sockets[0].emit('open');
    refuse(accepted.sockets[0], 400);
    expect(accepted.urls).toHaveLength(1); expect(accepted.failed).toHaveBeenCalledOnce();
  });
  it('is part of the open-audio message, and only as a short list of plain words', () => {
    expect(commandFrame.safeParse({ type: 'openAudio', channel: 'interviewer' }).success).toBe(true);
    expect(commandFrame.safeParse({ type: 'openAudio', channel: 'interviewer', keyterms: ['Spring Boot', 'Ravi'] }).success).toBe(true);
    for (const bad of [Array(26).fill('Java'), ['a'], ['x'.repeat(41)], ['bad=word'], ['line\nbreak'], [5]]) {
      expect(commandFrame.safeParse({ type: 'openAudio', channel: 'interviewer', keyterms: bad }).success).toBe(false);
    }
    expect(commandFrame.safeParse({ type: 'openAudio', channel: 'interviewer', extra: 1 }).success).toBe(false);
  });
});
