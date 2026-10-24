import {z} from 'zod';
import {providerId,envelopeSchema,type ProviderId,type Envelope} from './vault';
import {modelSummary,modelId} from './discovery';

import {metadataListSchema} from './publicMetadata';
import {AccountError} from '../accounts/config';
export {metadataSchema,type Metadata} from './publicMetadata';
const storedSchema=z.object({provider:providerId,revision:z.number().int().positive(),credential_id:z.uuid(),sealed:envelopeSchema,enabled:z.boolean(),default_model:modelId.nullable(),probe_status:z.enum(['UNVERIFIED','VERIFIED','REJECTED','UNAVAILABLE']),probe_at:z.iso.datetime({offset:true}).nullable(),models:z.array(modelSummary).max(1000),complete:z.boolean(),updated_at:z.iso.datetime({offset:true})}).strict();
export type Stored=z.infer<typeof storedSchema>;
export type Rpc=(name:string,args:Record<string,unknown>)=>Promise<unknown>;
export async function readSealed(rpc:Rpc,provider:ProviderId):Promise<Stored>{
 const row=storedSchema.parse(await rpc('cluera_provider_read',{p_provider:provider}));
 if(row.provider!==provider)throw Error('Provider unavailable.');return row;
}
export async function listMetadata(rpc:Rpc,actor:string,session:string){
 const result=await rpc('cluera_provider_admin_read',{p_actor:actor,p_session:session});
 if((result as {code?:unknown}|null)?.code==='FORBIDDEN')throw new AccountError('FORBIDDEN',403);
 const r=metadataListSchema.parse(result);
 if(new Set(r.providers.map(x=>x.provider)).size!==r.providers.length)throw Error('Provider unavailable.');return r;
}
export type Replacement={credentialId:string;sealed:Envelope};
