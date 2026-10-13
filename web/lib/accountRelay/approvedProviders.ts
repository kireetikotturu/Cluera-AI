import {createClient} from '@supabase/supabase-js';
import type {RelayConfig} from './config';
import {modelRegistry} from './models';
import {providerAdapters,type AudioConnection,type Providers} from './providers';
import {vaultProviders} from './vaultProviders';

/** Runtime model authority, cached at most 10 seconds; no fallback to a disabled
 * or different paid model. Only fixed provider hosts are used by the adapters. */
export function approvedProviders(config:RelayConfig):Providers{
 if(config.providerMode==='auth-only')return {async prepare(){throw Error('Provider unavailable.');},async generate(){throw Error('Provider unavailable.');},audio(){throw Error('Provider unavailable.');}};
 const db=createClient(config.database,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(7000)})}});
 if(config.providerMode==='admin-vault')return vaultProviders(config,async(name,args)=>{const {data,error}=await db.rpc(name,args);if(error)throw Error('Provider unavailable.');return data;});
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
