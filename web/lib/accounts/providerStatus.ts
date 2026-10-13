import type {AccountConfig} from './config';
import {STAGING_DATABASE,STAGING_SITE} from '../accountRelay/config';
import {PROVIDER_METADATA_PATH,STAGING_RELAY_ORIGIN,providerStatusRequest,verifyProviderStatusResponse} from '../accountRelay/providerMetadata';

/** Call only after account admin live-session/allowlist/AAL2 checks. No user
 * token, provider secret, request body, arbitrary URL or cookie is forwarded. */
export async function readProviderStatus(config:AccountConfig,request=fetch){
 if(config.origin!==STAGING_SITE||config.url!==STAGING_DATABASE)throw new Error('Provider status unavailable.');
 const proof=providerStatusRequest(config.rateKey);
 const response=await request(`${STAGING_RELAY_ORIGIN}${PROVIDER_METADATA_PATH}`,{
  method:'GET',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000),headers:{
   'X-Cluera-Time':proof.timestamp,'X-Cluera-Nonce':proof.nonce,'X-Cluera-Proof':proof.signature,
  },
 });
 if(!response.ok||!response.body)throw new Error('Provider status unavailable.');
 const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
  if(size>8192)throw new Error('Provider status unavailable.');chunks.push(part.value);}}
 finally{await reader.cancel().catch(()=>{});}
 return verifyProviderStatusResponse(config.rateKey,proof.nonce,Buffer.concat(chunks).toString('utf8'),response.headers.get('X-Cluera-Proof')??'');
}
