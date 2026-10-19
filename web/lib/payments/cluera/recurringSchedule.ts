import { z } from 'zod';
import { bindingSchema, invoiceId, orderId, paymentId, subscriptionId, type Binding, type BillingEvidence } from './contracts';

/** Cluera-native policy for independently verified recurring invoices. No
 * environment, provider calls, Paddle aliases or financial writer lives here.
 * Integration MUST hold the account/receipt lease, settle affected reservations,
 * refresh spentMs and atomically persist grants + schedule + required outbox.
 */
const ms = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tier = (offer: string): 'PRO' | 'ENTERPRISE' => offer === 'cluera_monthly_200h_v2' ? 'ENTERPRISE' : 'PRO';
const offers = z.enum(['cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2']);
const term = z.object({ invoiceId, paymentId, orderId, subscriptionId, revisionId:z.uuid(), offerCode:offers,
  amountPaise:ms, grantedMs:ms, spentMs:ms, reservedMs:ms, periodStart:ms, periodEnd:ms, paidAt:ms,
  state:z.enum(['ACTIVE','SUSPENDED','QUEUED','PRESERVED','ENDED','REFUNDED']), startsAt:ms.nullable(), endsAt:ms.nullable(),
  remainingWallMs:ms.nullable(), closedAt:ms.nullable(), sequence:ms }).strict();
const subscription = z.object({ subscriptionId, revisionId:z.uuid(), offerCode:offers,
  state:z.enum(['ACTIVE','PAST_DUE','PAUSED','CANCELED']), observedAt:ms, paidThrough:ms,
  graceUntil:ms.nullable(), cancellationAt:ms.nullable(), stopRequestedAt:ms.nullable() }).strict();
const action = z.object({ key:z.string().min(1).max(256), subscriptionId,
  kind:z.enum(['CANCEL_FUTURE','RESCHEDULE']), at:ms.nullable() }).strict();
export const clueraRecurringScheduleSchema = z.object({ at:ms,terms:z.array(term).max(10_000),
  subscriptions:z.array(subscription).max(10_000),actions:z.array(action).max(20_000) }).strict();
export type ClueraRecurringSchedule = z.infer<typeof clueraRecurringScheduleSchema>;
type Term = z.infer<typeof term>;
type Subscription = z.infer<typeof subscription>;
export class ClueraScheduleError extends Error {
  constructor(readonly code:'INVALID'|'RESERVATIONS_REQUIRE_SETTLEMENT'|'RENEWAL_REQUIRES_REVIEW') { super('Recurring schedule requires verification.'); }
}
function requireValue(value:unknown):asserts value { if(!value)throw new ClueraScheduleError('INVALID'); }
const unique = (values:string[]) => new Set(values).size===values.length;
const day=86_400_000;

function checked(input:ClueraRecurringSchedule):ClueraRecurringSchedule {
  const state=clueraRecurringScheduleSchema.parse(input);
  requireValue(unique(state.terms.map(value=>value.invoiceId))&&unique(state.terms.map(value=>value.paymentId))
    &&unique(state.terms.map(value=>value.orderId))&&unique(state.subscriptions.map(value=>value.subscriptionId))
    &&unique(state.actions.map(value=>value.key))&&state.terms.filter(value=>value.state==='ACTIVE'||value.state==='SUSPENDED').length<=1);
  for(const value of state.terms) {
    requireValue(value.periodEnd>value.periodStart&&value.periodEnd-value.periodStart>=27*day&&value.periodEnd-value.periodStart<=32*day
      &&value.spentMs+value.reservedMs<=value.grantedMs&&value.grantedMs>0&&value.amountPaise>=100
      &&state.subscriptions.some(item=>item.subscriptionId===value.subscriptionId&&item.revisionId===value.revisionId&&item.offerCode===value.offerCode));
    if(value.state==='ACTIVE'||value.state==='SUSPENDED')requireValue(value.startsAt!==null&&value.endsAt!==null&&value.endsAt>value.startsAt&&value.remainingWallMs===null);
    if(value.state==='QUEUED'||value.state==='PRESERVED')requireValue(value.startsAt===null&&value.endsAt===null&&value.remainingWallMs!==null&&value.remainingWallMs>0&&value.reservedMs===0);
    if(value.state==='ENDED'||value.state==='REFUNDED')requireValue(value.closedAt!==null);
  }
  for(const value of state.subscriptions) {
    requireValue(value.state!=='CANCELED'||value.cancellationAt!==null);
    requireValue(value.graceUntil===null||value.graceUntil===value.paidThrough+day);
  }
  for(const value of state.actions)requireValue(state.subscriptions.some(item=>item.subscriptionId===value.subscriptionId)
    &&(value.kind==='CANCEL_FUTURE'?value.at===null:value.at!==null));
  return state;
}
export const validateClueraRecurringSchedule = checked;
const subscriptionFor = (state:ClueraRecurringSchedule,id:string):Subscription => state.subscriptions.find(value=>value.subscriptionId===id)!;
function settled(value:Term){if(value.reservedMs!==0)throw new ClueraScheduleError('RESERVATIONS_REQUIRE_SETTLEMENT');}
function end(value:Term,at:number){settled(value);value.state='ENDED';value.closedAt=at;value.remainingWallMs=null;}
function enqueue(state:ClueraRecurringSchedule,id:string,kind:'CANCEL_FUTURE'|'RESCHEDULE',at:number|null) {
  const key=`${id}:${kind}:${at??'end'}`;
  // This array expresses current desired commands, not the immutable execution
  // audit. A durable outbox must fence a superseded reschedule before dispatch.
  state.actions=state.actions.filter(value=>value.subscriptionId!==id||value.kind!=='RESCHEDULE');
  if(!state.actions.some(value=>value.key===key))state.actions.push({key,subscriptionId:id,kind,at});
}
function stopFuture(state:ClueraRecurringSchedule,value:Subscription,at:number) {
  value.stopRequestedAt??=at;value.graceUntil=null;enqueue(state,value.subscriptionId,'CANCEL_FUTURE',null);
}
function latest(state:ClueraRecurringSchedule,id:string) {
  return state.terms.filter(value=>value.subscriptionId===id).sort((a,b)=>b.periodStart-a.periodStart||b.sequence-a.sequence)[0];
}
/** Missing renewal delivery is not proof that Enterprise ended. A preserved
 * Pro term remains held until independently known cancellation, fixed grace
 * expiry or a full refund of the latest Enterprise cycle resolves that hold. */
function proRelease(state:ClueraRecurringSchedule,cursor:number,now:number):number|null {
  for(const value of state.subscriptions.filter(item=>tier(item.offerCode)==='ENTERPRISE')) {
    const last=latest(state,value.subscriptionId);if(!last)continue;
    if(last.state==='REFUNDED'){cursor=Math.max(cursor,last.closedAt??cursor);continue;}
    if(value.state==='ACTIVE'||value.state==='PAUSED')return null;
    if(value.state==='PAST_DUE') {
      if(value.graceUntil===null||value.graceUntil>now)return null;
      cursor=Math.max(cursor,value.graceUntil);
    } else cursor=Math.max(cursor,value.cancellationAt??cursor);
  }
  return cursor;
}
function rescheduleQueued(state:ClueraRecurringSchedule) {
  const active=state.terms.find(value=>value.state==='ACTIVE'||value.state==='SUSPENDED');if(!active)return;
  let cursor=active.endsAt!;
  for(const value of state.terms.filter(item=>item.state==='QUEUED'&&tier(item.offerCode)===tier(active.offerCode)).sort((a,b)=>a.sequence-b.sequence)) {
    cursor=Math.max(cursor,value.periodStart)+value.remainingWallMs!;
    const sub=subscriptionFor(state,value.subscriptionId);
    if(sub.stopRequestedAt===null&&sub.subscriptionId!==active.subscriptionId)enqueue(state,value.subscriptionId,'RESCHEDULE',cursor);
  }
}

export function emptyClueraRecurringSchedule(at:number):ClueraRecurringSchedule {
  return checked({at,terms:[],subscriptions:[],actions:[]});
}
/** Trusted server time only. Activation anchors to known term/grace/refund
 * boundaries, so a delayed dashboard read cannot mint a fresh full month. */
export function advanceClueraRecurringSchedule(input:ClueraRecurringSchedule,now:number):ClueraRecurringSchedule {
  const state=checked(input);requireValue(Number.isSafeInteger(now)&&now>=state.at);
  let cursor=state.terms.filter(value=>['ENDED','REFUNDED'].includes(value.state)&&value.closedAt!==null)
    .reduce((at,value)=>Math.max(at,value.closedAt!),0)||state.at;
  for(let count=0;count<=state.terms.length;count++) {
    const active=state.terms.find(value=>value.state==='ACTIVE'||value.state==='SUSPENDED');
    if(active) {
      const sub=subscriptionFor(state,active.subscriptionId);
      if(active.endsAt!>now)break;
      if(sub.state==='PAST_DUE'&&sub.stopRequestedAt===null&&sub.paidThrough===active.periodEnd&&sub.graceUntil!==null&&sub.graceUntil>active.endsAt!) {
        active.endsAt=sub.graceUntil;if(active.endsAt>now)break;
      }
      cursor=active.endsAt!;end(active,cursor);
    }
    const next=state.terms.filter(value=>value.state==='QUEUED'||value.state==='PRESERVED')
      .sort((a,b)=>(tier(a.offerCode)==='ENTERPRISE'?0:1)-(tier(b.offerCode)==='ENTERPRISE'?0:1)
        ||(a.state==='PRESERVED'?0:1)-(b.state==='PRESERVED'?0:1)||a.sequence-b.sequence)[0];
    if(!next)break;
    if(tier(next.offerCode)==='PRO') {const release=proRelease(state,cursor,now);if(release===null)break;cursor=release;}
    cursor=Math.max(cursor,next.periodStart);if(cursor>now)break;
    const wasQueued=next.state==='QUEUED',sub=subscriptionFor(state,next.subscriptionId);
    next.state=sub.state==='PAUSED'?'SUSPENDED':'ACTIVE';next.startsAt=cursor;next.endsAt=cursor+next.remainingWallMs!;next.remainingWallMs=null;
    if(wasQueued&&sub.stopRequestedAt===null&&next.endsAt!==next.periodEnd)enqueue(state,next.subscriptionId,'RESCHEDULE',next.endsAt);
  }
  state.at=now;rescheduleQueued(state);return checked(state);
}

/** Must receive the adapter's complete canonical paid-invoice evidence, never
 * a browser callback. Exactly-once identity includes invoice/payment/order and
 * the immutable catalog revision, price, allowance and original paid period. */
export function planClueraPaidInvoice(input:ClueraRecurringSchedule,binding:Binding,evidence:BillingEvidence,now:number):ClueraRecurringSchedule {
  bindingSchema.parse(binding);requireValue(binding.revision.kind==='RECURRING'&&evidence.action==='GRANT'
    &&binding.subscriptionId!==null&&evidence.subscriptionId===binding.subscriptionId&&evidence.intentId===binding.intentId
    &&evidence.amountPaise===binding.revision.amountPaise&&evidence.currency==='INR'&&evidence.refundId===null
    &&(evidence.subscriptionState==='ACTIVE'||evidence.subscriptionState==='CANCELED'));
  invoiceId.parse(evidence.invoiceId);paymentId.parse(evidence.paymentId);orderId.parse(evidence.orderId);
  const start=Date.parse(evidence.periodStart??''),finish=Date.parse(evidence.periodEnd??''),paid=Date.parse(evidence.paidAt??''),observed=Date.parse(evidence.observedAt);
  requireValue([now,start,finish,paid,observed].every(Number.isSafeInteger)&&start>=0&&start<=now+32*day&&finish-start>=27*day&&finish-start<=32*day
    &&paid>0&&paid<=now+5000&&observed<=now+5000&&observed>=now-90_000);
  if(evidence.cancellationAt!==null)requireValue(Number.isSafeInteger(Date.parse(evidence.cancellationAt))&&paid<=Date.parse(evidence.cancellationAt));
  const original=checked(input);requireValue(now>=original.at);
  const old=original.terms.find(value=>value.invoiceId===evidence.invoiceId);
  if(old) {
    requireValue(old.paymentId===evidence.paymentId&&old.orderId===evidence.orderId&&old.subscriptionId===binding.subscriptionId
      &&old.revisionId===binding.revision.revisionId&&old.offerCode===binding.revision.offerCode&&old.amountPaise===evidence.amountPaise
      &&old.grantedMs===binding.revision.allowanceSeconds*1000&&old.periodStart===start&&old.periodEnd===finish&&old.paidAt===paid);
    return advanceClueraRecurringSchedule(original,now);
  }
  requireValue(!original.terms.some(value=>value.paymentId===evidence.paymentId||value.orderId===evidence.orderId));
  const previous=latest(original,binding.subscriptionId),existing=original.subscriptions.find(value=>value.subscriptionId===binding.subscriptionId);
  if(existing) {
    requireValue(existing.revisionId===binding.revision.revisionId&&existing.offerCode===binding.revision.offerCode);
    if(!previous||previous.periodEnd!==start||previous.state==='PRESERVED'
      ||(existing.stopRequestedAt!==null&&paid>existing.stopRequestedAt)
      ||(existing.cancellationAt!==null&&paid>existing.cancellationAt))throw new ClueraScheduleError('RENEWAL_REQUIRES_REVIEW');
  }
  let state=advanceClueraRecurringSchedule(original,now);
  const active=state.terms.find(value=>value.state==='ACTIVE'||value.state==='SUSPENDED');
  if(previous&&active&&active.subscriptionId!==binding.subscriptionId&&start<now)throw new ClueraScheduleError('RENEWAL_REQUIRES_REVIEW');
  let sub=state.subscriptions.find(value=>value.subscriptionId===binding.subscriptionId);
  if(!sub) {
    const cancellationAt=evidence.cancellationAt===null?null:Date.parse(evidence.cancellationAt);
    requireValue(cancellationAt===null||Number.isSafeInteger(cancellationAt)&&cancellationAt<=now+5000);
    sub={subscriptionId:binding.subscriptionId,revisionId:binding.revision.revisionId,offerCode:offers.parse(binding.revision.offerCode),
      state:evidence.subscriptionState!,observedAt:observed,paidThrough:finish,graceUntil:null,cancellationAt,stopRequestedAt:null};state.subscriptions.push(sub);
  } else {sub.paidThrough=finish;sub.graceUntil=null;if(observed>=sub.observedAt){sub.state=evidence.subscriptionState!;sub.observedAt=observed;
    if(evidence.cancellationAt!==null)sub.cancellationAt=Math.min(sub.cancellationAt??Infinity,Date.parse(evidence.cancellationAt));}}
  const next:Term={invoiceId:evidence.invoiceId!,paymentId:evidence.paymentId!,orderId:evidence.orderId!,subscriptionId:binding.subscriptionId,
    revisionId:binding.revision.revisionId,offerCode:offers.parse(binding.revision.offerCode),amountPaise:evidence.amountPaise,
    grantedMs:binding.revision.allowanceSeconds*1000,spentMs:0,reservedMs:0,periodStart:start,periodEnd:finish,paidAt:paid,
    state:finish<=now?'ENDED':start>now?'QUEUED':'ACTIVE',startsAt:start>now?null:start,endsAt:start>now?null:finish,
    remainingWallMs:start>now?finish-start:null,closedAt:finish<=now?finish:null,sequence:state.terms.reduce((max,value)=>Math.max(max,value.sequence),0)+1};
  // A delayed first paid receipt still belongs in the financial ledger, but an
  // already expired invoice cannot pause/preempt current paid access or mint a
  // fresh month when it is finally delivered.
  if(!previous&&finish<=now){state.terms.push(next);return advanceClueraRecurringSchedule(state,now);}
  if(previous) {
    if(active&&active.subscriptionId===binding.subscriptionId&&start<=now)end(active,Math.min(now,active.endsAt!));
    state.terms.push(next);return advanceClueraRecurringSchedule(state,now);
  }
  if(active&&tier(active.offerCode)==='PRO'&&tier(next.offerCode)==='ENTERPRISE') {
    settled(active);const remaining=Math.min(active.endsAt!,subscriptionFor(state,active.subscriptionId).paidThrough)-now;
    if(remaining>0){active.state='PRESERVED';active.startsAt=null;active.endsAt=null;active.remainingWallMs=remaining;}
    else end(active,now);
    for(const value of state.subscriptions.filter(item=>tier(item.offerCode)==='PRO'))stopFuture(state,value,now);
  } else if(active||(tier(next.offerCode)==='PRO'&&proRelease(state,now,now)===null)) {
    next.state='QUEUED';next.startsAt=null;next.endsAt=null;next.remainingWallMs=finish-start;
    if(tier(next.offerCode)==='PRO'&&(!active||tier(active.offerCode)==='ENTERPRISE'))stopFuture(state,sub,now);
    else {
      for(const value of state.subscriptions.filter(item=>tier(item.offerCode)===tier(next.offerCode)&&item.subscriptionId!==sub!.subscriptionId))stopFuture(state,value,now);
    }
  }
  state.terms.push(next);rescheduleQueued(state);return checked(state);
}

/** Apply only a newly fetched authoritative resource state. Notifications may
 * arrive out of order; the webhook name never overrides that current resource. */
export function planClueraRecurringStatus(input:ClueraRecurringSchedule,id:string,stateValue:Subscription['state'],observedAt:number,
  now:number,cancellationAt:number|null=null):ClueraRecurringSchedule {
  const state=checked(input),sub=subscriptionFor(state,id);requireValue(sub&&Number.isSafeInteger(observedAt)&&observedAt<=now+5000&&observedAt>=now-90_000);
  if(observedAt<sub.observedAt)return advanceClueraRecurringSchedule(state,now);
  requireValue(sub.state!=='CANCELED'||stateValue==='CANCELED');
  requireValue(stateValue!=='CANCELED'||cancellationAt!==null&&Number.isSafeInteger(cancellationAt)&&cancellationAt<=now+5000);
  sub.state=stateValue;sub.observedAt=observedAt;
  for(const value of state.terms.filter(item=>item.subscriptionId===id)) {
    if(stateValue==='PAUSED'&&value.state==='ACTIVE'){settled(value);value.state='SUSPENDED';}
    else if(stateValue==='ACTIVE'&&value.state==='SUSPENDED')value.state='ACTIVE';
  }
  if(stateValue==='CANCELED'){sub.cancellationAt=Math.min(sub.cancellationAt??Infinity,cancellationAt!);sub.graceUntil=null;}
  else if(stateValue==='PAST_DUE'&&sub.stopRequestedAt===null)sub.graceUntil??=sub.paidThrough+day;
  else sub.graceUntil=null;
  if(stateValue==='PAST_DUE'&&sub.graceUntil!==null&&sub.graceUntil>now
    &&!state.terms.some(value=>value.state==='ACTIVE'||value.state==='SUSPENDED')) {
    const value=latest(state,id);
    if(value?.state==='ENDED'&&value.periodEnd===sub.paidThrough) {
      settled(value);value.state='ACTIVE';value.startsAt=value.periodStart;value.endsAt=sub.graceUntil;value.closedAt=null;
    }
  }
  return advanceClueraRecurringSchedule(state,now);
}

export function planClueraRecurringFullRefund(input:ClueraRecurringSchedule,id:string,now:number):ClueraRecurringSchedule {
  const state=advanceClueraRecurringSchedule(input,now),value=state.terms.find(item=>item.invoiceId===id);requireValue(value);
  if(value.state==='REFUNDED')return state;
  settled(value);value.state='REFUNDED';value.remainingWallMs=null;value.closedAt=now;
  const sub=subscriptionFor(state,value.subscriptionId);if(sub.paidThrough===value.periodEnd)sub.graceUntil=null;
  return advanceClueraRecurringSchedule(state,now);
}

export function clueraRecurringAvailableMs(input:ClueraRecurringSchedule):number {
  const state=checked(input),active=state.terms.find(value=>value.state==='ACTIVE');
  return active&&active.startsAt!<=state.at&&active.endsAt!>state.at?active.grantedMs-active.spentMs-active.reservedMs:0;
}

/** All paid mutations use the same immutable invoice identity. A refund that
 * arrives before capture writes a tombstone, never a temporary paid upgrade. */
export function planClueraRecurringEvent(input:ClueraRecurringSchedule,binding:Binding,evidence:BillingEvidence,now:number):ClueraRecurringSchedule {
  if(evidence.action==='GRANT')return planClueraPaidInvoice(input,binding,evidence,now);
  bindingSchema.parse(binding);requireValue(binding.revision.kind==='RECURRING'&&binding.subscriptionId!==null
    &&evidence.intentId===binding.intentId&&evidence.subscriptionId===binding.subscriptionId&&evidence.amountPaise===binding.revision.amountPaise&&evidence.currency==='INR');
  if(evidence.action==='STATUS') {
    if(evidence.subscriptionState===null||!input.subscriptions.some(value=>value.subscriptionId===binding.subscriptionId))return advanceClueraRecurringSchedule(input,now);
    return planClueraRecurringStatus(input,binding.subscriptionId,evidence.subscriptionState,Date.parse(evidence.observedAt),now,
      evidence.cancellationAt===null?null:Date.parse(evidence.cancellationAt));
  }
  requireValue(evidence.action==='REFUND'&&evidence.refundId!==null&&/^rfnd_[A-Za-z0-9]{8,64}$/.test(evidence.refundId));
  invoiceId.parse(evidence.invoiceId);paymentId.parse(evidence.paymentId);orderId.parse(evidence.orderId);
  const state=checked(input),value=state.terms.find(item=>item.invoiceId===evidence.invoiceId);
  const start=Date.parse(evidence.periodStart??''),finish=Date.parse(evidence.periodEnd??''),paid=Date.parse(evidence.paidAt??''),observed=Date.parse(evidence.observedAt);
  requireValue([now,start,finish,paid,observed].every(Number.isSafeInteger)&&start>=0&&start<=now+32*day&&finish-start>=27*day&&finish-start<=32*day
    &&paid>0&&paid<=now+5000&&observed<=now+5000&&observed>=now-90_000);
  if(value) {
    requireValue(value.paymentId===evidence.paymentId&&value.orderId===evidence.orderId&&value.subscriptionId===binding.subscriptionId
      &&value.revisionId===binding.revision.revisionId&&value.offerCode===binding.revision.offerCode&&value.amountPaise===evidence.amountPaise
      &&value.grantedMs===binding.revision.allowanceSeconds*1000&&value.periodStart===start&&value.periodEnd===finish&&value.paidAt===paid);
    return planClueraRecurringFullRefund(state,value.invoiceId,now);
  }
  requireValue(!state.terms.some(item=>item.paymentId===evidence.paymentId||item.orderId===evidence.orderId));
  let sub=state.subscriptions.find(item=>item.subscriptionId===binding.subscriptionId);
  if(!sub) {
    const cancellationAt=evidence.cancellationAt===null?null:Date.parse(evidence.cancellationAt);
    sub={subscriptionId:binding.subscriptionId,revisionId:binding.revision.revisionId,offerCode:offers.parse(binding.revision.offerCode),state:evidence.subscriptionState??'ACTIVE',
      observedAt:observed,paidThrough:finish,graceUntil:null,cancellationAt,stopRequestedAt:null};state.subscriptions.push(sub);
  } else requireValue(sub.revisionId===binding.revision.revisionId&&sub.offerCode===binding.revision.offerCode);
  state.terms.push({invoiceId:evidence.invoiceId!,paymentId:evidence.paymentId!,orderId:evidence.orderId!,subscriptionId:binding.subscriptionId,
    revisionId:binding.revision.revisionId,offerCode:offers.parse(binding.revision.offerCode),amountPaise:evidence.amountPaise,grantedMs:binding.revision.allowanceSeconds*1000,
    spentMs:0,reservedMs:0,periodStart:start,periodEnd:finish,paidAt:paid,state:'REFUNDED',startsAt:null,endsAt:null,remainingWallMs:null,closedAt:now,
    sequence:state.terms.reduce((max,item)=>Math.max(max,item.sequence),0)+1});
  return advanceClueraRecurringSchedule(state,now);
}
