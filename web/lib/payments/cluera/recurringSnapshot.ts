import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc } from './config';
import { ClueraBillingError } from './contracts';
import { clueraRecurringScheduleSchema, validateClueraRecurringSchedule } from './recurringSchedule';

/** Internal read, no public handler or runtime caller. Requires the unapplied
 * SELECT projection proposal. It neither refreshes nor commits a schedule. */
export async function readClueraRecurringSnapshot(rpc:PaymentRpc,account:{userId:string;sessionId:string},env=process.env) {
  z.uuid().parse(account.userId);z.uuid().parse(account.sessionId);
  const {accountDigest,epoch}=await billingOwner(rpc,env);
  const result=z.object({code:z.literal('ACTIVE'),userId:z.literal(account.userId),snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),
    schedule:clueraRecurringScheduleSchema}).strict().parse(await billingRpc(rpc,'cluera_billing_recurring_snapshot',{
      p_user:account.userId,p_session:account.sessionId,p_account_digest:accountDigest,p_epoch:epoch,
    }));
  try{return {snapshotDigest:result.snapshotDigest,schedule:validateClueraRecurringSchedule(result.schedule)};}
  catch{throw new ClueraBillingError('UNAVAILABLE');}
}
