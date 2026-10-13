import {stagingAccountConfig} from '../../../../lib/accounts/workspace';
import {accountClients} from '../../../../lib/accounts/clients';
import {modelRegistry} from '../../../../lib/accountRelay/models';
import {AccountError} from '../../../../lib/accounts/config';
import {apiError,json} from '../../../../lib/http';
import {SupabaseOperationError} from '../../../../lib/supabase/diagnostics';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Public, non-sensitive approved catalog metadata, never credentials. */
export async function GET(){
 try{
  const clients=accountClients(stagingAccountConfig());
  const registry=modelRegistry(async()=>{const {data,error,status}=await clients.service.rpc('account_models_read');
   if(error)throw new SupabaseOperationError('account.models',error,status);return data;});
  return json({models:(await registry.list()).map(m=>({provider:m.provider,modelId:m.modelId,displayName:m.displayName,
   description:'Approved account model',enabled:m.enabled&&m.health!=='UNAVAILABLE',isDefault:m.isDefault}))});
 }catch(error){return error instanceof AccountError?json({error:error.code},error.status):apiError(error);}
}
