import { z } from 'zod';
import { accountConfig, AccountError } from './config';
import { accountClients } from './clients';
import { AccountCookies } from './cookies';
import { activeSession, assertAccountOrigin, rateLimit } from './handler';
import { apiError, json, readJsonBody } from '../http';
import { SupabaseOperationError } from '../supabase/diagnostics';
import { STAGING_DATABASE, STAGING_SITE } from '../accountRelay/config';
import {accountContextCommand} from './context';

export function stagingAccountConfig() {
  const config = accountConfig();
  if (config.url !== STAGING_DATABASE || config.origin !== STAGING_SITE) throw new AccountError('UNAVAILABLE',503);
  return config;
}
export async function workspaceRequest(request:Request):Promise<Response> {
  try {
    const config=stagingAccountConfig();
    if(request.method!=='GET')assertAccountOrigin(request,config.origin);
    const clients=accountClients(config),cookies=new AccountCookies(request,config);
    const {account}=await activeSession(clients,cookies);
    if(cookies.get('recovery')===account.sessionId)throw new AccountError('FORBIDDEN',403);
    let action='READ',input:object={};
    if(request.method==='POST'){
      await rateLimit(request,config,clients,account.email);
      const parsed=z.discriminatedUnion('action',[
        z.object({action:z.literal('PROFILE'),displayName:z.string().trim().max(80)}).strict(),
        z.object({action:z.literal('SAVE_CONTEXT'),operationId:z.uuid(),id:z.uuid(),kind:z.enum(['RESUME','JOB_DESCRIPTION','SUPPORTING','INSTRUCTIONS']),
          name:z.string().trim().min(1).max(120),body:z.string().min(1).max(120000).refine(value=>Buffer.byteLength(value)<=120000)}).strict(),
        z.object({action:z.literal('DELETE_CONTEXT'),operationId:z.uuid(),id:z.uuid()}).strict(),
      ]).parse(await readJsonBody(request,768000));
      const {action:chosen,...values}=parsed;action=chosen;input=values;
    } else if(request.method!=='GET')return json({error:'Not found.'},404);
    if(action==='SAVE_CONTEXT'||action==='DELETE_CONTEXT'){
      await accountContextCommand((name,args)=>clients.service.rpc(name,args),account,{...input,action:action==='SAVE_CONTEXT'?'SAVE':'DELETE'});
      action='READ';input={};
    }
    const {data,error,status}=await clients.service.rpc('customer_workspace',{
      p_user:account.userId,p_session:account.sessionId,p_action:action,p_input:input,
    });
    if(error)throw new SupabaseOperationError('account.workspace',error,status);
    if(data?.code!=='ACTIVE')throw new AccountError(data?.code==='UNAUTHENTICATED'?'UNAUTHENTICATED':'FORBIDDEN',data?.code==='UNAUTHENTICATED'?401:403);
    return cookies.apply(json({workspace:data}));
  } catch(error){return error instanceof AccountError?json({error:error.code},error.status):apiError(error);}
}
