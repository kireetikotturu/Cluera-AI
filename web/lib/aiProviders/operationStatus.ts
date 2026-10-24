import {z} from 'zod';
import {AccountError} from '../accounts/config';
import {metadataSchema,type OperationContext} from './publicMetadata';
import {listMetadata,type Rpc} from './repository';

const auditSchema=z.discriminatedUnion('code',[
 z.object({code:z.literal('NOT_FOUND')}).strict(),
 z.object({code:z.literal('APPLIED'),provider:metadataSchema.shape.provider,metadata:metadataSchema}).strict(),
]);
/** Audit absence is not proof of failure. Monotonic revisions fence late writes;
 * reread the audit after observing advancement to distinguish a racing commit.
 * Only public metadata is read here; no credential or mutation RPC is used. */
export async function verifyProviderOperation(rpc:Rpc,actor:string,session:string,operationId:string,context?:OperationContext){
 const readAudit=async()=>{
  const result=await rpc('cluera_provider_admin_read',{p_actor:actor,p_session:session,p_operation:operationId});
  if((result as {code?:unknown}|null)?.code==='FORBIDDEN')throw new AccountError('FORBIDDEN',403);
  const audit=auditSchema.parse(result);
  if(audit.code==='APPLIED'&&(audit.provider!==audit.metadata.provider||(context&&audit.provider!==context.provider)))throw Error('Operation verification unavailable.');
  if(audit.code==='APPLIED'&&context&&audit.metadata.revision<=context.revision)throw Error('Operation verification unavailable.');
  return audit;
 };
 let audit=await readAudit();
 if(audit.code==='NOT_FOUND'&&!context)return {code:'NOT_RECORDED' as const,operationId,metadata:null};
 const provider=context?.provider??(audit.code==='APPLIED'?audit.provider:undefined);
 const current=(await listMetadata(rpc,actor,session)).providers.find(row=>row.provider===provider)??null;
 if((current?.revision??0)<(context?.revision??0))throw Error('Operation verification unavailable.');
 if(audit.code==='NOT_FOUND'&&current&&context&&current.revision>context.revision)audit=await readAudit();
 if(audit.code==='APPLIED'){
  if(!current||current.revision<audit.metadata.revision)throw Error('Operation verification unavailable.');
  return {code:'APPLIED' as const,operationId,metadata:current};
 }
 if(current&&context&&current.revision>context.revision)return {code:'SUPERSEDED' as const,operationId,metadata:current};
 return {code:'NOT_RECORDED' as const,operationId,metadata:current};
}
