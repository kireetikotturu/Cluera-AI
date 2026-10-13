import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {RelayConfig} from './config';

// This is a server-to-server read-only operation, not provider authorization.
// Domain separation prevents these MACs being reused as rate-limit identities.
export const PROVIDER_METADATA_PATH='/internal/provider-status';
export const STAGING_RELAY_ORIGIN='https://cluera-ai-relay-staging.onrender.com';
const scope='cluera:staging:provider-status:v1';
const provider=z.object({provider:z.enum(['gemini','deepgram']),configured:z.boolean(),enabled:z.boolean(),
 fingerprint:z.string().regex(/^[a-f0-9]{16}$/).nullable(),lastRotatedAt:z.null(),health:z.literal('UNVERIFIED'),
 rotationAvailable:z.literal(false)}).strict();
export const providerStatusSchema=z.object({observedAt:z.string().datetime(),bootstrapMode:z.enum(['legacy-environment','auth-only','admin-vault']).optional(),providers:z.array(provider).length(2)}).strict()
 .refine(value=>value.providers[0].provider==='gemini'&&value.providers[1].provider==='deepgram');
export type ProviderStatus=z.infer<typeof providerStatusSchema>;
function mac(key:Buffer,purpose:string,value:string){return createHmac('sha256',key).update(`${scope}\n${purpose}\n${value}`).digest('hex');}
function equal(actual:string,expected:string){return /^[a-f0-9]{64}$/.test(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
export function providerStatusRequest(key:Buffer,now=Date.now()){
 const timestamp=String(now),nonce=randomBytes(24).toString('hex');
 return {timestamp,nonce,signature:mac(key,'request',`GET\n${PROVIDER_METADATA_PATH}\n${timestamp}\n${nonce}`)};
}
export function verifyProviderStatusRequest(key:Buffer,values:{timestamp:string;nonce:string;signature:string},now=Date.now()){
 return /^\d{13}$/.test(values.timestamp)&&/^[a-f0-9]{48}$/.test(values.nonce)
  &&Math.abs(now-Number(values.timestamp))<=30000
  &&equal(values.signature,mac(key,'request',`GET\n${PROVIDER_METADATA_PATH}\n${values.timestamp}\n${values.nonce}`));
}
export function providerStatusResponse(config:RelayConfig,nonce:string,now=Date.now()){
 const key=Buffer.from(config.rateKey,'base64');
 const providers=(['gemini','deepgram'] as const).map(provider=>{
  const credential=provider==='gemini'?config.geminiKey:config.deepgramKey;
  return {provider,configured:Boolean(credential),enabled:(config.providerMode??'legacy-environment')==='legacy-environment'&&Boolean(credential),
   fingerprint:credential?mac(key,'fingerprint',`${provider}\n${credential}`).slice(0,16):null,
   lastRotatedAt:null,health:'UNVERIFIED' as const,rotationAvailable:false as const};
 });
 const body=JSON.stringify({observedAt:new Date(now).toISOString(),bootstrapMode:config.providerMode??'legacy-environment',providers});
 return {body,signature:mac(key,'response',`${nonce}\n${body}`)};
}
export function verifyProviderStatusResponse(key:Buffer,nonce:string,body:string,signature:string,now=Date.now()):ProviderStatus{
 if(!equal(signature,mac(key,'response',`${nonce}\n${body}`)))throw new Error('Provider status unavailable.');
 const result=providerStatusSchema.parse(JSON.parse(body));
 if(Math.abs(now-Date.parse(result.observedAt))>30000)throw new Error('Provider status unavailable.');
 return result;
}
