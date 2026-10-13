import {z} from 'zod';
import {GEMINI_MODEL,DEEPGRAM_MODEL} from './protocol';
const model=z.object({modelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),displayName:z.string().min(1).max(80),provider:z.enum(['gemini','deepgram']),
 enabled:z.boolean(),isDefault:z.boolean(),priority:z.number().int().min(0).max(1000),capabilities:z.array(z.enum(['text','image','audio'])).max(3),
 health:z.enum(['UNVERIFIED','HEALTHY','DEGRADED','UNAVAILABLE'])}).strict();
export type AccountModel=z.infer<typeof model>;
export function modelRegistry(load:()=>Promise<unknown>,clock=()=>performance.now()){
 let cached:AccountModel[]|undefined,until=0,pending:Promise<AccountModel[]>|undefined;
 const list=async():Promise<AccountModel[]>=>{
  if(cached&&clock()<until)return cached;
  if(pending)return pending;
  pending=(async()=>{const result=z.array(model).max(100).parse(await load());cached=result;until=clock()+10000;return result;})().finally(()=>{pending=undefined;});
  return pending;
 };
 return {list,async resolve(provider:'gemini'|'deepgram',requested?:string,image=false){
  const models=await list();const selected=requested??models.find(m=>m.provider===provider&&m.isDefault)?.modelId??(provider==='gemini'?GEMINI_MODEL:DEEPGRAM_MODEL);
  const found=models.find(m=>m.provider===provider&&m.modelId===selected&&m.enabled&&m.health!=='UNAVAILABLE');
  if(!found||!found.capabilities.includes(provider==='deepgram'?'audio':image?'image':'text')||(provider==='deepgram'&&selected!==DEEPGRAM_MODEL))throw new Error('Approved model is unavailable.');
  return found.modelId;
 }};
}
