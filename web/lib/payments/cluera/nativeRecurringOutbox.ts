import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc } from './config';
import { bindingSchema, ClueraBillingError } from './contracts';
import { clueraRazorpayAdapter } from './adapter';
import { clueraNativeRecurringEnabled, clueraNativeRecurringUserAllowed } from './nativeRecurring';

type Gateway=Pick<ReturnType<typeof clueraRazorpayAdapter>,'cancelFuture'|'cancellationStatus'>;
const commandSchema=z.object({code:z.enum(['CLAIMED','OBSERVE']),commandId:z.uuid(),claimId:z.uuid(),userId:z.uuid(),
  subscriptionId:z.string().regex(/^sub_[A-Za-z0-9]{8,64}$/),kind:z.literal('CANCEL_FUTURE')}).strict();
async function ownedCommand(rpc:PaymentRpc,command:z.infer<typeof commandSchema>,digest:string,epoch:number,env:NodeJS.ProcessEnv) {
  if(!clueraNativeRecurringUserAllowed(command.userId,env))throw new ClueraBillingError('CONFIGURATION');
  const raw=await billingRpc(rpc,'cluera_billing_binding',{p_resource:command.subscriptionId,p_account_digest:digest});
  if((raw as {legacy?:unknown})?.legacy===true)throw new ClueraBillingError('INVALID');
  const value={...raw as Record<string,unknown>};delete value.legacy;const binding=bindingSchema.parse(value);
  if(binding.userId!==command.userId||binding.subscriptionId!==command.subscriptionId||binding.code!=='VERIFIED'||binding.revision.kind!=='RECURRING')throw new ClueraBillingError('INVALID');
  const current=await billingOwner(rpc,env);
  if(current.accountDigest!==digest||current.epoch!==epoch)throw new ClueraBillingError('PENDING');
  return binding;
}

/** Prepared worker step: exactly one fresh durable SQL claim permits the fixed
 * end-of-cycle cancellation. RESCHEDULE can never pass the claim schema or SQL
 * dispatcher. Unknown POST outcomes are retained; neither method retries them. */
export async function dispatchClueraNativeRecurringCommand(rpc:PaymentRpc,env=process.env,gateway?:Gateway) {
  if(!clueraNativeRecurringEnabled(env))throw new ClueraBillingError('CONFIGURATION');
  const {accountDigest,epoch}=await billingOwner(rpc,env),owner={p_account_digest:accountDigest,p_epoch:epoch};
  const raw=await billingRpc(rpc,'cluera_billing_native_command_claim',owner);
  if((raw as {code?:unknown})?.code==='EMPTY')return 'EMPTY' as const;
  const command=commandSchema.parse(raw);if(command.code!=='CLAIMED')throw new ClueraBillingError('INVALID');
  const args={...owner,p_id:command.commandId,p_claim:command.claimId};
  try {
    const binding=await ownedCommand(rpc,command,accountDigest,epoch,env);
    const evidence=await(gateway??clueraRazorpayAdapter(env)).cancelFuture(binding);
    return z.enum(['ACCEPTED','DONE','UNCERTAIN']).parse(await billingRpc(rpc,'cluera_billing_native_command_finish',{...args,p_evidence:evidence}));
  }catch {
    await billingRpc(rpc,'cluera_billing_native_command_finish',{...args,p_evidence:null}).catch(()=>undefined);
    return 'UNCERTAIN' as const;
  }
}

/** Independently fetches current canonical state using GET only. A terminal
 * observation closes the original claim; an active result cannot replay POST. */
export async function observeClueraNativeRecurringCommand(rpc:PaymentRpc,env=process.env,gateway?:Gateway) {
  if(!clueraNativeRecurringEnabled(env))throw new ClueraBillingError('CONFIGURATION');
  const {accountDigest,epoch}=await billingOwner(rpc,env),owner={p_account_digest:accountDigest,p_epoch:epoch};
  const raw=await billingRpc(rpc,'cluera_billing_native_command_observation',owner);
  if((raw as {code?:unknown})?.code==='EMPTY')return 'EMPTY' as const;
  const command=commandSchema.parse(raw);if(command.code!=='OBSERVE')throw new ClueraBillingError('INVALID');
  try {
    const binding=await ownedCommand(rpc,command,accountDigest,epoch,env);
    const evidence=await(gateway??clueraRazorpayAdapter(env)).cancellationStatus(binding);
    return z.enum(['ACCEPTED','DONE','UNCERTAIN']).parse(await billingRpc(rpc,'cluera_billing_native_command_finish',{...owner,p_id:command.commandId,p_claim:command.claimId,p_evidence:evidence}));
  }catch {return 'UNCERTAIN' as const;}
}
