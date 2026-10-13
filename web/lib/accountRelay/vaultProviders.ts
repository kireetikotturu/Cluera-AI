import {providerRuntime} from '../aiProviders/runtime';
import type {Rpc} from '../aiProviders/repository';
import {providerAdapters,type Guard,type AudioConnection,type Providers} from './providers';
import type {RelayConfig} from './config';
import {modelRegistry} from './models';

/** Existing Gemini/Flux transports and ledger guards retained. No cross-provider
 * fallback. Credentials never leave this server closure. Active streams check
 * current revision every 10s and close on disable/change/read failure. */
export function vaultProviders(config:RelayConfig,rpc:Rpc,env:NodeJS.ProcessEnv=process.env):Providers{
 const runtime=providerRuntime(rpc,env),registry=modelRegistry(()=>rpc('account_models_read',{}));
 const resolve=async(provider:'gemini'|'deepgram',input?:Parameters<Providers['generate']>[0])=>{
  const snapshot=await runtime.resolve(provider,input?.modelId);
  const model=await registry.resolve(provider,snapshot.model,Boolean(input?.image));
  if(model!==snapshot.model)throw Error('Provider unavailable.');return snapshot;
 };
 function lease(snapshot:Awaited<ReturnType<typeof resolve>>,guard:Guard,onFailure:()=>void){
  const controller=new AbortController(),signal=AbortSignal.any([guard.signal,controller.signal]);let stopped=false;
  const timer=setInterval(()=>{void runtime.resolve(snapshot.provider,snapshot.model,true).then(current=>{
   if(current.revision!==snapshot.revision||current.credentialId!==snapshot.credentialId)throw Error();
  }).catch(()=>{if(!stopped){controller.abort();onFailure();}});},10000);
  const close=()=>{if(stopped)return;stopped=true;clearInterval(timer);controller.abort();guard.signal.removeEventListener('abort',close);};
  guard.signal.addEventListener('abort',close,{once:true});
  return {guard:{signal,assertActive(){guard.assertActive();if(signal.aborted)throw Error('Provider unavailable.');}},close};
 }
 return {
  async prepare(provider,input){await resolve(provider,input);},
  async generate(input,guard,emit){
   const snapshot=await resolve('gemini',input);guard.assertActive();
   const held=lease(snapshot,guard,()=>{});
   try{await providerAdapters({...config,geminiKey:snapshot.key},{resolveModel:async()=>snapshot.model}).generate(input,held.guard,emit);}
   finally{held.close();}
  },
  audio(guard,emit,failed,ready){
   let peer:AudioConnection|undefined,closed=false,cleanup:()=>void=()=>{};
   const close=()=>{if(closed)return;closed=true;guard.signal.removeEventListener('abort',close);cleanup();peer?.close();};
   const fail=()=>{if(!closed){close();failed();}};
   guard.signal.addEventListener('abort',close,{once:true});
   void resolve('deepgram').then(snapshot=>{
    if(closed||guard.signal.aborted)return;guard.assertActive();const held=lease(snapshot,guard,fail);cleanup=()=>{held.close();guard.signal.removeEventListener('abort',close);};
    peer=providerAdapters({...config,deepgramKey:snapshot.key}).audio(held.guard,emit,fail,ready);
   }).catch(fail);
   return {write(bytes){if(peer&&!closed)peer.write(bytes);},forceEndTurn(){if(peer&&!closed)peer.forceEndTurn();},close};
  },
 };
}
