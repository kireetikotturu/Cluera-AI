import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReadingAnAnswer, LiveEngine, MAX_RECONNECTS } from '../lib/live/engine';
import type { LiveSetup, SocketLike } from '../lib/live/types';
import { DEFAULT_ANSWER_PREFERENCES } from '../../desktop/src/shared/answerPreferences';

class FakeSocket implements SocketLike {
  readyState = 0; bufferedAmount = 0; binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: SocketLike['onopen'] = null; onmessage: SocketLike['onmessage'] = null; onclose: SocketLike['onclose'] = null; onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | ArrayBufferView): void { this.sent.push(typeof data === 'string' ? data : data as Uint8Array); }
  close(): void { this.readyState = 3; this.onclose?.({}); }
  accept(): void { this.readyState = 1; this.onopen?.({}); }
  push(message: object): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  /** The relay or the network ends the connection. */
  die(): void { this.readyState = 3; this.onclose?.({}); }
  frames(): Array<Record<string, unknown>> { return this.sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item)); }
  commands(type: string): Array<Record<string, any>> { return this.frames().filter(frame => frame.type === type); }
  audio(): Uint8Array[] { return this.sent.filter((item): item is Uint8Array => typeof item !== 'string'); }
}

const setup = (overrides: Partial<LiveSetup> = {}): LiveSetup => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'interview', title: 'Practice', role: 'Java developer', company: 'Acme',
  interviewType: 'mixed', language: 'English', answerLength: 'medium', answerStyle: 'Balanced', answerPreferences: DEFAULT_ANSWER_PREFERENCES,
  instructions: 'Keep it short.', resumeText: 'Ravi Kumar. Built payment services in Java and Spring Boot at Globex.\n\nSkills: Java, SQL, Docker.',
  jobDescription: 'Backend engineer working with Java microservices.', supporting: [], documentNames: [], modelId: 'gemini-3.5-flash',
  modelReadsImages: true, autoAnswer: true, saveHistory: true, ...overrides,
});

let sockets: FakeSocket[];
let engine: LiveEngine;
let accessCalls: number;
const access = async () => { accessCalls += 1; return { accessToken: 'synthetic-access-token-0000', expiresInMs: 3_600_000, relayEndpoint: 'wss://relay.example/v1/session' }; };
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Starts a session and walks the relay through authentication and audio. */
async function begin(options: Partial<LiveSetup> = {}) {
  const started = engine.start(setup(options));
  await flush();
  const socket = sockets.at(-1)!;
  socket.accept();
  // The connection names its session, so Admin shows its usage as one session.
  expect(socket.frames()[0]).toEqual({ type: 'authenticate', accessToken: 'synthetic-access-token-0000', sessionRef: '00000000-0000-4000-8000-000000000001' });
  socket.push({ type: 'ready', protocol: 1 });
  await flush();
  expect(socket.commands('openAudio')).toEqual([{ type: 'openAudio', channel: 'interviewer', keyterms: expect.arrayContaining(['Java developer', 'Acme', 'Spring Boot']) }]);
  socket.push({ type: 'audioReady', channel: 'interviewer' });
  await flush(30);
  await started;
  return socket;
}
const say = (socket: FakeSocket, text: string) => {
  socket.push({ type: 'transcript', channel: 'interviewer', event: 'StartOfTurn', transcript: '' });
  socket.push({ type: 'transcript', channel: 'interviewer', event: 'Update', transcript: text });
  socket.push({ type: 'transcript', channel: 'interviewer', event: 'EndOfTurn', transcript: text });
};

beforeEach(() => {
  vi.useFakeTimers();
  sockets = []; accessCalls = 0;
  engine = new LiveEngine({ access, openSocket: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; } });
});
afterEach(() => { engine.stop(); vi.useRealTimers(); });

describe('the phone live session', () => {
  it('connects, authorizes on the first message and listens', async () => {
    const socket = await begin();
    expect(engine.snapshot().status).toBe('listening');
    expect(socket.url).toBe('wss://relay.example/v1/session');
    expect(socket.binaryType).toBe('arraybuffer');
    // Sound is sent in the relay's framing: one channel byte, then 16-bit samples.
    engine.pushAudio(new Int16Array(1280).fill(5));
    const frame = socket.audio()[0];
    expect(frame[0]).toBe(0);
    expect(frame.byteLength).toBe(1 + 1280 * 2);
  });

  it('answers a spoken question once the speaker stays quiet, with the session details in the prompt', async () => {
    const socket = await begin();
    say(socket, 'What is polymorphism in Java?');
    expect(socket.commands('generate')).toHaveLength(0);
    await flush(600);
    const [generate] = socket.commands('generate');
    expect(generate.modelId).toBe('gemini-3.5-flash');
    expect(generate.maxTokens).toBe(1500);
    expect(generate.prompt).toContain('What is polymorphism in Java?');
    expect(generate.prompt).toContain('Java developer');
    expect(generate.image).toBeUndefined();
    expect(engine.snapshot().turns).toHaveLength(1);
    expect(engine.snapshot().turns[0].state).toBe('writing');
    socket.push({ type: 'answer', id: generate.id, text: 'Polymorphism lets one interface ' });
    socket.push({ type: 'answer', id: generate.id, text: 'have many forms.' });
    socket.push({ type: 'answerDone', id: generate.id });
    await flush(400);
    const [turn] = engine.snapshot().turns;
    expect(turn.answer).toBe('Polymorphism lets one interface have many forms.');
    expect(turn.state).toBe('done');
    expect(engine.snapshot().activeTurnId).toBeNull();
  });

  it('joins the pieces of a question the speaker paused in, and ignores small talk', async () => {
    const socket = await begin();
    say(socket, 'Okay, thanks.');
    await flush(3_000);
    expect(socket.commands('generate')).toHaveLength(0);
    socket.push({ type: 'transcript', channel: 'interviewer', event: 'EndOfTurn', transcript: 'Tell me about a time you' });
    await flush(1_000);
    socket.push({ type: 'transcript', channel: 'interviewer', event: 'TurnResumed', transcript: 'Tell me about a time you' });
    socket.push({ type: 'transcript', channel: 'interviewer', event: 'EndOfTurn', transcript: 'Tell me about a time you fixed a production bug?' });
    await flush(700);
    const generates = socket.commands('generate');
    expect(generates).toHaveLength(1);
    expect(generates[0].prompt).toContain('fixed a production bug');
  });

  it('replaces an answer when the speaker carries on, waiting for the relay to confirm before the next one starts', async () => {
    const socket = await begin();
    say(socket, 'What is a thread in Java?');
    await flush(600);
    const first = socket.commands('generate')[0];
    socket.push({ type: 'answer', id: first.id, text: 'A thread is' });
    await flush(50);
    socket.push({ type: 'transcript', channel: 'interviewer', event: 'TurnResumed', transcript: 'What is a thread in Java and' });
    await flush(10);
    expect(socket.commands('cancelGeneration')).toHaveLength(1);
    say(socket, 'What is a thread in Java and how is it different from a process?');
    await flush(700);
    // Nothing new is sent until the relay has confirmed the cancellation.
    expect(socket.commands('generate')).toHaveLength(1);
    socket.push({ type: 'answerDone', id: first.id });
    await flush(1_300);
    const generates = socket.commands('generate');
    expect(generates).toHaveLength(2);
    expect(generates[1].prompt).toContain('different from a process');
    expect(engine.snapshot().turns.map(turn => turn.id)).toEqual([generates[1].id]);
  });

  it('sends a typed question at once, even while an answer is being written, and keeps what was written', async () => {
    const socket = await begin();
    void engine.ask('Explain the difference between a list and a set.');
    await flush(10);
    const first = socket.commands('generate')[0];
    socket.push({ type: 'answer', id: first.id, text: 'A list keeps order.' });
    await flush(50);
    void engine.ask('And what about a map?');
    await flush(10);
    expect(socket.commands('cancelGeneration')).toHaveLength(1);
    socket.push({ type: 'answerDone', id: first.id });
    await flush(1_300);
    expect(socket.commands('generate')).toHaveLength(2);
    const states = engine.snapshot().turns.map(turn => turn.state);
    expect(states).toEqual(['cancelled', 'writing']);
  });

  it('does not wait for a confirmation that will never come when the relay already finished the answer', async () => {
    const socket = await begin();
    void engine.ask('What is encapsulation?');
    await flush(10);
    const first = socket.commands('generate')[0];
    socket.push({ type: 'answer', id: first.id, text: 'Hiding data behind methods.' });
    socket.push({ type: 'answerDone', id: first.id });
    void engine.ask('What is inheritance?');
    await flush(1_300);
    expect(socket.commands('cancelGeneration')).toHaveLength(0);
    expect(socket.commands('generate')).toHaveLength(2);
  });

  // The relay ends the whole session if two questions reach it less than a second apart. A slow network can hold the
  // first one up on the way, so only the relay's reply shows that it has arrived.
  it('waits a second after the relay first replies before it sends a quick follow-up', async () => {
    const socket = await begin();
    void engine.ask('Explain the difference between a list and a set.');
    const first = socket.commands('generate')[0];
    await flush(700); // the first reply is late
    socket.push({ type: 'answer', id: first.id, text: 'A list keeps order.' });
    void engine.ask('And what about a map?');
    await flush(100);
    socket.push({ type: 'answerDone', id: first.id }); // the relay confirms that it stopped
    await flush(899); // 999 ms after the first reply
    expect(socket.commands('generate')).toHaveLength(1);
    await flush(1);
    expect(socket.commands('generate')).toHaveLength(2);
  });

  it('counts a confirmed cancellation or a failed answer as that first reply', async () => {
    const socket = await begin();
    void engine.ask('Explain the difference between a list and a set.');
    await flush(100);
    void engine.ask('And what about a map?'); // the relay has said nothing about the first one yet
    await flush(600);
    socket.push({ type: 'answerDone', id: socket.commands('generate')[0].id });
    await flush(999);
    expect(socket.commands('generate')).toHaveLength(1);
    await flush(1);
    expect(socket.commands('generate')).toHaveLength(2);

    await flush(700);
    const second = socket.commands('generate')[1];
    socket.push({ type: 'answerFailed', id: second.id });
    void engine.retry(second.id);
    await flush(999);
    expect(socket.commands('generate')).toHaveLength(2);
    await flush(1);
    expect(socket.commands('generate')).toHaveLength(3);
  });

  it('still waits a second after a very late first reply, because the network held the question that long', async () => {
    const socket = await begin();
    void engine.ask('What is a deadlock?');
    await flush(2_500);
    socket.push({ type: 'answerFailed', id: socket.commands('generate')[0].id });
    void engine.ask('What is a livelock?');
    await flush(999);
    expect(socket.commands('generate')).toHaveLength(1);
    await flush(1);
    expect(socket.commands('generate')).toHaveLength(2);
  });

  it('does not wait on a new connection, because the relay times each connection by itself', async () => {
    const socket = await begin();
    void engine.ask('What is recursion?');
    socket.die();
    await flush(400);
    const next = sockets.at(-1)!;
    next.accept(); next.push({ type: 'ready', protocol: 1 });
    await flush(0);
    next.push({ type: 'audioReady', channel: 'interviewer' });
    await flush(0);
    void engine.ask('What is iteration?');
    await flush(0);
    expect(next.commands('generate')).toHaveLength(1);
  });

  it('marks an answer as failed when the relay says the model could not answer, and retry asks again', async () => {
    const socket = await begin();
    void engine.ask('What is a deadlock?');
    await flush(10);
    const first = socket.commands('generate')[0];
    socket.push({ type: 'answerFailed', id: first.id });
    await flush(10);
    expect(engine.snapshot().turns[0].state).toBe('failed');
    expect(engine.snapshot().turns[0].note).toContain('Retry');
    void engine.retry(first.id);
    await flush(1_300);
    expect(socket.commands('generate')).toHaveLength(2);
    expect(engine.snapshot().turns).toHaveLength(1);
  });

  it('with Auto Answer off it only collects the question until Send is pressed', async () => {
    const socket = await begin({ autoAnswer: false });
    say(socket, 'Why do you want to join our company?');
    await flush(3_000);
    expect(socket.commands('generate')).toHaveLength(0);
    expect(engine.snapshot().collected).toBe('Why do you want to join our company?');
    void engine.sendCollected();
    await flush(10);
    expect(socket.commands('generate')).toHaveLength(1);
    expect(engine.snapshot().collected).toBe('');
  });

  it('sends silence instead of sound and ignores speech while paused', async () => {
    const socket = await begin();
    engine.pause(true);
    engine.pushAudio(new Int16Array(1280).fill(900));
    const frame = socket.audio()[0];
    expect(frame.subarray(1).every(byte => byte === 0)).toBe(true);
    say(socket, 'What is a stack overflow?');
    await flush(3_000);
    expect(socket.commands('generate')).toHaveLength(0);
    engine.pause(false);
    say(socket, 'What is a stack overflow?');
    await flush(700);
    expect(socket.commands('generate')).toHaveLength(1);
  });

  it('asks the relay to end the turn when the transcript stops changing', async () => {
    const socket = await begin();
    socket.push({ type: 'transcript', channel: 'interviewer', event: 'Update', transcript: 'What is a closure' });
    await flush(3_300);
    expect(socket.commands('forceEndTurn')).toEqual([{ type: 'forceEndTurn', channel: 'interviewer' }]);
  });

  it('sends a photo with the question prompt and refuses it for a model that cannot read photos', async () => {
    const socket = await begin();
    void engine.askPhoto({ data: 'QUJD', mimeType: 'image/jpeg', preview: 'data:image/jpeg;base64,QUJD', note: '' });
    await flush(10);
    const [generate] = socket.commands('generate');
    expect(generate.image).toEqual({ mimeType: 'image/jpeg', data: 'QUJD' });
    expect(generate.prompt).toContain('photo');
    expect(engine.snapshot().turns[0].source).toBe('photo');
    engine.setModel('text-only-model', false);
    expect(await engine.askPhoto({ data: 'QUJD', mimeType: 'image/jpeg', preview: 'x', note: '' })).toBe(false);
    expect(engine.snapshot().message).toContain('cannot read photos');
    expect(socket.commands('generate')).toHaveLength(1);
  });

  it('opens the audio again on a fresh connection with a fresh sign-in after the connection drops', async () => {
    const socket = await begin();
    void engine.ask('What is recursion?');
    await flush(10);
    socket.die();
    await flush(0);
    expect(engine.snapshot().status).toBe('reconnecting');
    expect(engine.snapshot().turns[0].state).toBe('failed');
    await flush(400);
    const next = sockets.at(-1)!;
    expect(next).not.toBe(socket);
    expect(accessCalls).toBe(2);
    next.accept(); next.push({ type: 'ready', protocol: 1 });
    await flush(0);
    expect(next.commands('openAudio')).toHaveLength(1);
    next.push({ type: 'audioReady', channel: 'interviewer' });
    await flush(0);
    expect(engine.snapshot().status).toBe('listening');
    engine.pushAudio(new Int16Array(1280).fill(3));
    expect(next.audio()).toHaveLength(1);
  });

  it('gives up with a clear message after too many lost connections in a short time, keeping the answers', async () => {
    let socket = await begin();
    void engine.ask('What is a monad?');
    await flush(10);
    socket.push({ type: 'answer', id: socket.commands('generate')[0].id, text: 'A monad is a design pattern.' });
    socket.push({ type: 'answerDone', id: socket.commands('generate')[0].id });
    await flush(400);
    for (let attempt = 0; attempt < MAX_RECONNECTS + 1 && engine.snapshot().status !== 'error'; attempt += 1) {
      socket.die();
      await flush(13_000);
      const next = sockets.at(-1)!;
      if (next === socket || next.readyState !== 0) break;
      next.accept(); next.push({ type: 'ready', protocol: 1 });
      await flush(0);
      next.push({ type: 'audioReady', channel: 'interviewer' });
      await flush(0);
      socket = next;
    }
    expect(engine.snapshot().status).toBe('error');
    expect(engine.snapshot().message).toContain('could not be restored');
    expect(engine.snapshot().turns[0].answer).toBe('A monad is a design pattern.');
  });

  it('renews the connection before the sign-in runs out, between two answers', async () => {
    const socket = await begin();
    await flush(3_600_000 - 41_000 + 1_000);
    expect(accessCalls).toBe(1);
    await flush(2_000);
    expect(engine.snapshot().status).toBe('reconnecting');
    await flush(400);
    expect(accessCalls).toBe(2);
    expect(sockets.at(-1)).not.toBe(socket);
  });

  it('stops cleanly: the relay is told, and unfinished work is closed off', async () => {
    const socket = await begin();
    void engine.ask('What is a race condition?');
    await flush(10);
    engine.stop();
    expect(socket.commands('stop')).toHaveLength(1);
    expect(engine.snapshot().status).toBe('ended');
    expect(engine.snapshot().turns[0].state).toBe('cancelled');
    await flush(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('does not take the customer reading an answer aloud for a new question', async () => {
    const socket = await begin();
    say(socket, 'What is polymorphism in Java?');
    await flush(600);
    const first = socket.commands('generate')[0];
    const answer = 'Polymorphism lets one interface take many forms. Why does that matter? Because you can write code against a parent type.';
    socket.push({ type: 'answer', id: first.id, text: answer });
    socket.push({ type: 'answerDone', id: first.id });
    await flush(500);
    say(socket, 'Why does that matter? Because you can write code against a parent type.');
    await flush(3_000);
    expect(socket.commands('generate')).toHaveLength(1);
    expect(engine.snapshot().turns).toHaveLength(1);
    // A real new question still gets its answer.
    say(socket, 'What is encapsulation in Java?');
    await flush(2_000);
    expect(socket.commands('generate')).toHaveLength(2);
  });

  it('recognises reading aloud but not a short or different question', () => {
    const answer = 'A thread is the smallest unit of execution. Threads share memory inside one process.';
    expect(isReadingAnAnswer('A thread is the smallest unit of execution', [answer])).toBe(true);
    expect(isReadingAnAnswer('what is the smallest unit of execution called', [answer])).toBe(false);
    expect(isReadingAnAnswer('What is a process', [answer])).toBe(false);
    expect(isReadingAnAnswer('a thread is', [answer])).toBe(false);
    expect(isReadingAnAnswer('anything at all here today', [])).toBe(false);
  });

  it('keeps a question heard while a typed question is answered, and answers it right after', async () => {
    const socket = await begin();
    void engine.ask('Explain the difference between a list and a set.');
    await flush(10);
    const typed = socket.commands('generate')[0];
    say(socket, 'What is a hash map in Java?');
    await flush(2_000);
    expect(socket.commands('generate')).toHaveLength(1);
    socket.push({ type: 'answer', id: typed.id, text: 'A list keeps order.' });
    socket.push({ type: 'answerDone', id: typed.id });
    await flush(2_500);
    const generates = socket.commands('generate');
    expect(generates).toHaveLength(2);
    expect(generates[1].prompt).toContain('hash map');
  });

  it('forgets a waiting question that is no longer fresh', async () => {
    const socket = await begin();
    void engine.ask('Explain the difference between a list and a set.');
    await flush(10);
    const typed = socket.commands('generate')[0];
    say(socket, 'What is a hash map in Java?');
    await flush(40_000);
    socket.push({ type: 'answer', id: typed.id, text: 'A list keeps order.' });
    socket.push({ type: 'answerDone', id: typed.id });
    await flush(3_000);
    expect(socket.commands('generate')).toHaveLength(1);
  });

  it('opens the audio again without the extra words if the relay ended the connection before audio was ready', async () => {
    const started = engine.start(setup());
    await flush();
    const first = sockets.at(-1)!;
    first.accept(); first.push({ type: 'ready', protocol: 1 });
    await flush();
    expect(first.commands('openAudio')[0].keyterms).toBeDefined();
    first.die();
    await flush(400);
    const second = sockets.at(-1)!;
    expect(second).not.toBe(first);
    second.accept(); second.push({ type: 'ready', protocol: 1 });
    await flush();
    expect(second.commands('openAudio')).toEqual([{ type: 'openAudio', channel: 'interviewer' }]);
    second.push({ type: 'audioReady', channel: 'interviewer' });
    await flush(30);
    await started;
    expect(engine.snapshot().status).toBe('listening');
  });

  it('reports a start that fails and does not keep trying by itself', async () => {
    const failing = new LiveEngine({ access: async () => { throw new Error('Sign in again to start a live session.'); }, openSocket: () => { throw new Error('unused'); } });
    const started = failing.start(setup());
    const outcome = started.then(() => 'started', error => (error as Error).message);
    await flush(0);
    expect(await outcome).toContain('Sign in again');
    expect(failing.snapshot().status).toBe('error');
  });
});
