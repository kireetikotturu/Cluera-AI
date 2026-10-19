/** Browser-only bounded Admin JSON read. A fixed caller-owned same-origin path
 * and abort signal are required; no response body or failure is logged. */
export async function adminBoundedRead(path:string,controller:AbortController){
 if(!path.startsWith('/api/account/admin/')||path.includes('\\')||new URL(path,window.location.origin).origin!==window.location.origin)throw Error('UNAVAILABLE');
 let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNAVAILABLE'));},8000);});
 const canceled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('CANCELED')),{once:true}));
 const wait=<T,>(value:Promise<T>)=>Promise.race([value,expired,canceled]);
 try{
  if(controller.signal.aborted)throw Error('CANCELED');
  const response=await wait(fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal}));
  if(response.redirected||response.url&&response.url!==new URL(path,window.location.origin).href)throw Error('UNAVAILABLE');
  if(response.status!==200)return{status:response.status,data:null as unknown};
  if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||response.headers.get('cache-control')!=='no-store'
   ||response.headers.get('x-content-type-options')!=='nosniff'||!response.body)throw Error('UNAVAILABLE');
  const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>65536))throw Error('UNAVAILABLE');
  reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  for(;;){const part=await wait(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>65536)throw Error('UNAVAILABLE');parts.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return{status:200,data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))as unknown};
 }finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* Do not await cancellation. */}}
}
