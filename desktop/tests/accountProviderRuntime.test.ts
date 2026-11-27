import { afterEach, expect, it, vi } from 'vitest';
import { AccountProviderRuntime } from '../src/main/accounts/AccountProviderRuntime';
import type { RelayOutput, StagingRelayConnection } from '../src/main/accounts/StagingRelayClient';
import type { AudioSourceDescriptor } from '../src/shared/types';
const interviewer: AudioSourceDescriptor = { id: 'system', kind: 'system', role: 'remote_interviewer', label: 'System', canTriggerAnswers: true };
const candidate: AudioSourceDescriptor = { id:'mic',kind:'microphone',role:'local_candidate',label:'You',canTriggerAnswers:false };
const runtimes: AccountProviderRuntime[] = [];
function fixture() {
  const owner = new AbortController(), connectionOwner = new AbortController();
  const connection: StagingRelayConnection = {signal:connectionOwner.signal,send:vi.fn(),writeAudio:vi.fn(),stop:vi.fn(()=>connectionOwner.abort())};
  let receive!: (event: RelayOutput) => void;
  const authorizeWork = vi.fn(async()=>({accessToken:'synthetic-account-token',signal:owner.signal}));
  const connect = vi.fn(async (_token: string, signal: AbortSignal, callback: (event: RelayOutput)=>void) => {
    receive = callback; signal.addEventListener('abort',()=>connectionOwner.abort(),{once:true}); return connection;
  });
  const stopped = vi.fn(), activity=vi.fn(), runtime = new AccountProviderRuntime({authorizeWork}, connect, stopped,undefined,activity); runtimes.push(runtime);
  return {owner,connectionOwner,connection,connect,authorizeWork,runtime,stopped,activity,receive:(event:RelayOutput)=>receive(event)};
}
const body = JSON.stringify({contents:[{role:'user',parts:[{text:'Synthetic interview prompt'}]}],generationConfig:{maxOutputTokens:1000}});
afterEach(()=>{runtimes.splice(0).forEach(runtime=>runtime.stop());vi.useRealTimers();});
it('reports one actual provider owner, not separate text/audio charges, and stops reporting when idle',async()=>{
 const f=fixture();const response=await f.runtime.generate(body,new AbortController().signal);
 const command=(f.connection.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
 expect(f.activity.mock.calls).toEqual([[true]]);
 f.receive({type:'answerDone',id:command.id});await response.text();expect(f.activity.mock.calls).toEqual([[true],[false]]);
 f.runtime.stop();expect(f.activity).toHaveBeenCalledTimes(2);
});
it('shares one connection across Gemini and two audio sources and waits for authenticated audio readiness', async()=>{
  const f=fixture(), a=f.runtime.recognizer(interviewer), b=f.runtime.recognizer(candidate);
  const aReady=a.start(), bReady=b.start();
  await vi.waitFor(()=>expect(f.connection.send).toHaveBeenCalledTimes(2));
  a.sendAudio(Buffer.alloc(2560));expect(f.connection.writeAudio).not.toHaveBeenCalled();
  f.receive({type:'audioReady',channel:'interviewer'});f.receive({type:'audioReady',channel:'candidate'});await Promise.all([aReady,bReady]);
  a.sendAudio(Buffer.alloc(2560));b.sendAudio(Buffer.alloc(2560));expect(f.connection.writeAudio).toHaveBeenCalledTimes(2);
  const response=await f.runtime.generate(body,new AbortController().signal);
  const command=vi.mocked(f.connection.send).mock.calls.at(-1)![0];expect(command.type).toBe('generate');
  expect(f.connect).toHaveBeenCalledOnce();expect(f.authorizeWork).toHaveBeenCalledOnce();
  if(command.type!=='generate')throw new Error('Expected generate');
  f.receive({type:'answer',id:command.id,text:'A useful answer.'});f.receive({type:'answerDone',id:command.id});
  expect(await response.text()).toContain('A useful answer.');
  f.runtime.stop();expect(f.connection.stop).toHaveBeenCalled();
});
it('retains speaker metadata and never triggers answers from candidate speech',async()=>{
  const f=fixture(), speech=f.runtime.recognizer(candidate), final=vi.fn(), turn=vi.fn();
  speech.onFinalTranscript(final);speech.onTurnEvent(turn);const ready=speech.start();
  await vi.waitFor(()=>expect(f.connection.send).toHaveBeenCalled());f.receive({type:'audioReady',channel:'candidate'});await ready;
  f.receive({type:'transcript',channel:'candidate',event:'EndOfTurn',transcript:'A candidate answer'});
  expect(final).toHaveBeenCalledWith(expect.objectContaining({text:'A candidate answer',canTriggerAnswers:false,sourceRole:'local_candidate'}));
  expect(turn).toHaveBeenCalledWith(expect.objectContaining({type:'end',canTriggerAnswers:false}));await speech.stop();
  f.receive({type:'transcript',channel:'candidate',event:'EndOfTurn',transcript:'late'});expect(final).toHaveBeenCalledOnce();
});
it('sends screenshot and prompt context but no URL, key or caller provider settings',async()=>{
  const f=fixture();const response=await f.runtime.generate(JSON.stringify({contents:[{role:'user',parts:[{text:'Screenshot context'},{inlineData:{mimeType:'image/png',data:'cG5n'}}]}],generationConfig:{model:'ignored'}}),new AbortController().signal);
  expect(f.connection.send).toHaveBeenCalledWith(expect.objectContaining({type:'generate',prompt:'Screenshot context',image:{mimeType:'image/png',data:'cG5n'}}));
  expect(JSON.stringify(vi.mocked(f.connection.send).mock.calls)).not.toContain('ignored');await response.body!.cancel();
  expect(f.connection.stop).toHaveBeenCalled();expect(f.connection.signal.aborted).toBe(true);
});
it('aborts in-flight generation and audio ownership on logout/expiry, with no replay or reconnect',async()=>{
  const f=fixture();const response=await f.runtime.generate(body,new AbortController().signal);const result=response.text();
  f.owner.abort();await expect(result).rejects.toThrow('Account provider session ended.');
  expect(f.stopped).toHaveBeenCalledOnce();expect(f.connect).toHaveBeenCalledOnce();
});
it('drops late callbacks for cancelled generation and allows a deliberate new question',async()=>{
  const f=fixture(), abort=new AbortController(), speech=f.runtime.recognizer(interviewer);
  const ready=speech.start();await vi.waitFor(()=>expect(f.connection.send).toHaveBeenCalled());f.receive({type:'audioReady',channel:'interviewer'});await ready;
  const first=await f.runtime.generate(body,abort.signal);
  const old=vi.mocked(f.connection.send).mock.calls.at(-1)![0];if(old.type!=='generate')throw new Error('Expected generate');
  const oldResult=first.text();abort.abort();await expect(oldResult).rejects.toThrow();
  f.receive({type:'answerDone',id:old.id});
  const next=await f.runtime.generate(body,new AbortController().signal), command=vi.mocked(f.connection.send).mock.calls.at(-1)![0];
  if(command.type!=='generate')throw new Error('Expected generate');
  f.receive({type:'answer',id:old.id,text:'OLD'});f.receive({type:'answer',id:command.id,text:'NEW'});f.receive({type:'answerDone',id:command.id});
  expect(await next.text()).not.toContain('OLD');expect(f.connect).toHaveBeenCalledOnce();
});
it('prevents late authorization/open from reviving a stopped session',async()=>{
  const f=fixture();let finish!:()=>void;
  f.authorizeWork.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {accessToken:'synthetic-account-token',signal:f.owner.signal};});
  const opening=f.runtime.generate(body,new AbortController().signal);f.runtime.stop();finish();
  await expect(opening).rejects.toThrow();expect(f.connect).not.toHaveBeenCalled();
});
it('bounds an unconsumed response and cancels the upstream request',async()=>{
  const f=fixture(), response=await f.runtime.generate(body,new AbortController().signal);
  const command=vi.mocked(f.connection.send).mock.calls[0][0];if(command.type!=='generate')throw new Error('Expected generate');
  for(let i=0;i<4;i++)f.receive({type:'answer',id:command.id,text:'x'.repeat(128000)});
  await expect(response.text()).rejects.toThrow();expect(f.connection.stop).toHaveBeenCalled();expect(f.connection.signal.aborted).toBe(true);
});
it('does not retry a timed-out audio connection or buffer pre-ready PCM',async()=>{
  vi.useFakeTimers();const f=fixture(), speech=f.runtime.recognizer(interviewer);const ready=speech.start();
  const failure=expect(ready).rejects.toThrow();await vi.advanceTimersByTimeAsync(30001);await failure;
  speech.sendAudio(Buffer.alloc(2560));expect(f.connection.writeAudio).not.toHaveBeenCalled();expect(f.connect).toHaveBeenCalledOnce();
});
it('releases the reservation if the first generation send fails',async()=>{
  const f=fixture();vi.mocked(f.connection.send).mockImplementationOnce(()=>{throw new Error('Synthetic send failure');});
  const response=await f.runtime.generate(body,new AbortController().signal);
  await expect(response.text()).rejects.toThrow('Account provider session ended.');
  expect(f.connection.stop).toHaveBeenCalledOnce();expect(f.connect).toHaveBeenCalledOnce();
});
it('releases an idle connection when the question is cancelled during authorization',async()=>{
  const f=fixture(),abort=new AbortController();let finish!:()=>void;
  f.authorizeWork.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {accessToken:'synthetic-account-token',signal:f.owner.signal};});
  const result=f.runtime.generate(body,abort.signal);abort.abort();finish();
  await expect(result).rejects.toThrow();expect(f.connection.send).not.toHaveBeenCalled();expect(f.connection.stop).toHaveBeenCalledOnce();
});
it('releases the reservation if the first audio-open send fails',async()=>{
  const f=fixture();vi.mocked(f.connection.send).mockImplementationOnce(()=>{throw new Error('Synthetic send failure');});
  await expect(f.runtime.openAudio('interviewer',()=>undefined,new AbortController().signal)).rejects.toThrow();
  expect(f.connection.stop).toHaveBeenCalledOnce();
});
it('injects selected fresh context before opening provider usage and fails closed on context sync failure',async()=>{
 const owner=new AbortController(),connect=vi.fn(),account={authorizeWork:vi.fn(async()=>({accessToken:'synthetic',signal:owner.signal}))};
 const missing=vi.fn(async()=>{throw Error('Synthetic context unavailable');});
 const runtime=new AccountProviderRuntime(account,connect,()=>undefined,missing);runtimes.push(runtime);
 await expect(runtime.generate(body,owner.signal)).rejects.toThrow();expect(connect).not.toHaveBeenCalled();expect(account.authorizeWork).not.toHaveBeenCalled();
 const controller=new AbortController(),send=vi.fn(),connection={signal:controller.signal,send,writeAudio:vi.fn(),stop:vi.fn(()=>controller.abort())};
 const fresh=vi.fn(async(prompt:string)=>prompt+'\nSelected fresh source');
 const valid=new AccountProviderRuntime(account,async()=>connection,()=>undefined,fresh);runtimes.push(valid);
 const screenshotBody=JSON.stringify({contents:[{role:'user',parts:[{text:'Synthetic interview prompt'},{inlineData:{mimeType:'image/png',data:'cG5n'}}]}]});
 const response=await valid.generate(screenshotBody,owner.signal);expect(send).toHaveBeenCalledWith(expect.objectContaining({prompt:'Synthetic interview prompt\nSelected fresh source',image:{mimeType:'image/png',data:'cG5n'}}));
 await response.body!.cancel();
});
it.each([[800, true], [100, true], [4000, true], [50, false], [5000, false], [1.5, false], ['many', false], [undefined, false]])(
  'passes a sensible answer-length limit (%s) to the server: %s', async (limit, passed) => {
    const f = fixture();
    const response = await f.runtime.generate(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Synthetic interview prompt' }] }], generationConfig: { maxOutputTokens: limit } }), new AbortController().signal);
    const command = vi.mocked(f.connection.send).mock.calls.at(-1)![0];
    if (command.type !== 'generate') throw new Error('Expected generate');
    if (passed) expect(command.maxTokens).toBe(limit); else expect('maxTokens' in command).toBe(false);
    f.receive({ type: 'answerDone', id: command.id }); await response.text();
  });
/** An account that can say how much time it has left. */
function timedFixture(left: () => number | undefined) {
  const owner = new AbortController();
  const connections: Array<{ connection: StagingRelayConnection; lifetime: AbortController; receive(event: RelayOutput): void }> = [];
  const connect = vi.fn(async (_token: string, signal: AbortSignal, callback: (event: RelayOutput) => void) => {
    const lifetime = new AbortController();
    const connection: StagingRelayConnection = { signal: lifetime.signal, send: vi.fn(), writeAudio: vi.fn(), stop: vi.fn(() => lifetime.abort()) };
    signal.addEventListener('abort', () => lifetime.abort(), { once: true });
    connections.push({ connection, lifetime, receive: callback });
    return connection;
  });
  const account = { authorizeWork: vi.fn(async () => ({ accessToken: 'synthetic-account-token', signal: owner.signal })), remainingMilliseconds: vi.fn(async () => left()) };
  const stopped = vi.fn(), notify = vi.fn();
  const runtime = new AccountProviderRuntime(account, connect, stopped, undefined, () => undefined, notify, [5, 5, 5]); runtimes.push(runtime);
  return { runtime, connections, connect, account, stopped, notify };
}
it('ends with "time used up", not a reconnect, when the account has no time left', async () => {
  const f = timedFixture(() => 0), speech = f.runtime.recognizer(interviewer), errors: Error[] = [];
  speech.onError(error => errors.push(error));
  const ready = speech.start(); await vi.waitFor(() => expect(f.connections).toHaveLength(1));
  await vi.waitFor(() => expect(f.connections[0].connection.send).toHaveBeenCalled());
  f.connections[0].receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  f.connections[0].lifetime.abort();                       // the service ends the connection: no time left
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('exhausted'));
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.stopped).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalledWith('failed'); expect(errors).toHaveLength(1);
});
it('also says the time is used up when a session cannot even start, without waiting for a time-out', async () => {
  const f = timedFixture(() => 200), speech = f.runtime.recognizer(interviewer);
  const starting = expect(speech.start()).rejects.toThrow('Account provider session ended.');
  await vi.waitFor(() => expect(f.connections[0]?.connection.send).toHaveBeenCalled());
  f.connections[0].lifetime.abort();
  await starting;
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('exhausted'));
});
it.each([[600_000], [undefined]])('reconnects as before while time is left (%s) or cannot be read', async left => {
  const f = timedFixture(() => left), speech = f.runtime.recognizer(interviewer);
  const ready = speech.start(); await vi.waitFor(() => expect(f.connections[0]?.connection.send).toHaveBeenCalled());
  f.connections[0].receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  f.connections[0].lifetime.abort();
  expect(f.notify).toHaveBeenCalledWith('reconnecting');
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('restored'));
  expect(f.notify).not.toHaveBeenCalledWith('exhausted');
});
it('says the time is used up when a typed question finds no time left', async () => {
  const f = timedFixture(() => 0);
  const response = await f.runtime.generate(body, new AbortController().signal);
  const reading = expect(response.text()).rejects.toThrow('Account provider session ended.');
  f.connections[0].lifetime.abort(); await reading;
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('exhausted'));
});
it('keeps an open channel alive with silence while no sound arrives, and stays quiet while sound flows', async () => {
  vi.useFakeTimers();
  const f = fixture(), speech = f.runtime.recognizer(interviewer), ready = speech.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.connection.send).toHaveBeenCalled(); f.receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  const written = () => vi.mocked(f.connection.writeAudio).mock.calls;
  await vi.advanceTimersByTimeAsync(1_000); expect(written()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2_000); expect(written().length).toBeGreaterThanOrEqual(1);
  const [channel, silence] = written()[0];
  expect(channel).toBe('interviewer'); expect(silence).toHaveLength(2_560); expect(silence.every(byte => byte === 0)).toBe(true);
  const before = written().length;
  for (let second = 0; second < 6; second++) { speech.sendAudio(Buffer.alloc(2560, 1)); await vi.advanceTimersByTimeAsync(1_000); }
  expect(written().length).toBe(before + 6);                // only the real sound
  await speech.stop(); const after = written().length;
  await vi.advanceTimersByTimeAsync(10_000); expect(written().length).toBe(after);
});
it('fails only the one answer, in plain words, and leaves the live audio session running', async () => {
  const f = fixture(), speech = f.runtime.recognizer(interviewer), ready = speech.start();
  await vi.waitFor(() => expect(f.connection.send).toHaveBeenCalled()); f.receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  const response = await f.runtime.generate(body, new AbortController().signal);
  const command = vi.mocked(f.connection.send).mock.calls.at(-1)![0];
  if (command.type !== 'generate') throw new Error('Expected generate');
  f.receive({ type: 'answer', id: command.id, text: 'Partial ' });
  f.receive({ type: 'answerFailed', id: command.id });
  await expect(response.text()).rejects.toThrow('The AI model could not answer this time.');
  expect(f.connection.signal.aborted).toBe(false); expect(f.stopped).not.toHaveBeenCalled();
  f.receive({ type: 'answerFailed', id: 'some-other-answer' }); // a stale/foreign id changes nothing
  expect(f.connection.signal.aborted).toBe(false);
});

// Follow-up questions, mostly while a session is starting: each of these used to fail with "session ended".
const generateCommands = (connection: StagingRelayConnection) => vi.mocked(connection.send).mock.calls
  .map(call => call[0]).flatMap(command => command.type === 'generate' ? [command] : []);
async function liveAudio(f: ReturnType<typeof fixture>) {
  const speech = f.runtime.recognizer(interviewer), ready = speech.start();
  await vi.waitFor(() => expect(f.connection.send).toHaveBeenCalled());
  f.receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
}
it('lets a follow-up replace a question whose connection is still being set up', async () => {
  const f = fixture(), first = new AbortController(); let finish!: () => void;
  f.authorizeWork.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { accessToken: 'synthetic-account-token', signal: f.owner.signal }; });
  const replaced = expect(f.runtime.generate(body, first.signal)).rejects.toThrow();
  first.abort();
  const next = f.runtime.generate(body, new AbortController().signal);
  await replaced; finish();                       // the replaced one leaves at once, before the connection is ready
  const response = await next;
  expect(f.connect).toHaveBeenCalledOnce(); expect(f.connection.stop).not.toHaveBeenCalled();
  expect(generateCommands(f.connection)).toHaveLength(1);
  f.receive({ type: 'answerDone', id: generateCommands(f.connection)[0].id }); await response.text();
});
it('lets a follow-up replace a question that is still loading the saved documents', async () => {
  const owner = new AbortController(), lifetime = new AbortController(), send = vi.fn();
  const connection = { signal: lifetime.signal, send, writeAudio: vi.fn(), stop: vi.fn(() => lifetime.abort()) };
  const waits: Array<() => void> = [];
  const context = (prompt: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    waits.push(() => resolve(prompt)); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const runtime = new AccountProviderRuntime({ authorizeWork: async () => ({ accessToken: 'synthetic-account-token', signal: owner.signal }) },
    async () => connection, () => undefined, context); runtimes.push(runtime);
  const first = new AbortController(), replaced = expect(runtime.generate(body, first.signal)).rejects.toThrow();
  first.abort();                                  // the same moment the next question is asked
  const next = runtime.generate(body, new AbortController().signal);
  await replaced; await vi.waitFor(() => expect(waits).toHaveLength(2)); waits[1]();
  await next; expect(generateCommands(connection)).toHaveLength(1);
});
it('keeps only one question at a time unless the earlier one was replaced', async () => {
  const f = fixture(); let finish!: () => void;
  f.authorizeWork.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { accessToken: 'synthetic-account-token', signal: f.owner.signal }; });
  const first = f.runtime.generate(body, new AbortController().signal);
  await expect(f.runtime.generate(body, new AbortController().signal)).rejects.toThrow();
  finish(); await first; expect(generateCommands(f.connection)).toHaveLength(1);
});
it('does not refuse a third question while the service is still confirming a cancellation', async () => {
  const f = fixture(); await liveAudio(f);
  const first = new AbortController(), second = new AbortController();
  const reading = expect((await f.runtime.generate(body, first.signal)).text()).rejects.toThrow();
  first.abort(); await reading;
  const replaced = expect(f.runtime.generate(body, second.signal)).rejects.toThrow();
  second.abort(); await replaced;
  const third = f.runtime.generate(body, new AbortController().signal);
  f.receive({ type: 'answerDone', id: generateCommands(f.connection)[0].id });   // the cancellation is confirmed
  await third; expect(generateCommands(f.connection)).toHaveLength(2); expect(f.connection.stop).not.toHaveBeenCalled();
}, 10_000);
it('treats an answer that failed just as it was cancelled as stopped, without dropping the connection', async () => {
  const f = fixture(); await liveAudio(f);
  const first = new AbortController();
  const reading = expect((await f.runtime.generate(body, first.signal)).text()).rejects.toThrow();
  first.abort(); await reading;
  const next = f.runtime.generate(body, new AbortController().signal);
  f.receive({ type: 'answerFailed', id: generateCommands(f.connection)[0].id });
  await next; expect(generateCommands(f.connection)).toHaveLength(2); expect(f.connection.stop).not.toHaveBeenCalled();
});
it('sends the next question on a new connection when a cancellation is never confirmed', async () => {
  const f = timedFixture(() => 600_000), speech = f.runtime.recognizer(interviewer), ready = speech.start();
  await vi.waitFor(() => expect(f.connections[0]?.connection.send).toHaveBeenCalled());
  f.connections[0].receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  const first = new AbortController();
  const reading = expect((await f.runtime.generate(body, first.signal)).text()).rejects.toThrow();
  first.abort(); await reading;
  await f.runtime.generate(body, new AbortController().signal);        // waits for the 5 s confirmation limit
  expect(f.connections[0].connection.stop).toHaveBeenCalled();
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledWith('restored'));
  expect(generateCommands(f.connections[1].connection)).toHaveLength(1);
}, 15_000);
it('keeps the audio that is still connecting when a typed question is replaced', async () => {
  const f = fixture(), first = new AbortController(); let finish!: () => void;
  f.authorizeWork.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { accessToken: 'synthetic-account-token', signal: f.owner.signal }; });
  const replaced = expect(f.runtime.generate(body, first.signal)).rejects.toThrow();
  const speech = f.runtime.recognizer(interviewer), ready = speech.start();
  first.abort(); await replaced; finish();
  await vi.waitFor(() => expect(f.connection.send).toHaveBeenCalledWith({ type: 'openAudio', channel: 'interviewer' }));
  f.receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  expect(f.connection.stop).not.toHaveBeenCalled();
});
it.each([400, 2_200])('waits a full second after a first reply %i ms late before a follow-up, so a slow network cannot end the session', async late => {
  const f = fixture(); await liveAudio(f);
  const first = new AbortController();
  const reading = expect((await f.runtime.generate(body, first.signal)).text()).rejects.toThrow();
  await new Promise(resolve => setTimeout(resolve, late));
  const id = generateCommands(f.connection)[0].id;
  f.receive({ type: 'answer', id, text: 'part' }); const repliedAt = performance.now();
  first.abort(); await reading; f.receive({ type: 'answerDone', id });
  await f.runtime.generate(body, new AbortController().signal);
  expect(performance.now() - repliedAt).toBeGreaterThanOrEqual(990);
}, 10_000);
it('says the connection dropped, not that the session ended, when audio is being restored', async () => {
  const f = timedFixture(() => 600_000), speech = f.runtime.recognizer(interviewer), ready = speech.start();
  await vi.waitFor(() => expect(f.connections[0]?.connection.send).toHaveBeenCalled());
  f.connections[0].receive({ type: 'audioReady', channel: 'interviewer' }); await ready;
  const reading = expect((await f.runtime.generate(body, new AbortController().signal)).text()).rejects.toThrow('The connection dropped');
  f.connections[0].lifetime.abort(); await reading;
});
it('says why a question could not be sent when the service cannot be reached', async () => {
  const f = fixture(); f.connect.mockRejectedValueOnce(new Error('offline'));
  await expect(f.runtime.generate(body, new AbortController().signal)).rejects.toThrow('Cluera could not be reached');
});
