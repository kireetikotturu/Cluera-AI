import {z} from 'zod';
import {GEMINI_MODEL,DEEPGRAM_MODEL} from './protocol';

/** Answer (text/image) providers. Deepgram is the only audio provider. */
export const TEXT_PROVIDERS=['gemini','openai','anthropic'] as const;
export type TextProvider=typeof TEXT_PROVIDERS[number];
export type ModelProvider=TextProvider|'deepgram';
export const isTextProvider=(value:string):value is TextProvider=>(TEXT_PROVIDERS as readonly string[]).includes(value);

const model=z.object({modelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),displayName:z.string().min(1).max(80),
 provider:z.enum(['gemini','openai','anthropic','deepgram']),
 enabled:z.boolean(),isDefault:z.boolean(),priority:z.number().int().min(0).max(1000),capabilities:z.array(z.enum(['text','image','audio'])).max(3),
 health:z.enum(['UNVERIFIED','HEALTHY','DEGRADED','UNAVAILABLE']),tag:z.string().max(24).optional()}).strict();
export type AccountModel=z.infer<typeof model>;
const usable=(m:AccountModel)=>m.enabled&&m.health!=='UNAVAILABLE';

export function modelRegistry(load:()=>Promise<unknown>,clock=()=>performance.now()){
 let cached:AccountModel[]|undefined,until=0,pending:Promise<AccountModel[]>|undefined;
 const list=async():Promise<AccountModel[]>=>{
  if(cached&&clock()<until)return cached;
  if(pending)return pending;
  pending=(async()=>{const result=z.array(model).max(100).parse(await load());cached=result;until=clock()+10000;return result;})().finally(()=>{pending=undefined;});
  return pending;
 };
 /** Any enabled answer model (Gemini, ChatGPT or Claude). With no request, the single answer default. */
 const resolveText=async(requested?:string,image=false):Promise<{provider:TextProvider;modelId:string}>=>{
  const models=(await list()).filter(m=>isTextProvider(m.provider));
  const found=requested?models.find(m=>m.modelId===requested&&usable(m))
   :models.filter(usable).sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||a.priority-b.priority)[0];
  if(!found||!found.capabilities.includes(image?'image':'text'))throw new Error('Approved model is unavailable.');
  return {provider:found.provider as TextProvider,modelId:found.modelId};
 };
 /** The enabled Deepgram live-transcription model (default first). */
 const resolveAudio=async(requested?:string):Promise<{provider:'deepgram';modelId:string}>=>{
  const models=(await list()).filter(m=>m.provider==='deepgram'&&usable(m)&&m.capabilities.includes('audio'));
  const found=requested?models.find(m=>m.modelId===requested):models.sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||a.priority-b.priority)[0];
  if(!found)throw new Error('Approved model is unavailable.');
  return {provider:'deepgram',modelId:found.modelId};
 };
 return {list,resolveText,resolveAudio,
  /** Single-provider resolver (legacy environment-key mode supports Gemini and Deepgram only). */
  async resolve(provider:'gemini'|'deepgram',requested?:string,image=false){
   if(provider==='deepgram')return (await resolveAudio(requested)).modelId;
   const models=(await list()).filter(m=>m.provider==='gemini'&&usable(m));
   const selected=requested??models.find(m=>m.isDefault)?.modelId??GEMINI_MODEL;
   const found=models.find(m=>m.modelId===selected);
   if(!found||!found.capabilities.includes(image?'image':'text'))throw new Error('Approved model is unavailable.');
   return found.modelId;
  },
  defaults:{gemini:GEMINI_MODEL,deepgram:DEEPGRAM_MODEL},
 };
}
