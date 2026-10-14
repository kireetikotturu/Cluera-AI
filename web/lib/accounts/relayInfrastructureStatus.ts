import type {AccountConfig} from './config';
import {STAGING_DATABASE,STAGING_SITE} from '../accountRelay/config';
import {STAGING_RELAY_ORIGIN} from '../accountRelay/providerMetadata';
import {INFRASTRUCTURE_STATUS_PATH,infrastructureStatusRequest,verifyInfrastructureStatusResponse} from '../accountRelay/infrastructureMetadata';

// Protected build diagnostic only. No browser route or customer token forwards.
export async function readRelayInfrastructureStatus(config:AccountConfig,request:typeof fetch=fetch){
 if(config.origin!==STAGING_SITE||config.url!==STAGING_DATABASE)throw Error('Infrastructure status unavailable.');
 const proof=infrastructureStatusRequest(config.rateKey);
 const response=await request(`${STAGING_RELAY_ORIGIN}${INFRASTRUCTURE_STATUS_PATH}`,{method:'GET',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000),
  headers:{'X-Cluera-Time':proof.timestamp,'X-Cluera-Nonce':proof.nonce,'X-Cluera-Proof':proof.signature}});
 if(!response.ok||!response.body)throw Error('Infrastructure status unavailable.');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024)throw Error('Infrastructure status unavailable.');chunks.push(part.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 return verifyInfrastructureStatusResponse(config.rateKey,proof.nonce,Buffer.concat(chunks).toString('utf8'),response.headers.get('X-Cluera-Proof')??'');
}
