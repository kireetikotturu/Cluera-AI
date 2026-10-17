import type {AccountConfig} from './config';
import {STAGING_DATABASE,STAGING_SITE} from '../accountRelay/config';
import {PROVIDER_METADATA_PATH,STAGING_RELAY_ORIGIN,providerStatusRequest,verifyProviderStatusResponse} from '../accountRelay/providerMetadata';

/** Call only after account admin live-session/allowlist/AAL2 checks. No user
 * token, provider secret, request body, arbitrary URL or cookie is forwarded. */
export async function readProviderStatus(config:AccountConfig,request=fetch){
 if(config.origin!==STAGING_SITE||config.url!==STAGING_DATABASE)throw new Error('Provider status unavailable.');
 const proof=providerStatusRequest(config.rateKey);
 let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const controller=new AbortController();
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
  reject(new Error('Provider status unavailable.'));controller.abort();void reader?.cancel().catch(()=>{});
 },7000);});
 try{
  const response=await Promise.race([request(`${STAGING_RELAY_ORIGIN}${PROVIDER_METADATA_PATH}`,{
   method:'GET',cache:'no-store',redirect:'error',signal:controller.signal,headers:{
    'X-Cluera-Time':proof.timestamp,'X-Cluera-Nonce':proof.nonce,'X-Cluera-Proof':proof.signature,
   },
  }),expired]);
  if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});throw new Error('Provider status unavailable.');}
  reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;size+=part.value.byteLength;
   if(size>8192||controller.signal.aborted)throw new Error('Provider status unavailable.');chunks.push(part.value);}
  return verifyProviderStatusResponse(config.rateKey,proof.nonce,Buffer.concat(chunks).toString('utf8'),response.headers.get('X-Cluera-Proof')??'');
 }catch{throw new Error('Provider status unavailable.');}
 finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});
  try{reader?.releaseLock();}catch{/* Unbounded cleanup must not extend the existing deadline. */}}
}
