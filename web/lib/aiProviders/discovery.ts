import {z} from 'zod';
import {apiKey,providerId,type ProviderId} from './vault';
import {GEMINI_MODEL,DEEPGRAM_MODEL} from '../accountRelay/protocol';

export const modelId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/);
export const modelSummary=z.object({id:modelId,runtimeCompatible:z.boolean()}).strict();
export type ModelSummary=z.infer<typeof modelSummary>;
export type Probe={status:'VERIFIED'|'REJECTED'|'UNAVAILABLE';models:ModelSummary[];complete:boolean};
const endpoints:Record<ProviderId,string>={gemini:'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',deepgram:'https://api.deepgram.com/v1/models',openai:'https://api.openai.com/v1/models',anthropic:'https://api.anthropic.com/v1/models?limit=1000'};
/** Explicit Admin metadata GET only. No generation, audio, retries, redirects,
 * arbitrary hosts, provider error bodies, display names or reflected secrets. */
export async function discoverModels(provider:ProviderId,key:string,request=fetch):Promise<Probe>{
 let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const controller=new AbortController();
 try{
  providerId.parse(provider);apiKey.parse(key);
  const headers:Record<string,string>=provider==='gemini'?{'x-goog-api-key':key}:provider==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:`${provider==='deepgram'?'Token':'Bearer'} ${key}`};
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
   reject(Error());controller.abort();void reader?.cancel().catch(()=>{});
  },7000);});
  const response=await Promise.race([request(endpoints[provider],{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal,headers}),expired]);
  if(response.status===401||response.status===403){void response.body?.cancel().catch(()=>{});return {status:'REJECTED',models:[],complete:false};}
  if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});return {status:'UNAVAILABLE',models:[],complete:false};}
  reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  for(;;){const chunk=await Promise.race([reader.read(),expired]);if(chunk.done)break;
   size+=chunk.value.byteLength;if(size>256000||controller.signal.aborted)throw Error();parts.push(chunk.value);}
  const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
  const rows:unknown=provider==='gemini'?body.models:provider==='deepgram'?body.stt:body.data;
  if(!Array.isArray(rows)||rows.length>1000)throw Error();
  const models=new Map<string,ModelSummary>();
  for(const row of rows){
   if(!row||typeof row!=='object')throw Error();
   const raw=provider==='gemini'?row.name:provider==='deepgram'?row.canonical_name:row.id;
   const value=typeof raw==='string'&&provider==='gemini'&&raw.startsWith('models/')?raw.slice(7):raw;
   // Provider-supplied text is untrusted. Never echo a key even as a model ID.
   if(typeof value!=='string'||value.includes(key)||!modelId.safeParse(value).success)throw Error();
   const compatible=provider==='gemini'?value===GEMINI_MODEL&&Array.isArray(row.supportedGenerationMethods)&&row.supportedGenerationMethods.includes('generateContent'):provider==='deepgram'?value===DEEPGRAM_MODEL&&row.streaming===true:false;
   const prior=models.get(value);if(prior&&prior.runtimeCompatible!==compatible)throw Error();
   models.set(value,{id:value,runtimeCompatible:compatible});
  }
  const complete=provider==='gemini'?!body.nextPageToken:provider==='anthropic'?body.has_more===false:true;
  return {status:'VERIFIED',models:[...models.values()].sort((a,b)=>a.id.localeCompare(b.id)),complete};
 }catch{return {status:'UNAVAILABLE',models:[],complete:false};}
 finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});
  try{reader?.releaseLock();}catch{/* Cancellation is requested, never awaited without a deadline. */}}
}
