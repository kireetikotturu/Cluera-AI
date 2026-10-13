import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {createUsageCoordinator} from '../lib/usage/coordinator';
type Command=Parameters<Parameters<typeof createUsageCoordinator>[0]>[0];
const grant=(input:Command,duration=30000)=>({code:'ACTIVE' as const,runId:input.runId,sequence:input.sequence,
  serverTime:'2026-10-04T00:00:00Z',expiresAt:'2026-10-04T00:00:30Z',reservedMilliseconds:duration,
  allocation:'TRIAL' as const,validForMilliseconds:duration});
const closed={code:'CLOSED' as const};
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
let time=0;
beforeEach(()=>{time=0;vi.useFakeTimers();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
async function advance(ms:number){time+=ms;await vi.advanceTimersByTimeAsync(ms);}

describe('server-owned usage coordinator, not publicly enabled',()=>{
  it('does no work before START; owns one run across providers and settles once on STOP',async()=>{
    const command=vi.fn(async(input:Command)=>input.action==='STOP'?closed:grant(input));
    const run=createUsageCoordinator(command,{monotonic:()=>time});
    expect(command).not.toHaveBeenCalled();await run.start();run.assertActive();run.assertActive();
    expect(command).toHaveBeenCalledOnce();
    await advance(20000);expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[1][0]).toMatchObject({sequence:1,action:'CHECKPOINT'});
    expect(command.mock.calls[0][0].runId).toBe(command.mock.calls[1][0].runId);
    run.stop();run.stop();await advance(1);
    expect(run.signal.aborted).toBe(true);expect(command).toHaveBeenCalledTimes(3);
    expect(command.mock.calls[2][0]).toMatchObject({sequence:2,action:'STOP'});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts at the old deadline while a checkpoint hangs; late success cannot resurrect work',async()=>{
    const wait=deferred<ReturnType<typeof grant>>();
    const command=vi.fn(async(input:Command)=>input.action==='START'?grant(input):input.action==='CHECKPOINT'?wait.promise:closed);
    const run=createUsageCoordinator(command,{monotonic:()=>time});await run.start();await advance(20000);
    await advance(10000);expect(run.signal.aborted).toBe(true);expect(()=>run.assertActive()).toThrow();
    expect(command).toHaveBeenCalledTimes(2);
    wait.resolve(grant(command.mock.calls[1][0]));await advance(0);
    expect(command).toHaveBeenCalledTimes(3);expect(command.mock.calls[2][0]).toMatchObject({action:'STOP',sequence:2});
    expect(()=>run.assertActive()).toThrow();expect(vi.getTimerCount()).toBe(0);
  });
  it('stops synchronously on disconnect and serializes settlement behind an in-flight checkpoint',async()=>{
    const wait=deferred<ReturnType<typeof grant>>(),external=new AbortController();
    const command=vi.fn(async(input:Command)=>input.action==='START'?grant(input):input.action==='CHECKPOINT'?wait.promise:closed);
    const run=createUsageCoordinator(command,{signal:external.signal,monotonic:()=>time});await run.start();await advance(20000);
    external.abort();expect(run.signal.aborted).toBe(true);expect(command).toHaveBeenCalledTimes(2);
    wait.resolve(grant(command.mock.calls[1][0]));await advance(0);
    expect(command.mock.calls.map(([c])=>c.action)).toEqual(['START','CHECKPOINT','STOP']);
  });
  it('fails closed on checkpoint failure without guessing the unknown committed sequence',async()=>{
    const command=vi.fn(async(input:Command)=>{if(input.action==='CHECKPOINT')throw Error('synthetic private error');return grant(input);});
    const run=createUsageCoordinator(command,{monotonic:()=>time});await run.start();await advance(20000);
    expect(run.signal.aborted).toBe(true);expect(command).toHaveBeenCalledTimes(2);
    await advance(60000);expect(command).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds hanging START, cleans up a late grant, and never opens access',async()=>{
    const wait=deferred<ReturnType<typeof grant>>();
    const command=vi.fn(async(input:Command)=>input.action==='START'?wait.promise:closed);
    const run=createUsageCoordinator(command,{monotonic:()=>time});const start=expect(run.start()).rejects.toThrow('Account usage unavailable');
    await advance(10000);await start;expect(run.signal.aborted).toBe(true);
    wait.resolve(grant(command.mock.calls[0][0]));await advance(0);
    expect(command.mock.calls.map(([c])=>c.action)).toEqual(['START','STOP']);
  });
  it.each(['EXHAUSTED','SUSPENDED','UNAUTHENTICATED'] as const)('never opens provider access when START returns %s',async code=>{
    const command=vi.fn(async()=>({code}));const run=createUsageCoordinator(command,{monotonic:()=>time});
    await expect(run.start()).rejects.toThrow('Account usage unavailable');expect(run.signal.aborted).toBe(true);
    expect(command).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('handles a sub-second final budget without rapid renewal loops',async()=>{
    const command=vi.fn(async(input:Command)=>input.action==='STOP'?closed:grant(input,800));
    const run=createUsageCoordinator(command,{monotonic:()=>time});await run.start();await advance(800);
    expect(run.signal.aborted).toBe(true);expect(command.mock.calls.map(([c])=>c.action)).toEqual(['START','STOP']);
  });
  it('blocks output after a stalled event loop before the deadline timer gets CPU',async()=>{
    const command=vi.fn(async(input:Command)=>input.action==='STOP'?closed:grant(input));
    const run=createUsageCoordinator(command,{monotonic:()=>time});await run.start();time=30001;
    expect(()=>run.assertActive()).toThrow();expect(run.signal.aborted).toBe(true);
    await advance(0);expect(vi.getTimerCount()).toBe(0);
  });
  it('enforces the START timeout even if its timer is delayed by the event loop',async()=>{
    const wait=deferred<ReturnType<typeof grant>>();
    const command=vi.fn(async(input:Command)=>input.action==='START'?wait.promise:closed);
    const run=createUsageCoordinator(command,{monotonic:()=>time});const started=expect(run.start()).rejects.toThrow();
    time=11000;wait.resolve(grant(command.mock.calls[0][0]));await started;await advance(0);
    expect(run.signal.aborted).toBe(true);expect(command.mock.calls.map(([c])=>c.action)).toEqual(['START','STOP']);
  });
  it('does not spend on an already disconnected client or duplicate START',async()=>{
    const external=new AbortController();external.abort();const command=vi.fn(async(input:Command)=>grant(input));
    const cancelled=createUsageCoordinator(command,{signal:external.signal});await expect(cancelled.start()).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
    const run=createUsageCoordinator(command,{monotonic:()=>time});await run.start();await expect(run.start()).rejects.toThrow();
    expect(command).toHaveBeenCalledOnce();run.stop();
  });
  it('rejects malformed duration or mismatched authorization instead of renewing access',async()=>{
    for(const change of [{validForMilliseconds:Infinity},{validForMilliseconds:0},{validForMilliseconds:30001},{sequence:9},{runId:'wrong'}]){
      const command=vi.fn(async(input:Command)=>({...grant(input),...change}));
      const run=createUsageCoordinator(command,{monotonic:()=>time});await expect(run.start()).rejects.toThrow();
      expect(run.signal.aborted).toBe(true);expect(command).toHaveBeenCalledOnce();
    }
  });
  it('gives concurrent sessions independent run IDs, never a shared client-supplied identity',async()=>{
    const command=vi.fn(async(input:Command)=>input.action==='STOP'?closed:grant(input));
    const a=createUsageCoordinator(command,{monotonic:()=>time}),b=createUsageCoordinator(command,{monotonic:()=>time});
    await Promise.all([a.start(),b.start()]);expect(command.mock.calls[0][0].runId).not.toBe(command.mock.calls[1][0].runId);
    a.stop();b.stop();await advance(0);expect(command).toHaveBeenCalledTimes(4);
  });
});
