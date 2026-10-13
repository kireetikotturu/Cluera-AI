import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { openStagingRelay } from '../src/main/accounts/StagingRelayClient';

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  send = vi.fn((value: string | Buffer, done?: (error?: Error) => void) => { this.sent.push(value); done?.(); });
  close = vi.fn();
  terminate = vi.fn();
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
function setup() {
  const socket = new Socket(), owner = new AbortController(), receive = vi.fn();
  const connect = vi.fn(() => socket as unknown as WebSocket);
  const result = openStagingRelay('synthetic-account-access-token', owner.signal, receive, connect);
  return { socket, owner, receive, connect, result };
}
afterEach(() => { vi.useRealTimers(); });

it('uses only the staging WSS endpoint without headers, redirects or provider credentials', async () => {
  const test = setup(); test.socket.emit('open');
  expect(test.connect).toHaveBeenCalledWith('wss://cluera-ai-relay-staging.onrender.com/v1/session', {
    handshakeTimeout: 12000, followRedirects: false, perMessageDeflate: false, maxPayload: 256000,
  });
  expect(test.socket.sent).toEqual([JSON.stringify({ type: 'authenticate', accessToken: 'synthetic-account-access-token' })]);
  test.socket.message({ type: 'ready', protocol: 1 });
  const session = await test.result;
  expect(JSON.stringify(session)).not.toContain('synthetic-account');
  expect(test.receive).not.toHaveBeenCalled();
  session.stop(); test.socket.emit('close');
});
it('does not equate upgrade with authentication; times out even if the remote never closes', async () => {
  vi.useFakeTimers(); const test = setup();
  const failure = expect(test.result).rejects.toThrow('Account relay unavailable.');
  test.socket.emit('open');
  await vi.advanceTimersByTimeAsync(20000); await failure;
  expect(test.socket.terminate).toHaveBeenCalledOnce();
  test.socket.message({ type: 'ready', protocol: 1 });
  expect(test.receive).not.toHaveBeenCalled();
});
it('rejects provider data before authorization and never forwards it', async () => {
  const test = setup(); const failure = expect(test.result).rejects.toThrow('Account relay unavailable.');
  test.socket.message({ type: 'answer', id: 'one', text: 'must-not-escape' });
  await failure; expect(test.receive).not.toHaveBeenCalled();
});
it('rejects a terminal frame before ready without waiting for transport closure', async () => {
  const test = setup(); const failure = expect(test.result).rejects.toThrow('Account relay unavailable.');
  test.socket.emit('open'); test.socket.message({ type: 'sessionEnded' });
  await failure; expect(test.socket.terminate).toHaveBeenCalledOnce();
  test.socket.message({ type: 'ready', protocol: 1 });
  expect(test.receive).not.toHaveBeenCalled();
});
it('terminal state aborts active work once, drops late data and cannot be replayed into ready', async () => {
  const test = setup(); test.socket.message({ type: 'ready', protocol: 1 });
  const session = await test.result;
  test.socket.message({ type: 'sessionEnded' }); test.socket.message({ type: 'sessionEnded' });
  test.socket.message({ type: 'answer', id: 'late', text: 'must-not-escape' });
  expect(session.signal.aborted).toBe(true); expect(test.receive).not.toHaveBeenCalled();
  expect(test.socket.terminate).toHaveBeenCalledOnce();
  expect(() => session.send({ type: 'openAudio', channel: 'interviewer' })).toThrow();
});
it('bounds handshake errors without leaking dynamic error text', async () => {
  const test = setup(); const failure = expect(test.result).rejects.toThrow(/^Account relay unavailable\.$/);
  test.socket.emit('error', new Error('synthetic-sensitive-upstream-error'));
  await failure;
});
it('rejects unauthenticated close, unknown fields and incorrect protocol', async () => {
  for (const frame of [null, { type: 'ready', protocol: 2 }, { type: 'ready', protocol: 1, accessToken: 'unexpected' }]) {
    const test = setup(); const failure = expect(test.result).rejects.toThrow('Account relay unavailable.');
    if (frame) test.socket.message(frame); else test.socket.emit('close');
    await failure; expect(test.receive).not.toHaveBeenCalled();
  }
});
it('forwards validated answer/audio events only and aborts on protocol violations', async () => {
  const test = setup(); test.socket.message({ type: 'ready', protocol: 1 }); const session = await test.result;
  session.send({ type: 'openAudio', channel: 'interviewer' });
  for (const value of [{ type: 'answer', id: 'one', text: 'answer' }, { type: 'answerDone', id: 'one' },
    { type: 'audioReady', channel: 'interviewer' }, { type: 'transcript', channel: 'candidate', event: 'EndOfTurn', transcript: 'test' }]) {
    test.socket.message(value); expect(test.receive).toHaveBeenLastCalledWith(value);
  }
  test.socket.message({ type: 'answer', id: 'one', text: 'answer', secret: 'not-forwarded' });
  expect(test.receive).toHaveBeenCalledTimes(4); expect(session.signal.aborted).toBe(true);
});
it('sends bounded commands and channel-tagged PCM, not arbitrary renderer fields', async () => {
  const test = setup(); test.socket.message({ type: 'ready', protocol: 1 }); const session = await test.result;
  session.send({ type: 'generate', id: 'one', prompt: 'synthetic' });
  session.send({ type: 'openAudio', channel: 'candidate' });
  expect(() => session.writeAudio('candidate', Buffer.from([1, 2]))).toThrow();
  test.socket.message({ type: 'audioReady', channel: 'candidate' });
  session.writeAudio('candidate', Buffer.from([1, 2]));
  expect(test.socket.sent).toEqual(['{"type":"generate","id":"one","prompt":"synthetic"}', '{"type":"openAudio","channel":"candidate"}', Buffer.from([1, 1, 2])]);
  expect(() => session.send({ type: 'generate', id: 'one', prompt: 'test', apiKey: 'forbidden' } as never)).toThrow();
  expect(() => session.writeAudio('candidate', Buffer.alloc(3))).toThrow();
  expect(() => session.writeAudio('candidate', Buffer.alloc(8194))).toThrow();
  expect(test.socket.sent).toHaveLength(3);
  session.stop(); test.socket.emit('close');
});
it('logout aborts the connection immediately, sends STOP once and bounds a non-closing peer', async () => {
  vi.useFakeTimers(); const test = setup(); test.socket.message({ type: 'ready', protocol: 1 }); const session = await test.result;
  test.owner.abort(); session.stop();
  expect(session.signal.aborted).toBe(true); expect(test.socket.sent).toEqual(['{"type":"stop"}']);
  expect(() => session.send({ type: 'openAudio', channel: 'interviewer' })).toThrow();
  test.socket.message({ type: 'answer', id: 'one', text: 'late' }); expect(test.receive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(test.socket.terminate).toHaveBeenCalledOnce();
});
it('logout during handshake discards the credential and never authenticates a late open', async () => {
  const test = setup(); const failure = expect(test.result).rejects.toThrow('Account relay unavailable.');
  test.owner.abort(); test.socket.emit('open'); await failure;
  expect(test.socket.sent).toEqual([]); test.socket.emit('close');
});
it('refuses an already-ended owner without creating a socket', async () => {
  const owner = new AbortController(); owner.abort(); const connect = vi.fn();
  await expect(openStagingRelay('synthetic-account-access-token', owner.signal, vi.fn(), connect)).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});
it('fails closed on backpressure and send failure without replay or reconnect', async () => {
  for (const mode of ['backpressure', 'send-error']) {
    const test = setup(); test.socket.message({ type: 'ready', protocol: 1 }); const session = await test.result;
    if (mode === 'backpressure') test.socket.bufferedAmount = 256001;
    else test.socket.send.mockImplementation(() => { throw Error('sensitive'); });
    expect(() => session.send({ type: 'openAudio', channel: 'interviewer' })).toThrow('Account relay unavailable.');
    expect(session.signal.aborted).toBe(true); expect(test.connect).toHaveBeenCalledOnce();
  }
});
