import { z } from 'zod';
import { schedulerEnabled } from '../../../../shared/billingDispatch';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc, clueraIntakeEnabled } from './config';
import { bindingSchema, ClueraBillingError, type BillingEvidence, type Binding } from './contracts';
import { clueraRecurringScheduleSchema, ClueraScheduleError, planClueraRecurringEvent } from './recurringSchedule';

export function clueraNativeRecurringEnabled(env=process.env) {
  return env.CLUERA_RECURRING_SCHEDULE_ENABLED==='true'&&clueraIntakeEnabled(env)&&schedulerEnabled(env)&&env.SIGMAROUND_PAYMENT_PROVIDER==='razorpay';
}
export function clueraNativeRecurringUserAllowed(userId:string,env=process.env) {
  const ids=(env.SIGMAROUND_PAYMENT_TESTER_IDS??'').split(',').map(value=>value.trim());
  return clueraNativeRecurringEnabled(env)&&ids.length<=50&&ids.every(value=>z.uuid().safeParse(value).success)&&ids.includes(userId);
}
export type NativeReceipt={eventId:string;claimId:string;digest:string};
const receiptSchema=z.object({eventId:z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),claimId:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const snapshotSchema=z.object({code:z.literal('ACTIVE'),userId:z.uuid(),version:z.number().int().nonnegative(),
  snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),schedule:clueraRecurringScheduleSchema}).strict();

/** Native financial orchestrator, routed by the worker only under the explicit
 * default-disabled native gate. Receipt+account locks, immutable evidence, live spend,
 * optimistic version and exactly-once application are enforced again in SQL.
 * No provider mutation occurs while calculating or committing entitlements. */
export async function applyClueraNativeRecurringEvent(rpc:PaymentRpc,receipt:NativeReceipt,binding:Binding,evidence:BillingEvidence,env=process.env) {
  if(!clueraNativeRecurringEnabled(env))throw new ClueraBillingError('CONFIGURATION');
  receiptSchema.parse(receipt);bindingSchema.parse(binding);
  if(!clueraNativeRecurringUserAllowed(binding.userId,env))throw new ClueraBillingError('CONFIGURATION');
  if(binding.revision.kind!=='RECURRING'||binding.subscriptionId!==evidence.subscriptionId||binding.intentId!==evidence.intentId)throw new ClueraBillingError('INVALID');
  const {accountDigest,epoch}=await billingOwner(rpc,env);
  const args={p_event:receipt.eventId,p_claim:receipt.claimId,p_digest:receipt.digest,p_account_digest:accountDigest,p_epoch:epoch,p_evidence:evidence};
  let settled=false;
  for(let attempt=0;attempt<3;attempt++) {
    const snapshot=snapshotSchema.parse(await billingRpc(rpc,'cluera_billing_native_snapshot',args));
    if(snapshot.userId!==binding.userId)throw new ClueraBillingError('INVALID');
    let plan;
    try {plan=planClueraRecurringEvent(snapshot.schedule,binding,evidence,snapshot.schedule.at);}
    catch(error) {
      if(!settled&&error instanceof ClueraScheduleError&&error.code==='RESERVATIONS_REQUIRE_SETTLEMENT') {
        settled=true;
        if(await billingRpc(rpc,'cluera_billing_native_settle',args)!=='SETTLED')throw new ClueraBillingError('PENDING');
        continue;
      }
      throw new ClueraBillingError('PENDING');
    }
    const result=z.object({code:z.enum(['VERIFIED','REFUNDED','STATUS','NO_GRANT','CONFLICT'])}).strict().parse(await billingRpc(rpc,'cluera_billing_native_commit',{
      ...args,p_expected_version:snapshot.version,p_expected_digest:snapshot.snapshotDigest,p_plan:plan,
    }));
    if(result.code!=='CONFLICT')return result.code;
  }
  throw new ClueraBillingError('PENDING');
}
