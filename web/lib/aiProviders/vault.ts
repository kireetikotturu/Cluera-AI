import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';

export const providerId=z.enum(['gemini','deepgram','openai','anthropic']);
export type ProviderId=z.infer<typeof providerId>;
export const apiKey=z.string().min(20).max(4096).regex(/^[\x21-\x7e]+$/);
const id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const ringSchema=z.object({active:id,keys:z.record(id,z.string()).refine(v=>Object.keys(v).length>=1&&Object.keys(v).length<=3)}).strict();
const b64=(n:number)=>z.string().refine(v=>{const b=Buffer.from(v,'base64');return b.length===n&&b.toString('base64')===v;});
export const envelopeSchema=z.object({v:z.literal(1),keyId:id,wrapIv:b64(12),wrapTag:b64(16),wrappedKey:b64(32),iv:b64(12),tag:b64(16),ciphertext:z.string().max(5500).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
export type Envelope=z.infer<typeof envelopeSchema>;
export type Binding={provider:ProviderId;credentialId:string};
export class VaultError extends Error {constructor(){super('Provider vault unavailable.');}}
const binding=(b:Binding)=>`cluera-ai:provider-vault:v1:${providerId.parse(b.provider)}:${z.uuid().parse(b.credentialId)}`;

/** Dedicated infrastructure keyring, never a provider/cookie/rate key. No file discovery,
 * automatic generation, secret-returning DTO, or legacy credential import. */
export function vaultKeyring(env:NodeJS.ProcessEnv=process.env){
 try{
  const value=env.CLUERA_PROVIDER_VAULT_KEYRING_BASE64;
  if(!value||value.length>4096)throw new VaultError();
  const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw new VaultError();
  const data=ringSchema.parse(JSON.parse(bytes.toString('utf8'))),keys=new Map<string,Buffer>();
  for(const [name,value] of Object.entries(data.keys)){
   const key=Buffer.from(b64(32).parse(value),'base64');
   if([...keys.values()].some(k=>k.equals(key))||[env.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64,env.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64].some(v=>v&&Buffer.from(v,'base64').equals(key)))throw new VaultError();
   keys.set(name,key);
  }
  if(!keys.has(data.active))throw new VaultError();
  const crypt=(encrypt:boolean,key:Buffer,iv:Buffer,aad:string,input:Buffer,tag?:Buffer)=>{
   if(encrypt){const c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));return {bytes:Buffer.concat([c.update(input),c.final()]),tag:c.getAuthTag()};}
   const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(Buffer.from(aad));d.setAuthTag(tag!);return {bytes:Buffer.concat([d.update(input),d.final()]),tag:Buffer.alloc(0)};
  };
  return {
   seal(secret:string,b:Binding):Envelope{
    try{apiKey.parse(secret);const aad=binding(b),dek=randomBytes(32),iv=randomBytes(12),wrapIv=randomBytes(12);
     try{const content=crypt(true,dek,iv,aad,Buffer.from(secret)),wrap=crypt(true,keys.get(data.active)!,wrapIv,`${aad}:wrap:${data.active}`,dek);
      return {v:1,keyId:data.active,wrapIv:wrapIv.toString('base64'),wrapTag:wrap.tag.toString('base64'),wrappedKey:wrap.bytes.toString('base64'),iv:iv.toString('base64'),tag:content.tag.toString('base64'),ciphertext:content.bytes.toString('base64')};
     }finally{dek.fill(0);}
    }catch{throw new VaultError();}
   },
   open(raw:unknown,b:Binding):string{
    let dek:Buffer|undefined;
    try{const e=envelopeSchema.parse(raw),aad=binding(b),key=keys.get(e.keyId);if(!key)throw new VaultError();
     dek=crypt(false,key,Buffer.from(e.wrapIv,'base64'),`${aad}:wrap:${e.keyId}`,Buffer.from(e.wrappedKey,'base64'),Buffer.from(e.wrapTag,'base64')).bytes;
     return apiKey.parse(crypt(false,dek,Buffer.from(e.iv,'base64'),aad,Buffer.from(e.ciphertext,'base64'),Buffer.from(e.tag,'base64')).bytes.toString('utf8'));
    }catch{throw new VaultError();}finally{dek?.fill(0);}
   },
   digest(value:string){return createHmac('sha256',keys.get(data.active)!).update('cluera-ai:vault-operation:v1\n').update(value).digest('hex');},
  };
 }catch{throw new VaultError();}
}
