import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

// Separate machine-only proof: provider-status proofs cannot authorize DB probes.
export const INFRASTRUCTURE_STATUS_PATH='/internal/infrastructure-status';
const scope='cluera:staging:infrastructure-status:v1';
const schema=z.object({observedAt:z.string().datetime(),databaseAuthenticated:z.boolean()}).strict();
function mac(key:Buffer,purpose:string,value:string){return createHmac('sha256',key).update(`${scope}\n${purpose}\n${value}`).digest('hex');}
function equal(actual:string,expected:string){return /^[a-f0-9]{64}$/.test(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
export function infrastructureStatusRequest(key:Buffer,now=Date.now()){
 const timestamp=String(now),nonce=randomBytes(24).toString('hex');
 return{timestamp,nonce,signature:mac(key,'request',`GET\n${INFRASTRUCTURE_STATUS_PATH}\n${timestamp}\n${nonce}`)};
}
export function verifyInfrastructureStatusRequest(key:Buffer,proof:{timestamp:string;nonce:string;signature:string},now=Date.now()){
 return /^\d{13}$/.test(proof.timestamp)&&/^[a-f0-9]{48}$/.test(proof.nonce)&&Math.abs(now-Number(proof.timestamp))<=30000
  &&equal(proof.signature,mac(key,'request',`GET\n${INFRASTRUCTURE_STATUS_PATH}\n${proof.timestamp}\n${proof.nonce}`));
}
export function infrastructureStatusResponse(key:Buffer,nonce:string,databaseAuthenticated:boolean,now=Date.now()){
 const body=JSON.stringify({observedAt:new Date(now).toISOString(),databaseAuthenticated});
 return{body,signature:mac(key,'response',`${nonce}\n${body}`)};
}
export function verifyInfrastructureStatusResponse(key:Buffer,nonce:string,body:string,signature:string,now=Date.now()){
 if(!equal(signature,mac(key,'response',`${nonce}\n${body}`)))throw Error('Infrastructure status unavailable.');
 const result=schema.parse(JSON.parse(body));
 if(Math.abs(now-Date.parse(result.observedAt))>30000)throw Error('Infrastructure status unavailable.');
 return result;
}
