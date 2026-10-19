import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Rpc} from './repository';
import {receiptMetadataSchema,type ReceiptMetadata,type ProviderOutcome} from './usageMetadata';
const scopeSchema=z.object({runId:z.uuid(),provider:z.enum(['gemini','deepgram']),credentialId:z.uuid(),
 revision:z.number().int().positive(),model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/)}).strict();
type Scope=z.infer<typeof scopeSchema>;
const unavailable=()=>new Error('Provider telemetry unavailable.');
/** Extract only documented numeric receipt fields. No prompts, transcripts,
 * raw IDs, keys, headers or provider bodies can enter the durable writer. */
export function providerReceiptMetadata(provider:'gemini'|'deepgram',input:unknown):ReceiptMetadata|undefined{
 if(!input||typeof input!=='object'||Array.isArray(input))return;
 const value=input as Record<string,unknown>,result:Record<string,unknown>={};
 const request=provider==='gemini'?value.responseId:value.request_id;
 if(typeof request==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(request))result.requestHash=createHash('sha256').update(request).digest('hex');
 if(provider==='gemini'&&value.usageMetadata&&typeof value.usageMetadata==='object'&&!Array.isArray(value.usageMetadata)){
  const usage=value.usageMetadata as Record<string,unknown>;
  for(const [source,target] of Object.entries({promptTokenCount:'inputTokens',candidatesTokenCount:'outputTokens',cachedContentTokenCount:'cachedTokens',thoughtsTokenCount:'thinkingTokens',totalTokenCount:'totalTokens'})){
   if(usage[source]!==undefined)result[target]=usage[source];
  }
 }else if(provider==='deepgram'&&typeof value.audio_window_end==='number'&&Number.isFinite(value.audio_window_end)&&value.audio_window_end>=0){
  result.audioWindowMilliseconds=Math.floor(value.audio_window_end*1000);
 }
 const parsed=receiptMetadataSchema.safeParse(result);return parsed.success&&Object.keys(parsed.data).length?parsed.data:undefined;
}
/** Default off until additive schema review/application and deliberate activation.
 * A durable START is required before upstream work. Terminal failure is never
 * retried or called a success: its persisted START remains UNCONFIRMED. */
export function providerTelemetry(rpc:Rpc,env:NodeJS.ProcessEnv=process.env,clock=()=>performance.now()){
 const enabled=env.CLUERA_PROVIDER_TELEMETRY_ENABLED==='true';
 async function write(name:string,args:Record<string,unknown>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>rpc(name,args)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),5000);})]);}
  finally{clearTimeout(timer);}
 }
 return {async start(input:Omit<Scope,'runId'>&{runId?:string}){
  if(!enabled)return {observe(_value:ReceiptMetadata){},async finish(_outcome:ProviderOutcome){return true;}};
  const scope=scopeSchema.parse(input),operationId=randomUUID();
  const recorded=await write('cluera_provider_usage_start',{p_operation:operationId,p_run:scope.runId,p_provider:scope.provider,
   p_model:scope.model,p_credential:scope.credentialId,p_revision:scope.revision});
  const expected=z.object({code:z.literal('RECORDED'),operationId:z.literal(operationId)}).strict();
  if(!expected.safeParse(recorded).success)throw unavailable();
  const started=clock();let metadata:ReceiptMetadata={},finished:Promise<boolean>|undefined;
  return {observe(value:ReceiptMetadata){if(!finished){const parsed=receiptMetadataSchema.safeParse(value);if(parsed.success)metadata={...metadata,...parsed.data};}},
   finish(outcome:ProviderOutcome):Promise<boolean>{
    if(finished)return finished;
    const elapsed=clock()-started;
    if(!Number.isFinite(elapsed)||elapsed<0||elapsed>3_600_000)return finished=Promise.resolve(false);
    return finished=(async()=>{
     try{return expected.safeParse(await write('cluera_provider_usage_finish',{p_operation:operationId,p_outcome:outcome,
      p_elapsed_ms:Math.floor(elapsed),p_usage:metadata})).success;}
     catch{return false;}
    })();
   }};
 }};
}
