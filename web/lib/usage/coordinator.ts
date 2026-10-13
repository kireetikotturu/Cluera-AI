import {randomUUID} from 'node:crypto';
import type {usageService} from './service';

type Service = ReturnType<typeof usageService>;
type Command = Parameters<Service['command']>[1];
type Reply = Awaited<ReturnType<Service['command']>>;
type State = 'idle'|'starting'|'active'|'stopped';

/** Server-owned active-work lifetime, used by the isolated staging account relay.
 * command must close over a verified account/session and the staging usageService.
 * Adapters must abort upstream work on signal AND call assertActive before accepting
 * input/emitting output (timers alone cannot enforce a stalled event loop).
 * Multiple provider requests in ONE session share this coordinator, not one debit
 * per audio/text channel. A separate concurrent session owns a separate run.
 */
export function createUsageCoordinator(command:(input:Command)=>Promise<Reply>,
  options:{signal?:AbortSignal;monotonic?:()=>number}={}) {
  const runId=randomUUID(),abort=new AbortController(),now=options.monotonic??(()=>performance.now());
  let state:State='idle',sequence=-1,deadline=0,pending=false,uncertain=false,stopSent=false;
  let deadlineTimer:ReturnType<typeof setTimeout>|undefined,renewTimer:ReturnType<typeof setTimeout>|undefined;
  const error=()=>new Error('Account usage unavailable.');
  function clear(){clearTimeout(deadlineTimer);clearTimeout(renewTimer);deadlineTimer=undefined;renewTimer=undefined;}
  function settle(){
    if(pending||uncertain||sequence<0||stopSent)return;
    stopSent=true;
    // Best effort, once, only after an acknowledged sequence. Unknown RPC outcomes
    // expire at their bounded server reservation; never guess/replay a financial write.
    void Promise.resolve().then(()=>command({runId,sequence:sequence+1,action:'STOP'})).catch(()=>undefined);
  }
  function stop(){
    if(state==='stopped')return;
    state='stopped';clear();options.signal?.removeEventListener('abort',stop);
    abort.abort();settle();
  }
  function assertActive(){
    const time=now();
    if(state!=='active'||!Number.isFinite(time)||time>=deadline){stop();throw error();}
  }
  async function request(action:'START'|'CHECKPOINT') {
    if(pending||state==='stopped')return;
    pending=true;uncertain=true;
    const next=sequence+1;
    try {
      const reply=await command({runId,sequence:next,action});
      if(reply.code!=='ACTIVE'){uncertain=false;stop();return;}
      if(reply.runId!==runId||reply.sequence!==next||!Number.isFinite(reply.validForMilliseconds)
        ||reply.validForMilliseconds<=0||reply.validForMilliseconds>30000){stop();return;}
      sequence=next;uncertain=false;
      // A late renewal must never resurrect a closed session or extend its expired grant.
      if(abort.signal.aborted)return;
      const time=now();
      if(!Number.isFinite(time)||time>=deadline){stop();return;}
      clear();deadline=time+reply.validForMilliseconds;state='active';
      deadlineTimer=setTimeout(stop,reply.validForMilliseconds);
      if(reply.validForMilliseconds>1000)renewTimer=setTimeout(()=>{
        try{assertActive();void request('CHECKPOINT');}catch{/* already stopped */}
      },Math.min(20000,Math.max(1000,reply.validForMilliseconds-5000)));
    } catch {stop();}
    finally {pending=false;if(abort.signal.aborted)settle();}
  }
  options.signal?.addEventListener('abort',stop,{once:true});
  if(options.signal?.aborted)stop();
  return {
    signal:abort.signal,
    assertActive,
    stop,
    async start(){
      if(state!=='idle')throw error();
      const time=now();if(!Number.isFinite(time)){stop();throw error();}
      state='starting';deadline=time+10000;deadlineTimer=setTimeout(stop,10000);
      // An unresponsive START must not hang the caller or ever authorize provider work.
      let onAbort!:()=>void;
      const cancelled=new Promise<void>(resolve=>{onAbort=resolve;abort.signal.addEventListener('abort',onAbort,{once:true});});
      try{await Promise.race([request('START'),cancelled]);assertActive();}
      finally{abort.signal.removeEventListener('abort',onAbort);}
    },
  };
}
