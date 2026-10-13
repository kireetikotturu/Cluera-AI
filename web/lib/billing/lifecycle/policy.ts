import {sandboxOffer} from '../sandboxCatalog';

/** Pure policy planner, NOT a payment/grant API. Only reconciled server evidence
 * may enter the future transactional writer. The writer must lock the account,
 * settle active usage reservations and refresh spentMs before invoking this code.
 * This module intentionally has no network, timer, environment or DB side effects.
 */
export type Term={transactionId:string;subscriptionId:string|null;offerCode:string;tier:'PRO'|'ENTERPRISE';
  kind:'PACK'|'RECURRING';grantedMs:number;spentMs:number;status:'ACTIVE'|'QUEUED'|'PAUSED'|'ENDED'|'REFUNDED';
  durationMs:number|null;remainingTimeMs:number|null;start:number|null;end:number|null;order:number;
  periodStart:number|null;periodEnd:number|null};
export type Subscription={id:string;tier:'PRO'|'ENTERPRISE';state:'ACTIVE'|'PAST_DUE'|'CANCELED';
  paidThrough:number;graceEnd:number|null;cancelFuture:boolean};
export type BillingAction={key:string;subscriptionId:string;kind:'CANCEL_FUTURE'|'RESCHEDULE';at:number|null};
export type FinancialState={at:number;terms:Term[];subscriptions:Subscription[];actions:BillingAction[]};
export type Purchase={transactionId:string;subscriptionId:string|null;offerCode:string;periodStart:number|null;periodEnd:number|null};
const day=86400000;
const requireValue=(condition:unknown)=>{if(!condition)throw new Error('Invalid reconciled financial state.');};
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
function clone(state:FinancialState):FinancialState{return structuredClone(state);}
function action(state:FinancialState,subscriptionId:string,kind:BillingAction['kind'],at:number|null){
  const key=`${subscriptionId}:${kind}:${at??'end'}`;
  if(!state.actions.some(a=>a.key===key))state.actions.push({key,subscriptionId,kind,at});
}
function validate(state:FinancialState){
  requireValue(safe(state.at)&&state.terms.length<=10000);
  requireValue(new Set(state.terms.map(t=>t.transactionId)).size===state.terms.length);
  requireValue(new Set(state.subscriptions.map(s=>s.id)).size===state.subscriptions.length);
  for(const t of state.terms){
    requireValue(safe(t.grantedMs)&&safe(t.spentMs)&&t.spentMs<=t.grantedMs);
    requireValue(t.kind==='PACK'?(t.end===null&&t.subscriptionId===null):
      (t.subscriptionId!==null&&t.durationMs!==null&&safe(t.durationMs)&&t.durationMs>0));
    if(t.status==='ACTIVE'&&t.kind==='RECURRING')requireValue(t.start!==null&&t.end!==null&&t.end>t.start);
    if(t.status==='PAUSED')requireValue(t.remainingTimeMs!==null&&t.remainingTimeMs>0&&t.kind==='RECURRING');
    requireValue(safe(t.order));
    if(t.kind==='RECURRING')requireValue(state.subscriptions.some(s=>s.id===t.subscriptionId));
  }
  for(const s of state.subscriptions)requireValue(safe(s.paidThrough)&&(s.graceEnd===null||safe(s.graceEnd)));
  requireValue(state.terms.filter(t=>t.kind==='RECURRING'&&t.status==='ACTIVE').length<=1);
}
function activate(term:Term,at:number){
  term.status='ACTIVE';term.start=at;term.end=at+(term.remainingTimeMs??term.durationMs!);term.remainingTimeMs=null;
}
function entitlementHold(state:FinancialState,tier:'PRO'|'ENTERPRISE',at:number){
  return state.subscriptions.filter(s=>s.tier===tier&&s.state==='PAST_DUE'&&s.graceEnd!==null&&s.graceEnd>at)
    .reduce((end,s)=>Math.max(end,s.graceEnd!),at);
}

/** Advance only from trusted server time; delayed reads don't extend queued terms. */
export function advanceFinancialState(input:FinancialState,now:number):FinancialState{
  const state=clone(input);validate(state);requireValue(safe(now)&&now>=state.at);
  let cursor=state.at;
  // At most one transition per retained term. No per-second loop.
  for(let i=0;i<=state.terms.length;i++){
    const active=state.terms.find(t=>t.kind==='RECURRING'&&t.status==='ACTIVE');
    if(active){
      if(active.end!>now)break;
      cursor=active.end!;active.status='ENDED';
      cursor=entitlementHold(state,active.tier,cursor);
    }
    const enterpriseHold=Math.max(entitlementHold(state,'ENTERPRISE',cursor),entitlementHold(state,'PRO',cursor));
    if(enterpriseHold>now)break;
    cursor=Math.max(cursor,enterpriseHold);
    const candidates=state.terms.filter(t=>t.kind==='RECURRING'&&['QUEUED','PAUSED'].includes(t.status))
      .sort((a,b)=>(a.tier==='ENTERPRISE'?0:1)-(b.tier==='ENTERPRISE'?0:1)
        ||(a.status==='PAUSED'?0:1)-(b.status==='PAUSED'?0:1)||a.order-b.order);
    const next=candidates[0];if(!next||cursor>now)break;
    activate(next,cursor);
  }
  state.at=now;validate(state);return state;
}

/** Caller must prove completion, bound transaction/customer/subscription, full
 * catalog amount/period and refunds before committing this plan. */
export function planPurchase(input:FinancialState,purchase:Purchase,now:number):FinancialState{
  validate(input);requireValue(safe(now)&&now>=input.at);
  let state=clone(input);
  const offer=sandboxOffer(purchase.offerCode,'sandbox');
  requireValue(/^txn_[a-z0-9]{26}$/.test(purchase.transactionId));
  const old=state.terms.find(t=>t.transactionId===purchase.transactionId);
  if(old){requireValue(old.offerCode===purchase.offerCode&&old.subscriptionId===purchase.subscriptionId
    &&old.periodStart===purchase.periodStart&&old.periodEnd===purchase.periodEnd);return advanceFinancialState(state,now);}
  const recurring=offer.interval!==null;
  requireValue(recurring?(purchase.subscriptionId!==null&&/^sub_[a-z0-9]{26}$/.test(purchase.subscriptionId)
    &&purchase.periodStart!==null&&purchase.periodEnd!==null&&safe(purchase.periodStart)&&safe(purchase.periodEnd)
    &&purchase.periodEnd>purchase.periodStart&&purchase.periodEnd-purchase.periodStart<=32*day):
    (purchase.subscriptionId===null&&purchase.periodStart===null&&purchase.periodEnd===null));
  if(recurring){
    requireValue(purchase.periodStart!<=now);
    // A renewal is attached to its existing subscription and exact paid period;
    // it must not become a second same-tier purchase or extend a delayed period.
    const prior=state.terms.filter(t=>t.subscriptionId===purchase.subscriptionId).sort((a,b)=>b.order-a.order)[0];
    if(prior){
      const sub=state.subscriptions.find(s=>s.id===purchase.subscriptionId)!;
      requireValue(!sub.cancelFuture&&sub.state!=='CANCELED'&&prior.offerCode===purchase.offerCode
        &&prior.periodEnd===purchase.periodStart&&prior.status==='ACTIVE'&&prior.end===purchase.periodStart
        &&state.at<=purchase.periodStart!);
      // Apply before advancing so a contiguous Enterprise renewal never resumes Pro.
      prior.status='ENDED';sub.state='ACTIVE';sub.graceEnd=null;sub.paidThrough=purchase.periodEnd!;
      state.terms.push({...purchase,tier:offer.tier,kind:'RECURRING',grantedMs:offer.seconds*1000,spentMs:0,
        status:'ACTIVE',durationMs:purchase.periodEnd!-purchase.periodStart!,remainingTimeMs:null,
        start:purchase.periodStart,end:purchase.periodEnd,order:Math.max(...state.terms.map(t=>t.order))+1});
      return advanceFinancialState(state,now);
    }
  }
  state=advanceFinancialState(state,now);
  const term:Term={...purchase,tier:offer.tier,kind:recurring?'RECURRING':'PACK',grantedMs:offer.seconds*1000,
    spentMs:0,status:'ACTIVE',durationMs:recurring?purchase.periodEnd!-purchase.periodStart!:null,
    remainingTimeMs:null,start:recurring?purchase.periodStart:null,end:recurring?purchase.periodEnd:null,
    order:state.terms.reduce((max,t)=>Math.max(max,t.order),0)+1};
  if(!recurring){state.terms.push(term);validate(state);return state;}
  // Late initial evidence needs dedicated reconciliation, not a fresh full term.
  requireValue(purchase.periodEnd!>now);
  let subscription=state.subscriptions.find(s=>s.id===purchase.subscriptionId);
  if(subscription){requireValue(subscription.tier===term.tier);subscription.state='ACTIVE';subscription.graceEnd=null;
    subscription.paidThrough=Math.max(subscription.paidThrough,purchase.periodEnd!);
  }else{subscription={id:purchase.subscriptionId!,tier:term.tier,state:'ACTIVE',paidThrough:purchase.periodEnd!,graceEnd:null,cancelFuture:false};state.subscriptions.push(subscription);}
  const active=state.terms.find(t=>t.kind==='RECURRING'&&t.status==='ACTIVE');
  if(active&&active.tier==='PRO'&&term.tier==='ENTERPRISE'){
    active.remainingTimeMs=active.end!-now;active.status='PAUSED';active.start=null;active.end=null;
    const pro=state.subscriptions.find(s=>s.id===active.subscriptionId)!;pro.cancelFuture=true;action(state,pro.id,'CANCEL_FUTURE',null);
    // Stop every queued Pro renewal too; restore prepaid terms only, never rebill.
    for(const s of state.subscriptions.filter(s=>s.tier==='PRO')){s.cancelFuture=true;action(state,s.id,'CANCEL_FUTURE',null);}
  }else if(active||entitlementHold(state,'ENTERPRISE',now)>now){
    term.status='QUEUED';term.start=null;term.end=null;
    if(term.tier==='PRO'&&(active?.tier==='ENTERPRISE'||entitlementHold(state,'ENTERPRISE',now)>now)){
      subscription.cancelFuture=true;action(state,subscription.id,'CANCEL_FUTURE',null);
    }
  }
  state.terms.push(term);
  // Paid same-tier cycles queue. Only the newest purchased subscription may renew;
  // its billing date must be moved beyond every already-paid cycle before enabling
  // checkout acceptance. Actions are durable-outbox requirements, not API calls here.
  if(term.status==='QUEUED'&&active?.tier===term.tier){
    const end=active.end!+state.terms.filter(t=>t.status==='QUEUED'&&t.tier===term.tier).reduce((sum,t)=>sum+t.durationMs!,0);
    for(const s of state.subscriptions.filter(s=>s.tier===term.tier&&s.id!==term.subscriptionId)){
      s.cancelFuture=true;action(state,s.id,'CANCEL_FUTURE',null);
    }
    action(state,term.subscriptionId!,'RESCHEDULE',end);
  }
  validate(state);return state;
}

export function planPaymentFailure(input:FinancialState,subscriptionId:string,now:number):FinancialState{
  // Record the grace boundary before advancing; duplicates never extend it.
  const state=clone(input),sub=state.subscriptions.find(s=>s.id===subscriptionId);requireValue(sub);
  if(sub!.state==='CANCELED'||sub!.cancelFuture)return advanceFinancialState(state,now);
  sub!.state='PAST_DUE';sub!.graceEnd=sub!.graceEnd??sub!.paidThrough+day;
  return advanceFinancialState(state,now);
}
export function planCancellation(input:FinancialState,subscriptionId:string,now:number):FinancialState{
  const state=advanceFinancialState(input,now),sub=state.subscriptions.find(s=>s.id===subscriptionId);requireValue(sub);
  sub!.cancelFuture=true;sub!.state='CANCELED';sub!.graceEnd=null;
  // Paid term unchanged; no early removal, no new allowance.
  return state;
}
export function planFullRefund(input:FinancialState,transactionId:string,now:number):FinancialState{
  const state=advanceFinancialState(input,now),term=state.terms.find(t=>t.transactionId===transactionId);requireValue(term);
  term!.status='REFUNDED';term!.remainingTimeMs=null;
  // Retain grant/spend evidence; availability() removes only this purchase's unused balance.
  // A refund is not an instruction to cancel future billing. Subscription
  // cancellation must be independently reconciled, never inferred from a refund.
  if(term!.subscriptionId){const sub=state.subscriptions.find(s=>s.id===term!.subscriptionId)!;
    if(sub.paidThrough===term!.periodEnd)sub.graceEnd=null;
  }
  return advanceFinancialState(state,now);
}
export function financialAvailability(state:FinancialState){
  validate(state);
  return state.terms.filter(t=>t.status==='ACTIVE').reduce((sum,t)=>sum+t.grantedMs-t.spentMs,0);
}
