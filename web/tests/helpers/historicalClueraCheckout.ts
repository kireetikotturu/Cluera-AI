import { expect } from 'vitest';
import { billingOwner } from '../../lib/payments/cluera/config';
import type { PaymentRpc } from '../../lib/payments/core/types';
import type { clueraRazorpayAdapter } from '../../lib/payments/cluera/adapter';

/** Synthetic PostgreSQL fixture for pre-existing subscriptions. New sales now
 * require native lifecycle+cancellation; historical signed receipts must still
 * settle through the old financial reader. Never exported by application code. */
export async function seedHistoricalClueraCheckout(rpc:PaymentRpc,account:{userId:string;sessionId:string},
  requestId:string,revisionId:string,env:NodeJS.ProcessEnv,adapter:ReturnType<typeof clueraRazorpayAdapter>){
  const {accountDigest,epoch}=await billingOwner(rpc,env);
  const result=await rpc('cluera_billing_prepare',{p_user:account.userId,p_session:account.sessionId,
    p_request:requestId,p_revision:revisionId,p_account_digest:accountDigest,p_epoch:epoch});
  const claim=result.data as {code:string;intentId:string;attemptId:string;revision:Parameters<typeof adapter.create>[1]};
  expect(result.error).toBeNull();expect(claim.code).toBe('CLAIMED');
  const resource=await adapter.create(claim.intentId,claim.revision);
  expect((await rpc('cluera_billing_bind',{p_intent:claim.intentId,p_attempt:claim.attemptId,
    p_account_digest:accountDigest,p_epoch:epoch,p_resource:resource})).data).toBe('BOUND');
  return {code:'BOUND',...resource,amountPaise:claim.revision.amountPaise};
}
