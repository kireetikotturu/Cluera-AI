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
it('records one durable audio start before opening and one stopped receipt without persisting speech',async()=>{
 const h=setup();await vi.waitFor(()=>expect(fixture.peers).toHaveLength(1));const peer=fixture.peers[0];
 expect(fixture.events).toEqual(['cluera_provider_usage_start','upstream']);peer.readyState=1;peer.emit('open');expect(h.ready).toHaveBeenCalledOnce();
 peer.emit('message',Buffer.from(JSON.stringify({type:'TurnInfo',request_id:'synthetic-request-id',event:'EndOfTurn',transcript:'private speech',audio_window_end:1.25})));
 h.audio.close();h.audio.close();await vi.waitFor(()=>expect(h.rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_finish')).toBe(true));
 const records=h.rpc.mock.calls.filter(([name])=>name.startsWith('cluera_provider_usage'));
 expect(records).toHaveLength(2);expect(records[1][1]).toMatchObject({p_outcome:'STOPPED',p_usage:{audioWindowMilliseconds:1250}});
 expect(JSON.stringify(records)).not.toMatch(/private speech|synthetic-request-id|synthetic-deepgram-key-only/);expect(h.failed).not.toHaveBeenCalled();
});
it('never opens Deepgram when stop arrives while the durable start write is pending',async()=>{
 let complete!:(result:unknown)=>void,startArgs:Record<string,unknown>|undefined;
 const h=setup(args=>{startArgs=args;return new Promise(resolve=>{complete=resolve;});});
 await vi.waitFor(()=>expect(startArgs).toBeDefined());h.owner.abort();complete({code:'RECORDED',operationId:startArgs!.p_operation});
 await vi.waitFor(()=>expect(h.rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_finish')).toBe(true));
 expect(fixture.peers).toHaveLength(0);expect(h.ready).not.toHaveBeenCalled();expect(h.failed).not.toHaveBeenCalled();
});
it('fails audio before any upstream connection if recording the start is denied',async()=>{
 const h=setup(async()=>({code:'DENIED'}));await vi.waitFor(()=>expect(h.failed).toHaveBeenCalledOnce());
 expect(fixture.peers).toHaveLength(0);expect(h.rpc.mock.calls.some(([name])=>name==='cluera_provider_usage_finish')).toBe(false);h.audio.close();
});
