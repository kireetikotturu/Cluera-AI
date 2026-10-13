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
