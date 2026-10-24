import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc } from './config';
import { ClueraBillingError, planId, revisionSchema } from './contracts';
import { liveBillingProfile } from './modeProfile';
import { clueraTestPlanTransport } from './transport';
import { testPlanInput, testPlanOperation, type TestPlanOperation } from './planSyncContracts';

type Admin = {p_actor:string;p_session:string;p_reauthenticated_at:string};
type Create = {action:'CREATE_TEST_PLAN';operationId:string;offerCode:string;expectedRevisionId:string;reason:string;input:z.infer<typeof testPlanInput>};
type Recover = {action:'RECONCILE_TEST_PLAN';operationId:string;input:{razorpayPlanId:string|null}};
const pending = {code:'PENDING'} as const;
function assertTest(env:NodeJS.ProcessEnv) {
  if (liveBillingProfile(env) || env.RAZORPAY_ENVIRONMENT !== 'test') throw new ClueraBillingError('CONFIGURATION');
}
function verify(op:TestPlanOperation, raw:unknown) {
  const value = z.object({id:planId,entity:z.literal('plan'),period:z.literal('monthly'),interval:z.literal(1),
    item:z.object({name:z.literal(op.input.name),amount:z.literal(op.input.amountPaise),currency:z.literal('INR'),active:z.literal(true),
      unit_amount:z.literal(op.input.amountPaise).optional(),tax_rate:z.null().optional(),tax_id:z.null().optional(),tax_group_id:z.null().optional()}),
    notes:z.object({cluera_operation:z.literal(op.operationId),cluera_revision:z.literal(op.expectedRevisionId),cluera_environment:z.literal('test')})}).parse(raw);
  if (op.razorpayPlanId !== value.id) throw new ClueraBillingError('PENDING');
  return {planId:value.id,period:'monthly',interval:1,amountPaise:op.input.amountPaise,currency:'INR',observedAt:new Date().toISOString()};
}

/** A committed claim permits exactly one POST. Every recovery path performs GET only. */
export async function syncTestPlan(rpc:PaymentRpc, admin:Admin, input:Create|Recover, env=process.env, request:typeof fetch=fetch) {
  assertTest(env);
  const owner=await billingOwner(rpc,env), api=clueraTestPlanTransport(env,request);
  const args={...admin,p_operation:input.operationId,p_account_digest:owner.accountDigest,p_epoch:owner.epoch};
  if (input.action === 'CREATE_TEST_PLAN') {
    const result=await billingRpc(rpc,'cluera_billing_plan_sync_claim',{...args,p_offer:input.offerCode,
      p_expected_revision:input.expectedRevisionId,p_reason:input.reason,p_input:input.input}) as {code?:unknown};
    if (['ALREADY_MAPPED','CONFLICT','FORBIDDEN','INVALID'].includes(String(result.code))) return {code:'NOT_CREATED'} as const;
    if (result.code !== 'CLAIMED') return pending;
    // Never repeat this POST, including on transport failure or an unreadable response.
    const created=z.object({id:planId}).parse(await api('/plans',{period:'monthly',interval:1,
      item:{name:input.input.name,amount:input.input.amountPaise,currency:'INR'},
      notes:{cluera_operation:input.operationId,cluera_revision:input.expectedRevisionId,cluera_environment:'test'}}));
    if (await billingRpc(rpc,'cluera_billing_plan_sync_bind',{...args,p_plan:created.id}) !== 'BOUND') return pending;
  }
  const read=await billingRpc(rpc,'cluera_billing_plan_sync_read',{p_actor:admin.p_actor,p_session:admin.p_session,p_operation:input.operationId}) as {code?:unknown;operation?:unknown;revision?:unknown};
  if (read.code === 'APPLIED') return {code:'APPLIED',revision:revisionSchema.parse(read.revision)};
  if (read.code !== 'PENDING') return pending;
  let op=testPlanOperation.parse(read.operation);
  if (input.action === 'RECONCILE_TEST_PLAN' && input.input.razorpayPlanId) {
    const candidate=planId.parse(input.input.razorpayPlanId);
    if (op.razorpayPlanId && op.razorpayPlanId !== candidate) return pending;
    // A manually recovered ID must match this exact operation's canonical notes and price.
    verify({...op,razorpayPlanId:candidate},await api(`/plans/${candidate}`));
    if (await billingRpc(rpc,'cluera_billing_plan_sync_bind',{...args,p_plan:candidate}) !== 'BOUND') return pending;
    op={...op,razorpayPlanId:candidate};
  }
  if (!op.razorpayPlanId) return pending;
  const evidence=verify(op,await api(`/plans/${op.razorpayPlanId}`));
  const currentOwner=await billingOwner(rpc,env);
  if (owner.accountDigest !== currentOwner.accountDigest || owner.epoch !== currentOwner.epoch) return pending;
  const result=await billingRpc(rpc,'cluera_billing_plan_sync_finish',{...args,p_evidence:evidence}) as {code?:unknown;revision?:unknown};
  return result.code === 'APPLIED' ? {code:'APPLIED',revision:revisionSchema.parse(result.revision)} : pending;
}
