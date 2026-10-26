import {accountModelPolicy} from '../accounts/modelPolicy';
import {DEEPGRAM_MODEL,GEMINI_MODEL} from '../accountRelay/protocol';
import {metadataSchema,type Metadata} from './publicMetadata';
import type {Probe} from './discovery';
import type {Envelope,ProviderId} from './vault';

type Rpc=(name:string,args:Record<string,unknown>)=>Promise<any>;
export type SetupProvider='gemini'|'deepgram';
export type SetupStage='SAVE_KEY'|'CHECK_KEY'|'ENABLE_PROVIDER'|'APPROVE_MODEL';
export type SetupResult=
 |{code:'SETUP_COMPLETE';metadata:Metadata;modelId:string}
 |{code:'SETUP_STOPPED';stage:SetupStage;reason:'CONFLICT'|'KEY_REJECTED'|'PROVIDER_UNAVAILABLE'|'MODEL_NOT_AVAILABLE'|'CHANGE_REJECTED';metadata:Metadata|null;modelId:string};

export const setupModel=(provider:SetupProvider)=>provider==='gemini'?GEMINI_MODEL:DEEPGRAM_MODEL;
const defaults={
 gemini:{displayName:'Gemini 3.5 Flash',capabilities:['text','image'] as const},
 deepgram:{displayName:'Live transcription',capabilities:['audio'] as const},
};

interface Dependencies{
 rpc:Rpc;actor:string;session:string;reauthenticatedAt:string;
 digest:(value:string)=>string;seal:(key:string,binding:{provider:ProviderId;credentialId:string})=>Envelope;
 discover:(provider:ProviderId,key:string)=>Promise<Probe>;
}
interface Input{provider:SetupProvider;revision:number;apiKey:string;operationId:string}

/** One Admin confirmation applies the same four audited steps that the advanced
 * form performs separately: encrypted key, metadata check, provider enablement
 * and desktop model approval. Every step uses the existing SQL guards, the same
 * fresh authenticator timestamp and its own immutable operation. The key is
 * kept only in this request and is never returned. */
export async function runProviderSetup(input:Input,deps:Dependencies):Promise<SetupResult>{
 const {rpc,actor,session,reauthenticatedAt,digest}=deps,modelId=setupModel(input.provider);
 const mutate=async(action:'REPLACE'|'TEST'|'CONFIGURE',operationId:string,revision:number,value:unknown,operation:Record<string,unknown>)=>{
  const result=await rpc('cluera_provider_mutate',{p_actor:actor,p_session:session,p_operation:operationId,p_provider:input.provider,p_action:action,
   p_revision:revision,p_digest:digest(JSON.stringify({actor,session,operationId,provider:input.provider,revision,action,...operation})),
   p_reauthenticated_at:reauthenticatedAt,p_input:value});
  if(result?.code==='APPLIED')return metadataSchema.parse(result.metadata);
  if(result?.code==='CONFLICT'||result?.code==='INVALID'||result?.code==='FORBIDDEN')return result.code as 'CONFLICT'|'INVALID'|'FORBIDDEN';
  throw Error();
 };
 const stopped=(stage:SetupStage,reason:Extract<SetupResult,{code:'SETUP_STOPPED'}>['reason'],metadata:Metadata|null):SetupResult=>({code:'SETUP_STOPPED',stage,reason,metadata,modelId});
 const failure=(value:Metadata|'CONFLICT'|'INVALID'|'FORBIDDEN')=>value==='CONFLICT'?'CONFLICT' as const:'CHANGE_REJECTED' as const;

 const credentialId=input.operationId;
 const saved=await mutate('REPLACE',credentialId,input.revision,{credentialId,sealed:deps.seal(input.apiKey,{provider:input.provider,credentialId})},
  {apiKey:input.apiKey});
 if(typeof saved==='string')return stopped('SAVE_KEY',failure(saved),null);

 const probe=await deps.discover(input.provider,input.apiKey);
 const tested=await mutate('TEST',crypto.randomUUID(),saved.revision,probe,{});
 if(typeof tested==='string')return stopped('CHECK_KEY',failure(tested),saved);
 if(tested.probeStatus==='REJECTED')return stopped('CHECK_KEY','KEY_REJECTED',tested);
 if(tested.probeStatus!=='VERIFIED'||!tested.complete)return stopped('CHECK_KEY','PROVIDER_UNAVAILABLE',tested);
 if(!tested.models.some(model=>model.id===modelId&&model.runtimeCompatible))return stopped('CHECK_KEY','MODEL_NOT_AVAILABLE',tested);

 const enabled=await mutate('CONFIGURE',crypto.randomUUID(),tested.revision,{enabled:true,defaultModel:modelId},
  {enabled:true,defaultModel:modelId,fallback:'NONE'});
 if(typeof enabled==='string')return stopped('ENABLE_PROVIDER',failure(enabled),tested);

 const rows=await rpc('account_models_read',{});
 const existing=Array.isArray(rows)?rows.find((row:{modelId?:string;provider?:string})=>row.modelId===modelId&&row.provider===input.provider):undefined;
 const policy=accountModelPolicy.parse({modelId,displayName:existing?.displayName??defaults[input.provider].displayName,provider:input.provider,
  enabled:true,isDefault:true,priority:existing?.priority??100,capabilities:existing?.capabilities??[...defaults[input.provider].capabilities],
  // A real device session is still the acceptance check, so keep an existing declared health and never claim HEALTHY.
  health:existing?.health==='UNAVAILABLE'?'UNVERIFIED':existing?.health??'UNVERIFIED'});
 const approved=await rpc('account_admin_mutate',{p_actor:actor,p_session:session,p_operation:crypto.randomUUID(),p_subject:null,p_action:'MODEL',
  p_reason:`Quick setup approved ${input.provider} ${modelId} for desktop sessions`,p_input:policy});
 if(approved?.code!=='APPLIED')return stopped('APPROVE_MODEL','CHANGE_REJECTED',enabled);
 return {code:'SETUP_COMPLETE',metadata:enabled,modelId};
}
