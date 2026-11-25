import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({peers:[] as any[],events:[] as string[]}));
vi.mock('ws',async()=>{
 const {EventEmitter}=await import('node:events');
 class Peer extends EventEmitter{
  static OPEN=1;readyState=0;bufferedAmount=0;send=vi.fn();
  constructor(){super();fixture.peers.push(this);fixture.events.push('upstream');}
  terminate(){this.readyState=3;this.emit('close');}
 }
 return {default:Peer};
});
import {vaultProviders} from '../lib/accountRelay/vaultProviders';
import {vaultKeyring} from '../lib/aiProviders/vault';
import type {RelayConfig} from '../lib/accountRelay/config';
const credential=randomUUID(),run=randomUUID(),secret='synthetic-deepgram-key-only';
const env={CLUERA_PROVIDER_TELEMETRY_ENABLED:'true',CLUERA_PROVIDER_VAULT_KEYRING_BASE64:Buffer.from(JSON.stringify({active:'synthetic',keys:{synthetic:Buffer.alloc(32,23).toString('base64')}})).toString('base64')};
const sealed=vaultKeyring(env).seal(secret,{provider:'deepgram',credentialId:credential});
beforeEach(()=>{fixture.peers=[];fixture.events=[];});
afterEach(()=>{for(const peer of fixture.peers)peer.terminate();});
function setup(start?:(args:Record<string,unknown>)=>Promise<unknown>){
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='cluera_provider_read')return {provider:'deepgram',revision:1,credential_id:credential,sealed,enabled:true,default_model:'flux-general-en',probe_status:'VERIFIED',probe_at:'2026-10-19T00:00:00Z',models:[{id:'flux-general-en',runtimeCompatible:true}],complete:true,updated_at:'2026-10-19T00:00:00Z'};
  if(name==='account_models_read')return [{modelId:'flux-general-en',displayName:'Flux',provider:'deepgram',enabled:true,isDefault:true,priority:1,capabilities:['audio'],health:'HEALTHY'}];
  fixture.events.push(name);if(name==='cluera_provider_usage_start'&&start)return start(args);
  return {code:'RECORDED',operationId:args.p_operation};
 });
 const owner=new AbortController(),failed=vi.fn(),ready=vi.fn(),emit=vi.fn();
 const config={serviceKey:'synthetic-service-key',rateKey:'synthetic-rate-key',providerMode:'admin-vault'} as RelayConfig;
 const audio=vaultProviders(config,rpc,env).audio({runId:run,signal:owner.signal,assertActive(){if(owner.signal.aborted)throw Error();}},emit,failed,ready);
 return {rpc,owner,failed,ready,audio};
}
it('records the audio sent and one stopped receipt without persisting speech',async()=>{
 const h=setup();await vi.waitFor(()=>expect(fixture.peers).toHaveLength(1));const peer=fixture.peers[0];
 await vi.waitFor(()=>expect(fixture.events).toContain('cluera_provider_usage_start'));
 peer.readyState=1;peer.emit('open');expect(h.ready).toHaveBeenCalledOnce();
 h.audio.write(Buffer.alloc(3200));h.audio.write(Buffer.alloc(3200));
 peer.emit('message',Buffer.from(JSON.stringify({type:'TurnInfo',request_id:'synthetic-request-id',event:'EndOfTurn',transcript:'private speech',audio_window_end:1.25})));
 h.audio.close();h.audio.close();await vi.waitFor(()=>expect(h.rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_finish')).toBe(true));
 const records=h.rpc.mock.calls.filter(([name])=>name.startsWith('cluera_provider_usage'));
 expect(records).toHaveLength(2);expect(records[1][1]).toMatchObject({p_outcome:'STOPPED',p_usage:{audioWindowMilliseconds:1250,audioSentMilliseconds:200}});
 expect(JSON.stringify(records)).not.toMatch(/private speech|synthetic-request-id|synthetic-deepgram-key-only/);expect(h.failed).not.toHaveBeenCalled();
});
it('opens live audio without waiting for the database, and still records a stop that arrives first',async()=>{
 let complete!:(result:unknown)=>void,startArgs:Record<string,unknown>|undefined;
 const h=setup(args=>{startArgs=args;return new Promise(resolve=>{complete=resolve;});});
 await vi.waitFor(()=>{expect(startArgs).toBeDefined();expect(fixture.peers).toHaveLength(1);});
 h.owner.abort();expect(fixture.peers[0].readyState).toBe(3);complete({code:'RECORDED',operationId:startArgs!.p_operation});
 await vi.waitFor(()=>expect(h.rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_finish')).toBe(true));
 expect(h.rpc.mock.calls.find(([name])=>name==='cluera_provider_usage_finish')![1]).toMatchObject({p_outcome:'STOPPED',p_usage:{audioSentMilliseconds:0}});
 expect(h.ready).not.toHaveBeenCalled();expect(h.failed).not.toHaveBeenCalled();
});
it('keeps live audio working when a record is refused',async()=>{
 const h=setup(async()=>({code:'DENIED'}));await vi.waitFor(()=>expect(fixture.peers).toHaveLength(1));
 const peer=fixture.peers[0];peer.readyState=1;peer.emit('open');expect(h.ready).toHaveBeenCalledOnce();
 h.audio.write(Buffer.alloc(640));h.audio.close();await new Promise(resolve=>setTimeout(resolve,10));
 expect(h.failed).not.toHaveBeenCalled();expect(h.rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_finish')).toBe(false);
});
it('saves the audio sent so far once a minute while the stream is open',async()=>{
 vi.useFakeTimers();
 try{
  const h=setup();for(let tick=0;tick<5&&!fixture.peers.length;tick++)await vi.advanceTimersByTimeAsync(1);
  expect(fixture.peers).toHaveLength(1);const peer=fixture.peers[0];peer.readyState=1;peer.emit('open');
  for(let second=0;second<7;second++){h.audio.write(Buffer.alloc(3200));await vi.advanceTimersByTimeAsync(10_000);}
  const saved=h.rpc.mock.calls.filter(([name])=>name==='cluera_provider_usage_progress');
  expect(saved).toHaveLength(1);expect(saved[0][1]).toMatchObject({p_audio_ms:600});expect(h.failed).not.toHaveBeenCalled();h.audio.close();
 }finally{vi.useRealTimers();}
});
