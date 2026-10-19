import {providerUsageReportSchema,type ProviderUsageReport} from './usageMetadata';
const endpoint='/api/account/admin/ai-usage';
/** Fixed same-origin, bounded metadata read. Abort-ignoring request/body/cleanup
 * implementations cannot extend the eight-second total deadline. */
export async function readProviderUsage(controller:AbortController):Promise<{status:number;report?:ProviderUsageReport}>{
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,body:ReadableStream<Uint8Array>|null=null,timer:ReturnType<typeof setTimeout>|undefined;
 let onAbort!:()=>void;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Unavailable'));},8000);});
 const cancelled=new Promise<never>((_,reject)=>{onAbort=()=>reject(Error('Unavailable'));controller.signal.addEventListener('abort',onAbort,{once:true});});
 const wait=<T,>(value:Promise<T>)=>Promise.race([value,expired,cancelled]);
 try{
  if(controller.signal.aborted)throw Error('Unavailable');
  const response=await wait(fetch(endpoint,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal}));
  body=response.body;
  if(response.redirected||response.url&&response.url!==new URL(endpoint,window.location.origin).href)throw Error('Unavailable');
  if(response.status!==200)return {status:response.status};
  if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'
   ||response.headers.get('cache-control')!=='no-store'||response.headers.get('x-content-type-options')!=='nosniff'||!response.body)throw Error('Unavailable');
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^(0|[1-9][0-9]*)$/.test(declared)||Number(declared)>131072))throw Error('Unavailable');
  reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  for(;;){const chunk=await wait(reader.read());if(chunk.done)break;size+=chunk.value.byteLength;if(size>131072)throw Error('Unavailable');chunks.push(chunk.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return {status:200,report:providerUsageReportSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))};
 }finally{
  clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);controller.abort();
  if(reader)void reader.cancel().catch(()=>{});else void body?.cancel().catch(()=>{});
  try{reader?.releaseLock();}catch{/* Never await an untrusted cleanup. */}
 }
}
