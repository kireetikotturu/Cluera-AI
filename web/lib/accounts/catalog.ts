import {z} from 'zod';
import {sandboxOffers} from '../billing/sandboxCatalog';
import {accountClients} from './clients';
import {stagingAccountConfig} from './workspace';
import {AccountError} from './config';
import {SupabaseOperationError} from '../supabase/diagnostics';

const policySchema=z.array(z.object({code:z.string(),name:z.string().min(2).max(80),enabled:z.boolean(),priority:z.number().int().min(0).max(1000)}).strict()).length(4);
export function approvedCatalog(value:unknown){
 const policies=policySchema.parse(value);
 if(new Set(policies.map(p=>p.code)).size!==4)throw new AccountError('UNAVAILABLE',503);
 return policies.map(p=>{const offer=sandboxOffers.find(o=>o.code===p.code);if(!offer)throw new AccountError('UNAVAILABLE',503);
  return {...offer,name:p.name,enabled:p.enabled,priority:p.priority};}).sort((a,b)=>a.priority-b.priority||a.code.localeCompare(b.code));
}
export async function readAccountCatalog(){
 const {service}=accountClients(stagingAccountConfig());
 const {data,error,status}=await service.rpc('account_catalog_read');
 if(error)throw new SupabaseOperationError('account.admin',error,status);
 return approvedCatalog(data);
}
