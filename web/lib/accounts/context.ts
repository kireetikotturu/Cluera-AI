import { z } from 'zod';
import { AccountError } from './config';
import { SupabaseOperationError } from '../supabase/diagnostics';

// Independent server boundary: web deployments do not need the desktop package
// or its dependency tree. This validates the same narrow native wire contract.
const contextCommand=z.discriminatedUnion('action',[
  z.object({action:z.literal('LIST')}).strict(),
  z.object({action:z.literal('READ'),ids:z.array(z.uuid()).max(8)}).strict(),
  z.object({action:z.literal('SAVE'),operationId:z.uuid(),id:z.uuid(),kind:z.enum(['RESUME','JOB_DESCRIPTION','SUPPORTING','INSTRUCTIONS']),
    name:z.string().trim().min(1).max(120),body:z.string().trim().min(1).max(120000).refine(value=>Buffer.byteLength(value)<=120000)}).strict(),
  z.object({action:z.literal('DELETE'),operationId:z.uuid(),id:z.uuid()}).strict(),
]);

export async function accountContextCommand(rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown;status?:number}>,
  account:{userId:string;sessionId:string}, input:unknown) {
  const parsed=contextCommand.safeParse(input);
  if(!parsed.success)throw new AccountError('INVALID_INPUT',400);
  const command=parsed.data;
  const {data,error,status}=await rpc('customer_context_command',{
    p_user:account.userId,p_session:account.sessionId,p_input:command,
  });
  if(error)throw new SupabaseOperationError('account.workspace',error,status);
  const result=data as {code?:string};
  if(['INVALID','CAPACITY','CONFLICT'].includes(result?.code??''))throw new AccountError('INVALID_INPUT',400);
  if(result?.code!=='ACTIVE')throw new AccountError(result?.code==='UNAUTHENTICATED'?'UNAUTHENTICATED':'FORBIDDEN',result?.code==='UNAUTHENTICATED'?401:403);
  return data;
}
