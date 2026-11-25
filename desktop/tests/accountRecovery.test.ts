import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AccountProviderRuntime, MAX_RECONNECTS } from '../src/main/accounts/AccountProviderRuntime';
import { openStagingRelay, type RelayOutput, type StagingRelayConnection } from '../src/main/accounts/StagingRelayClient';
import type { AudioSourceDescriptor } from '../src/shared/types';

const speakers: AudioSourceDescriptor = { id: 'system', kind: 'system', role: 'remote_interviewer', label: 'Speakers', canTriggerAnswers: true };
const microphone: AudioSourceDescriptor = { id: 'mic', kind: 'microphone', role: 'local_candidate', label: 'You', canTriggerAnswers: false };
const runtimes: AccountProviderRuntime[] = [];
const FAST = [5, 5, 5];

/** A relay that hands out a new connection every time, so a lost one can be replaced. */
function fixture(delays: readonly number[] = FAST) {
  const owner = new AbortController();
  const connections: Array<{ connection: StagingRelayConnection; end(): void; receive(event: RelayOutput): void }> = [];
  let refuse = false;
  const connect = vi.fn(async (_token: string, signal: AbortSignal, callback: (event: RelayOutput) => void) => {
    if (refuse) throw new Error('offline');
    const lifetime = new AbortController();
    const connection: StagingRelayConnection = { signal: lifetime.signal, send: vi.fn(), writeAudio: vi.fn(), stop: vi.fn(() => lifetime.abort()) };
    signal.addEventListener('abort', () => lifetime.abort(), { once: true });
    connections.push({ connection, end: () => lifetime.abort(), receive: callback });
    return connection;
  });
  const authorizeWork = vi.fn(async () => ({ accessToken: 'synthetic-account-token', signal: owner.signal }));
  const stopped = vi.fn(), notify = vi.fn(), activity = vi.fn();
  const runtime = new AccountProviderRuntime({ authorizeWork }, connect, stopped, undefined, activity, notify, delays);
  runtimes.push(runtime);
  const last = () => connections[connections.length - 1];
  return { owner, connections, connect, authorizeWork, runtime, stopped, notify, activity, last, refuse: (value: boolean) => { refuse = value; } };
}
const sentTypes = (connection: StagingRelayConnection) => vi.mocked(connection.send).mock.calls.map(([command]) => command.type);
/** Opens both audio channels like a live session does. */
async function liveAudio(f: ReturnType<typeof fixture>) {
  const speaker = f.runtime.recognizer(speakers), mic = f.runtime.recognizer(microphone);
  const errors: Error[] = [];
  speaker.onError(error => errors.push(error)); mic.onError(error => errors.push(error));
  const ready = Promise.all([speaker.start(), mic.start()]);
  await vi.waitFor(() => expect(f.last()?.connection.send).toHaveBeenCalledTimes(2));
  f.last().receive({ type: 'audioReady', channel: 'interviewer' }); f.last().receive({ type: 'audioReady', channel: 'candidate' });
  await ready;
  return { speaker, mic, errors };
}
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.stop()); vi.useRealTimers(); });

it('reopens live audio on a new connection when the relay ends the old one, without ending the session', async () => {
  const f = fixture(); const { speaker, mic, errors } = await liveAudio(f);
  speaker.sendAudio(Buffer.alloc(2560)); expect(f.connections[0].connection.writeAudio).toHaveBeenCalledTimes(1);
  f.connections[0].end();                                  // the relay ended the connection (for example its token ran out)
  expect(f.notify).toHaveBeenCalledWith('reconnecting');
  speaker.sendAudio(Buffer.alloc(2560)); mic.sendAudio(Buffer.alloc(2560));     // skipped while reconnecting
  await vi.waitFor(() => expect(f.connections).toHaveLength(2));
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('restored'));
  expect(sentTypes(f.connections[1].connection)).toEqual(['openAudio', 'openAudio']);
  expect(f.stopped).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  expect(f.connections[0].connection.writeAudio).toHaveBeenCalledTimes(1);
  // Audio flows again only after the relay confirms each channel on the new connection.
  speaker.sendAudio(Buffer.alloc(2560)); expect(f.connections[1].connection.writeAudio).not.toHaveBeenCalled();
  f.connections[1].receive({ type: 'audioReady', channel: 'interviewer' }); f.connections[1].receive({ type: 'audioReady', channel: 'candidate' });
  speaker.sendAudio(Buffer.alloc(2560)); mic.sendAudio(Buffer.alloc(2560));
  expect(f.connections[1].connection.writeAudio).toHaveBeenCalledTimes(2);
  expect(f.authorizeWork).toHaveBeenCalledTimes(2);        // a fresh token, not the one that ran out
  f.connections[1].receive({ type: 'transcript', channel: 'interviewer', event: 'Update', transcript: 'still hearing you' });
});

it('keeps trying through a short outage and carries on when the network returns', async () => {
  const f = fixture([5, 5, 5, 5, 5]); const { speaker, errors } = await liveAudio(f);
  f.refuse(true); f.connections[0].end();
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.connect.mock.calls.length).toBeGreaterThan(2); expect(f.stopped).not.toHaveBeenCalled();
  f.refuse(false);
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('restored'));
  expect(errors).toEqual([]); expect(f.stopped).not.toHaveBeenCalled();
  void speaker;
});

it('ends the session as before once every attempt has failed, and tells the audio sources', async () => {
  const f = fixture(); const { errors } = await liveAudio(f);
  f.refuse(true); f.connections[0].end();
  await vi.waitFor(() => expect(f.stopped).toHaveBeenCalledOnce());
  expect(f.notify).toHaveBeenCalledWith('failed');
  expect(errors).toHaveLength(2);
  expect(errors[0].message).toBe('Account provider session ended. Check your connection and account balance.');
});

it('does not reconnect after a logout or account change', async () => {
  const f = fixture(); await liveAudio(f);
  f.owner.abort();
  await vi.waitFor(() => expect(f.stopped).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.notify).not.toHaveBeenCalled();
});

it('gives up when the connection keeps being lost again and again', async () => {
  const f = fixture([1]); await liveAudio(f);
  for (let attempt = 0; attempt < MAX_RECONNECTS + 1 && !f.stopped.mock.calls.length; attempt++) {
    const before = f.connections.length;
    f.last().end();
    await vi.waitFor(() => expect(f.connections.length > before || f.stopped.mock.calls.length > 0).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await vi.waitFor(() => expect(f.stopped).toHaveBeenCalledOnce());
  expect(f.notify).toHaveBeenCalledWith('failed');
});

it('waits longer before reconnecting each time a connection is lost again soon after, and a new session starts afresh', async () => {
  const f = fixture([20]); await liveAudio(f);
  const gaps: number[] = [];
  for (let loss = 0; loss < 3; loss++) {
    const before = f.connections.length;
    const lostAt = Date.now();
    f.last().end();
    await vi.waitFor(() => expect(f.connections.length).toBeGreaterThan(before), { timeout: 3000, interval: 2 });
    gaps.push(Date.now() - lostAt);
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('restored'));
    f.notify.mockClear();
  }
  expect(gaps[1]).toBeGreaterThan(gaps[0]);
  expect(gaps[2]).toBeGreaterThan(gaps[1]);                // 1x, 4x, 10x the first delay
  expect(gaps[2]).toBeGreaterThanOrEqual(190);
  // Stopping the live session (a new one is being started) clears the count of recent losses.
  f.runtime.stop();
  const opened = f.connections.length;
  const speaker = f.runtime.recognizer(speakers), mic = f.runtime.recognizer(microphone);
  const ready = Promise.all([speaker.start(), mic.start()]);
  await vi.waitFor(() => expect(f.connections.length).toBeGreaterThan(opened));
  await vi.waitFor(() => expect(f.last().connection.send).toHaveBeenCalledTimes(2));
  f.last().receive({ type: 'audioReady', channel: 'interviewer' }); f.last().receive({ type: 'audioReady', channel: 'candidate' });
  await ready;
  const before = f.connections.length;
  const lostAt = Date.now();
  f.last().end();
  await vi.waitFor(() => expect(f.connections.length).toBeGreaterThan(before), { timeout: 3000, interval: 2 });
  expect(Date.now() - lostAt).toBeLessThan(150);           // back to the shortest wait
});

it('only loses the answer being written when there is no live audio, and does not end the session', async () => {
  const f = fixture();
  const response = await f.runtime.generate(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'A question' }] }] }), new AbortController().signal);
  const reading = response.text();
  f.connections[0].end();
  await expect(reading).rejects.toThrow('Account provider session ended.');
  expect(f.stopped).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
});

it('drops the connection, not the session, when a cancelled answer is never confirmed', async () => {
  vi.useFakeTimers();
  const f = fixture(); const live = liveAudio(f); await vi.advanceTimersByTimeAsync(0); await live;
  const abort = new AbortController();
  const response = await f.runtime.generate(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'A question' }] }] }), abort.signal);
  const reading = response.text().catch(() => 'cancelled');
  abort.abort(); await reading;
  expect(sentTypes(f.connections[0].connection)).toContain('cancelGeneration');
  await vi.advanceTimersByTimeAsync(5000);                 // the relay never confirmed the cancellation
  expect(f.connections[0].connection.stop).toHaveBeenCalled();
  expect(f.stopped).not.toHaveBeenCalled();
  vi.useRealTimers();
  await vi.waitFor(() => expect(f.connections).toHaveLength(2));
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('restored'));
});

// ---- the network connection itself ----
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  send = vi.fn((value: string | Buffer, done?: (error?: Error) => void) => { this.sent.push(value); done?.(); });
  close = vi.fn();
  terminate = vi.fn();
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
async function readyRelay() {
  const socket = new Socket(), owner = new AbortController();
  const result = openStagingRelay('synthetic-account-access-token', owner.signal, vi.fn(), () => socket as unknown as WebSocket);
  socket.message({ type: 'ready', protocol: 1 });
  const session = await result;
  session.send({ type: 'openAudio', channel: 'interviewer' }); socket.message({ type: 'audioReady', channel: 'interviewer' });
  socket.sent.length = 0;
  return { socket, session };
}
it('skips audio, instead of ending the session, while a large screenshot is still uploading', async () => {
  const { socket, session } = await readyRelay();
  socket.bufferedAmount = 2_500_000;                        // a screenshot is on its way out
  session.writeAudio('interviewer', Buffer.alloc(2560));
  expect(socket.sent).toEqual([]); expect(session.signal.aborted).toBe(false);
  socket.bufferedAmount = 0;                                // the upload finished
  session.writeAudio('interviewer', Buffer.alloc(2560));
  expect(socket.sent).toHaveLength(1); expect(session.signal.aborted).toBe(false);
});

it('lets a large screenshot command through even while an earlier upload is still draining', async () => {
  const { socket, session } = await readyRelay();
  socket.bufferedAmount = 1_000_000;
  session.send({ type: 'generate', id: 'shot1', prompt: 'Read this', image: { mimeType: 'image/png', data: 'QUJDRA==' } });
  expect(socket.sent).toHaveLength(1); expect(session.signal.aborted).toBe(false);
});

it('still ends the session when the link is truly stuck, or a command piles up without limit', async () => {
  vi.useFakeTimers();
  const stuck = await readyRelay();
  stuck.socket.bufferedAmount = 400_000;
  stuck.session.writeAudio('interviewer', Buffer.alloc(2560));
  expect(stuck.session.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(() => stuck.session.writeAudio('interviewer', Buffer.alloc(2560))).toThrow('Account relay unavailable.');
  expect(stuck.session.signal.aborted).toBe(true);
  const flooded = await readyRelay();
  flooded.socket.bufferedAmount = 9_000_001;
  expect(() => flooded.session.send({ type: 'forceEndTurn', channel: 'interviewer' })).toThrow('Account relay unavailable.');
  expect(flooded.session.signal.aborted).toBe(true);
});

// ---- wiring ----
import fs from 'node:fs';
const source = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

it('tells the live page when reconnecting gave up, and lets it reset so Start works again', () => {
  const main = source('src/main/main.ts'), page = source('src/renderer/pages/CopilotPage.tsx');
  // Whatever ends the live work (giving up, sleep, a lost sign-in) tells the page, so it never shows a dead session as running.
  expect(main).toContain("stopAccountWork = async () => { emit('session:interrupted', null); accountProviders?.stop(); await stopProtectedSession(); };");
  expect(page).toContain("window.electronAPI.onEvent('session:interrupted', () => interruptedRef.current())");
  expect(page).toContain('window.electronAPI.setSessionWindowMode(true)');
  expect(page).toContain('preparedSessionId.current = null; deviceCheckPromise.current = null;');
});
