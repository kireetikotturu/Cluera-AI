import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Rpc} from './repository';
import {receiptMetadataSchema,safeLabel,safeModelName,type ReceiptMetadata,type ProviderOutcome} from './usageMetadata';
const scopeSchema=z.object({runId:z.uuid(),provider:z.enum(['gemini','deepgram','openai','anthropic']),credentialId:z.uuid(),
 revision:z.number().int().positive(),model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),
 /** Where the live connection came from, and the app session it belongs to. */
 device:z.enum(['windows','web']).default('windows'),sessionRef:z.uuid().optional()}).strict();
type Scope=z.input<typeof scopeSchema>;
const unavailable=()=>new Error('Provider telemetry unavailable.');
const MAX_ELAPSED_MS=3_600_000;
/** One provider request or audio stream being recorded. */
export interface UsageRecorder{observe(value:ReceiptMetadata):void;progress(audioMilliseconds:number):void;finish(outcome:ProviderOutcome):Promise<boolean>}
/** Recording switched off: nothing to save. A scope that does not check out is never saved. */
const switchedOff:UsageRecorder={observe(){},progress(){},finish:async()=>true};
const unusable:UsageRecorder={observe(){},progress(){},finish:async()=>false};
/** Extract only documented numeric receipt fields. No prompts, transcripts,
 * raw IDs, keys, headers or provider bodies can enter the durable writer. */
export function providerReceiptMetadata(provider:'gemini'|'deepgram',input:unknown):ReceiptMetadata|undefined{
 if(!input||typeof input!=='object'||Array.isArray(input))return;
 const value=input as Record<string,unknown>,result:Record<string,unknown>={};
 const request=provider==='gemini'?value.responseId:value.request_id;
 if(typeof request==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(request))result.requestHash=createHash('sha256').update(request).digest('hex');
 const served=provider==='gemini'?safeModelName(value.modelVersion):undefined;if(served)result.servedModel=served;
 if(provider==='gemini'&&value.usageMetadata&&typeof value.usageMetadata==='object'&&!Array.isArray(value.usageMetadata)){
  const usage=value.usageMetadata as Record<string,unknown>;
  for(const [source,target] of Object.entries({promptTokenCount:'inputTokens',candidatesTokenCount:'outputTokens',cachedContentTokenCount:'cachedTokens',thoughtsTokenCount:'thinkingTokens',totalTokenCount:'totalTokens'})){
   if(usage[source]!==undefined)result[target]=usage[source];
  }
  const tier=safeLabel(usage.serviceTier);if(tier)result.serviceTier=tier;
 }else if(provider==='deepgram'&&typeof value.audio_window_end==='number'&&Number.isFinite(value.audio_window_end)&&value.audio_window_end>=0){
  result.audioWindowMilliseconds=Math.floor(value.audio_window_end*1000);
 }
 const parsed=receiptMetadataSchema.safeParse(result);return parsed.success&&Object.keys(parsed.data).length?parsed.data:undefined;
}
/** Default off until additive schema review/application and deliberate activation.
 * Recording runs alongside the provider call: a slow or unavailable database never delays or fails an answer or the
 * live audio. A lost or timed-out write is repeated once (the writes are safe to repeat); a refusal is final, and a
 * request whose end was never saved stays unfinished. */
export function providerTelemetry(rpc:Rpc,env:NodeJS.ProcessEnv=process.env,clock=()=>performance.now(),
 pause=(milliseconds:number)=>new Promise<void>(resolve=>{setTimeout(resolve,milliseconds);})){
 const enabled=env.CLUERA_PROVIDER_TELEMETRY_ENABLED==='true';
 async function write(name:string,args:Record<string,unknown>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>rpc(name,args)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),5000);})]);}
  finally{clearTimeout(timer);}
 }
 async function confirmed(name:string,operationId:string,args:()=>Record<string,unknown>):Promise<'recorded'|'refused'|'unknown'>{
  const expected=z.object({code:z.literal('RECORDED'),operationId:z.literal(operationId)}).strict();
  for(let attempt=0;;attempt++){
   try{return expected.safeParse(await write(name,args())).success?'recorded':'refused';}
   catch{if(attempt>0)return 'unknown';await pause(1000);}
  }
 }
 return {start(input:Omit<Scope,'runId'>&{runId?:string}):UsageRecorder{
  if(!enabled)return switchedOff;
  const parsed=scopeSchema.safeParse(input);
  if(!parsed.success)return unusable;
  const scope=parsed.data,operationId=randomUUID(),began=clock();
  const age=()=>{const value=clock()-began;return Number.isFinite(value)?Math.floor(Math.min(MAX_ELAPSED_MS,Math.max(0,value))):0;};
  const begin=()=>confirmed('cluera_provider_usage_start',operationId,()=>({p_operation:operationId,p_run:scope.runId,p_provider:scope.provider,
   p_model:scope.model,p_credential:scope.credentialId,p_revision:scope.revision,p_device:scope.device,p_session_ref:scope.sessionRef??null,p_started_ms_ago:age()}));
  const started=begin();
  let metadata:ReceiptMetadata={},finished:Promise<boolean>|undefined;
  return {observe(value:ReceiptMetadata){if(!finished){const checked=receiptMetadataSchema.safeParse(value);if(checked.success)metadata={...metadata,...checked.data};}},
   progress(audioMilliseconds:number){
    if(finished||!Number.isFinite(audioMilliseconds)||audioMilliseconds<1)return;
    void started.then(state=>state==='recorded'&&!finished?write('cluera_provider_usage_progress',
     {p_operation:operationId,p_audio_ms:Math.floor(Math.min(MAX_ELAPSED_MS,audioMilliseconds))}):undefined).catch(()=>undefined);
   },
   finish(outcome:ProviderOutcome):Promise<boolean>{
    if(finished)return finished;
    const elapsed=age(),usage={...metadata};
    return finished=(async()=>{
     let state=await started;
     // The first write may have been lost while the work ran: it is tried once more now.
     if(state==='unknown')state=await begin();
     if(state!=='recorded')return false;
     return await confirmed('cluera_provider_usage_finish',operationId,()=>({p_operation:operationId,p_outcome:outcome,p_elapsed_ms:elapsed,p_usage:usage}))==='recorded';
    })().catch(()=>false);
   }};
 }};
}
