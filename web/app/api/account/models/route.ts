import {stagingAccountConfig} from '../../../../lib/accounts/workspace';
import {accountClients} from '../../../../lib/accounts/clients';
import {modelRegistry,isTextProvider} from '../../../../lib/accountRelay/models';
import {AccountError} from '../../../../lib/accounts/config';
import {apiError,json} from '../../../../lib/http';
import {SupabaseOperationError} from '../../../../lib/supabase/diagnostics';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const providerLabel={gemini:'Google Gemini',openai:'ChatGPT',anthropic:'Claude',deepgram:'Deepgram'} as const;
/** Public, non-sensitive approved catalog metadata, never credentials.
 * Installed desktop apps know two model kinds: "gemini" (answer models) and "deepgram"
 * (transcription). Every answer model, including ChatGPT and Claude, is therefore listed
 * as an answer model; the relay routes the chosen model ID to its real provider. */
export async function GET(){
 try{
  const clients=accountClients(stagingAccountConfig());
  const registry=modelRegistry(async()=>{const {data,error,status}=await clients.service.rpc('account_models_read');
   if(error)throw new SupabaseOperationError('account.models',error,status);return data;});
  const models=[...await registry.list()].sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||a.priority-b.priority||a.modelId.localeCompare(b.modelId));
  const defaults={answer:false,audio:false};
  return json({models:models.map(m=>{
   const answer=isTextProvider(m.provider),enabled=m.enabled&&m.health!=='UNAVAILABLE';
   const slot=answer?'answer':'audio',isDefault=enabled&&m.isDefault&&!defaults[slot];if(isDefault)defaults[slot]=true;
   return {provider:answer?'gemini':'deepgram',modelId:m.modelId,displayName:m.displayName,
    description:`${providerLabel[m.provider]} model`,enabled,isDefault};
  })});
 }catch(error){return error instanceof AccountError?json({error:error.code},error.status):apiError(error);}
}
