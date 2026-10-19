import { describe, expect, it } from 'vitest';
import { advanceClueraRecurringSchedule as advance, emptyClueraRecurringSchedule as empty, planClueraPaidInvoice as purchase,
  planClueraRecurringStatus as status, planClueraRecurringFullRefund as refund, clueraRecurringAvailableMs as available,
  planClueraRecurringEvent as event, type ClueraRecurringSchedule } from '../lib/payments/cluera/recurringSchedule';
import type { Binding, BillingEvidence } from '../lib/payments/cluera/contracts';

const day=86_400_000,base=100*day;
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const id=(kind:string,n:number)=>`${kind}_clueracycle${String(n).padStart(8,'0')}`;
const iso=(time:number)=>new Date(time).toISOString();
function paid(n:number,offer='cluera_monthly_40h_v2',at=base,subscription=n,periodStart=at,periodEnd=periodStart+30*day) {
  const high=offer==='cluera_monthly_200h_v2',medium=offer==='cluera_monthly_100h_v2';
  const binding:Binding={code:'BOUND',intentId:uuid(subscription+100),userId:uuid(1),orderId:null,subscriptionId:id('sub',subscription),
    revision:{revisionId:uuid(high?203:medium?202:201),offerCode:offer as Binding['revision']['offerCode'],name:'Cluera immutable monthly policy',amountPaise:high?1954900:medium?959900:549900,
      currency:'INR',allowanceSeconds:high?720000:medium?360000:144000,kind:'RECURRING',interval:'MONTH',razorpayPlanId:id('plan',high?3:medium?2:1),
      enabled:true,testPlanValidated:true,totalCount:120,version:1}};
  const evidence:BillingEvidence={action:'GRANT',intentId:binding.intentId,orderId:id('order',n),paymentId:id('pay',n),invoiceId:id('inv',n),subscriptionId:binding.subscriptionId,
    amountPaise:binding.revision.amountPaise,currency:'INR',observedAt:iso(at),periodStart:iso(periodStart),periodEnd:iso(periodEnd),paidAt:iso(at),cancellationAt:null,subscriptionState:'ACTIVE',refundId:null};
  return {binding,evidence,apply:(state:ClueraRecurringSchedule,now=at)=>purchase(state,binding,{...evidence,observedAt:iso(now)},now)};
}
function upgraded(){const first=paid(1).apply(empty(base));first.terms[0].spentMs=1_234_567;return paid(2,'cluera_monthly_200h_v2',base+10*day).apply(first);}
const canceled=(state:ClueraRecurringSchedule,sub:number,at:number)=>status(state,id('sub',sub),'CANCELED',at,at,at);

describe('Cluera-native recurring schedule (not an enabled financial writer)',()=>{
 it('expired first Enterprise receipt records closed paid history without preempting or restarting existing paid Pro',()=>{
   const state=paid(1).apply(empty(base)),late=paid(2,'cluera_monthly_200h_v2',base+day,2,base-40*day,base-10*day),before=structuredClone(state);
   const result=event(state,late.binding,late.evidence,base+day);expect(result.terms.map(value=>value.state)).toEqual(['ACTIVE','ENDED']);
   expect(result.terms[1]).toMatchObject({startsAt:base-40*day,endsAt:base-10*day,closedAt:base-10*day});expect(result.actions).toEqual([]);expect(state).toEqual(before);
 });
 it('latest Enterprise refund holds Pro until independently verified receipt time because evidence has no authoritative refund timestamp',()=>{
   const state=upgraded(),invoice=paid(2,'cluera_monthly_200h_v2',base+10*day),at=base+45*day;
   const result=event(state,invoice.binding,{...invoice.evidence,action:'REFUND',refundId:'rfnd_lateverified0001',observedAt:iso(at)},at);
   expect(result.terms[0]).toMatchObject({state:'ACTIVE',startsAt:at,endsAt:at+20*day,spentMs:1_234_567});
 });
 it('refund before capture is a permanent grantless tombstone and creates no temporary Enterprise upgrade/cancel actions',()=>{
   const current=paid(1).apply(empty(base)),invoice=paid(2,'cluera_monthly_200h_v2',base+day);
   const refunded=event(current,invoice.binding,{...invoice.evidence,action:'REFUND',refundId:'rfnd_beforecapture01'},base+day);
   expect(refunded.terms.map(value=>value.state)).toEqual(['ACTIVE','REFUNDED']);expect(refunded.actions).toEqual([]);
   expect(event(refunded,invoice.binding,{...invoice.evidence,observedAt:iso(base+2*day)},base+2*day).terms[1].state).toBe('REFUNDED');
 });
 it('verified late fixed grace reopens only the original ended cycle with original spend and one fixed deadline',()=>{
   const paidState=paid(1).apply(empty(base));paidState.terms[0].spentMs=777;
   const ended=advance(paidState,base+30*day+1000),grace=status(ended,id('sub',1),'PAST_DUE',base+30*day+2000,base+30*day+2000);
   expect(grace.terms[0]).toMatchObject({state:'ACTIVE',spentMs:777,startsAt:base,endsAt:base+31*day,closedAt:null});
   expect(status(grace,id('sub',1),'PAST_DUE',base+30*day+3000,base+30*day+3000).terms[0].endsAt).toBe(base+31*day);
 });
 it.each([['cluera_monthly_40h_v2',144000000],['cluera_monthly_100h_v2',360000000],['cluera_monthly_200h_v2',720000000]] as const)('grants the immutable%s allowance exactly once with canonical invoice/payment/order identity', (offer,amount)=>{
   const p=paid(1,offer),first=p.apply(empty(base));first.terms[0].spentMs=1000;
   const again=p.apply(first,base+day);expect(again.terms).toHaveLength(1);expect(available(again)).toBe(amount-1000);
   expect(()=>purchase(first,p.binding,{...p.evidence,amountPaise:p.evidence.amountPaise-1},base)).toThrow();
   expect(()=>purchase(first,p.binding,{...p.evidence,paymentId:id('pay',999)},base)).toThrow();
 });
 it('contains no Paddle aliases: old offer/weekly or short/changed cycle and browser callback cannot produce a schedule',()=>{
   const p=paid(1);
   for(const changed of [{...p.evidence,action:'STATUS'},{...p.evidence,periodEnd:iso(base+7*day)},{...p.evidence,periodStart:null},{...p.evidence,invoiceId:null}])
     expect(()=>purchase(empty(base),p.binding,changed as BillingEvidence,base)).toThrow();
   expect(()=>purchase(empty(base),{...p.binding,revision:{...p.binding.revision,offerCode:'enterprise_weekly' as never}},p.evidence,base)).toThrow();
 });
 it('queues40h then100h without replacing current credits and requests old cancellation plus newest billing reschedule',()=>{
   const state=paid(2,'cluera_monthly_100h_v2',base+5*day).apply(paid(1).apply(empty(base)));
   expect(state.terms.map(value=>value.state)).toEqual(['ACTIVE','QUEUED']);expect(available(state)).toBe(144000000);
   expect(state.actions).toEqual(expect.arrayContaining([{key:`${id('sub',1)}:CANCEL_FUTURE:end`,subscriptionId:id('sub',1),kind:'CANCEL_FUTURE',at:null},
     {key:`${id('sub',2)}:RESCHEDULE:${base+60*day}`,subscriptionId:id('sub',2),kind:'RESCHEDULE',at:base+60*day}]));
   const later=advance(state,base+45*day);expect(later.terms[1]).toMatchObject({state:'ACTIVE',startsAt:base+30*day,endsAt:base+60*day});
   expect(available(later)).toBe(360000000);expect(available(advance(later,base+61*day))).toBe(0);
 });
 it('preserves exact unused paid Pro wall-time and spent minutes while Enterprise is active',()=>{
   const state=upgraded();expect(state.terms[0]).toMatchObject({state:'PRESERVED',remainingWallMs:20*day,spentMs:1_234_567,startsAt:null,endsAt:null});
   expect(available(state)).toBe(720000000);expect(state.actions.filter(value=>value.kind==='CANCEL_FUTURE')).toHaveLength(1);
   const held=advance(state,base+41*day);expect(held.terms[0].state).toBe('PRESERVED');expect(available(held)).toBe(0);
   const resumed=canceled(held,2,base+41*day);expect(resumed.terms[0]).toMatchObject({state:'ACTIVE',startsAt:base+41*day,endsAt:base+61*day,spentMs:1_234_567});
   expect(available(resumed)).toBe(144000000-1_234_567);
 });
 it('late dashboard reads anchor restoration to authoritative termination, never a fresh month at read time',()=>{
   const state=upgraded(),ended=status(state,id('sub',2),'CANCELED',base+40*day,base+40*day,base+40*day);
   const later=advance(ended,base+45*day);expect(later.terms[0].endsAt).toBe(base+60*day);
   expect(available(advance(later,base+61*day))).toBe(0);
 });
 it('a contiguous late Enterprise renewal remains paid-period bounded and never resumes Pro between delayed deliveries',()=>{
   let state=advance(upgraded(),base+41*day);const renewal=paid(3,'cluera_monthly_200h_v2',base+41*day,2,base+40*day,base+70*day);
   state=renewal.apply(state);expect(state.terms.map(value=>value.state)).toEqual(['PRESERVED','ENDED','ACTIVE']);
   expect(state.terms[2]).toMatchObject({startsAt:base+40*day,endsAt:base+70*day});expect(available(state)).toBe(720000000);
 });
 it('rejects overdue renewal once preserved Pro has authoritatively resumed, rather than silently overlapping paid history',()=>{
   let state=status(upgraded(),id('sub',2),'PAST_DUE',base+40*day,base+40*day);
   state=advance(state,base+42*day);expect(state.terms[0].state).toBe('ACTIVE');
   expect(()=>paid(3,'cluera_monthly_200h_v2',base+42*day,2,base+40*day,base+70*day).apply(state)).toThrow();
 });
 it('fixed one-day failure grace never fabricates minutes or extends on duplicate observations',()=>{
   let state=upgraded();state.terms[1].spentMs=720000000;
   state=status(state,id('sub',2),'PAST_DUE',base+40*day,base+40*day);expect(available(state)).toBe(0);
   state=status(state,id('sub',2),'PAST_DUE',base+40.5*day,base+40.5*day);expect(state.subscriptions[1].graceUntil).toBe(base+41*day);
   state=advance(state,base+42*day);expect(state.terms[0].endsAt).toBe(base+61*day);
 });
 it('a future funded cycle prevents failure grace from extending the older cycle over already paid renewal time',()=>{
   let state=paid(2,'cluera_monthly_40h_v2',base+day,1,base+30*day,base+60*day).apply(paid(1).apply(empty(base)));
   state=status(state,id('sub',1),'PAST_DUE',base+30*day,base+30*day);
   expect(state.terms.map(value=>value.state)).toEqual(['ENDED','ACTIVE']);expect(state.terms[1].endsAt).toBe(base+60*day);
 });
 it('same-subscription future paid invoices queue on their canonical period without rescheduling normal provider renewals',()=>{
   const state=paid(2,'cluera_monthly_40h_v2',base+day,1,base+30*day,base+60*day).apply(paid(1).apply(empty(base)));
   expect(state.terms.map(value=>value.state)).toEqual(['ACTIVE','QUEUED']);expect(state.actions).toEqual([]);
   expect(advance(state,base+35*day).terms[1]).toMatchObject({state:'ACTIVE',startsAt:base+30*day,endsAt:base+60*day});
 });
 it('refund of latest Enterprise restores only preserved Pro remainder and retains all spend attribution',()=>{
   const state=refund(upgraded(),id('inv',2),base+12*day);
   expect(state.terms[0]).toMatchObject({state:'ACTIVE',endsAt:base+32*day,spentMs:1_234_567});expect(state.terms[1].state).toBe('REFUNDED');
   expect(refund(state,id('inv',2),base+12*day)).toEqual(state);
 });
 it('refund of an older Enterprise cycle cannot release Pro while a newer paid cycle remains active',()=>{
   let state=paid(3,'cluera_monthly_200h_v2',base+40*day,2,base+40*day,base+70*day).apply(upgraded());
   state=refund(state,id('inv',2),base+41*day);expect(state.terms[0].state).toBe('PRESERVED');expect(available(state)).toBe(720000000);
 });
 it('refund of a queued same-tier purchase removes its duration and supersedes the old reschedule target',()=>{
   let state=paid(2,'cluera_monthly_100h_v2',base+day).apply(paid(1).apply(empty(base)));
   state=paid(3,'cluera_monthly_100h_v2',base+2*day).apply(state);expect(state.actions.find(value=>value.subscriptionId===id('sub',3)&&value.kind==='RESCHEDULE')?.at).toBe(base+90*day);
   state=refund(state,id('inv',2),base+3*day);expect(state.actions.filter(value=>value.subscriptionId===id('sub',3)&&value.kind==='RESCHEDULE').map(value=>value.at)).toEqual([base+60*day]);
 });
 it('refund of the active cycle advances a prepaid queue and replaces its future billing target',()=>{
   let state=paid(2,'cluera_monthly_100h_v2',base+day).apply(paid(1).apply(empty(base)));
   state=refund(state,id('inv',1),base+2*day);expect(state.terms[1]).toMatchObject({state:'ACTIVE',startsAt:base+2*day,endsAt:base+32*day});
   expect(state.actions.filter(value=>value.subscriptionId===id('sub',2)&&value.kind==='RESCHEDULE').map(value=>value.at)).toEqual([base+32*day]);
 });
 it('Pro bought during Enterprise queues prepaid time and requests stopping its renewal rather than giving simultaneous credits',()=>{
   const state=paid(2,'cluera_monthly_100h_v2',base+day).apply(paid(1,'cluera_monthly_200h_v2').apply(empty(base)));
   expect(state.terms[1].state).toBe('QUEUED');expect(state.subscriptions[1].stopRequestedAt).toBe(base+day);expect(available(state)).toBe(720000000);
   const ended=canceled(state,1,base+30*day);expect(ended.terms[1]).toMatchObject({startsAt:base+30*day,endsAt:base+60*day});expect(available(ended)).toBe(360000000);
 });
 it('provider pause/resume preserves the original expiry and spent allowance without adopting the upgrade pause policy',()=>{
   let state=paid(1).apply(empty(base));state.terms[0].spentMs=1000;
   state=status(state,id('sub',1),'PAUSED',base+day,base+day);expect(available(state)).toBe(0);expect(state.terms[0].state).toBe('SUSPENDED');
   state=status(state,id('sub',1),'ACTIVE',base+2*day,base+2*day);expect(state.terms[0].endsAt).toBe(base+30*day);expect(available(state)).toBe(144000000-1000);
 });
 it('reserved usage must be settled by the transactional writer before pause, expiry or refund',()=>{
   const original=paid(1).apply(empty(base));original.terms[0].reservedMs=1000;const copy=structuredClone(original);
   for(const operation of [()=>paid(2,'cluera_monthly_200h_v2',base+day).apply(original),()=>advance(original,base+31*day),()=>refund(original,id('inv',1),base+day)])
     expect(operation).toThrow(expect.objectContaining({code:'RESERVATIONS_REQUIRE_SETTLEMENT'}));
   expect(original).toEqual(copy);
 });
 it('cancel-future requirements cannot be followed by a silently granted post-stop renewal',()=>{
   const state=upgraded();expect(()=>paid(3,'cluera_monthly_40h_v2',base+30*day,1,base+30*day,base+60*day).apply(state)).toThrow();
 });
 it('rejects backwards time, overspend, duplicate grant identities and changed paid policy without mutating input',()=>{
   const state=upgraded(),copy=structuredClone(state);advance(state,base+50*day);expect(state).toEqual(copy);
   expect(()=>advance(state,base)).toThrow();state.terms[0].spentMs=state.terms[0].grantedMs+1;expect(()=>available(state)).toThrow();
 });
});
