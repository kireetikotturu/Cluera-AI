import {createClient} from '@supabase/supabase-js';
import type {RelayConfig} from './config';
import {modelRegistry} from './models';
import {providerAdapters,type AudioConnection,type Providers} from './providers';

/** Runtime model authority, cached at most 10 seconds; no fallback to a disabled
 * or different paid model. Only fixed provider hosts are used by the adapters. */
export function approvedProviders(config:RelayConfig):Providers{
 const db=createClient(config.database,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(7000)})}});
 const registry=modelRegistry(async()=>{const {data,error}=await db.rpc('account_models_read');if(error)throw new Error('Approved model registry unavailable.');return data;});
 const base=providerAdapters(config,{resolveModel:(input)=>registry.resolve('gemini',input.modelId,Boolean(input.image))});
 return {
  generate:base.generate,
  audio(guard,emit,failed,ready){
   let peer:AudioConnection|undefined,closed=false;
   void registry.resolve('deepgram').then(()=>{
    if(closed||guard.signal.aborted)return;guard.assertActive();peer=base.audio(guard,emit,failed,ready);
   }).catch(()=>{if(!closed&&!guard.signal.aborted)failed();});
   return {write(bytes){if(peer&&!closed)peer.write(bytes);},forceEndTurn(){if(peer&&!closed)peer.forceEndTurn();},close(){closed=true;peer?.close();}};
  },
 };
}
