import {describe,it,expect} from 'vitest';
import {advanceFinancialState,planPurchase,planPaymentFailure,planCancellation,planFullRefund,
  financialAvailability,type FinancialState,type Purchase} from '../lib/billing/lifecycle/policy';

const day=86400000, start=100*day;
const id=(prefix:string,n:number)=>`${prefix}_${String(n).padStart(26,'0')}`;
const blank=():FinancialState=>({at:start,terms:[],subscriptions:[],actions:[]});
const buy=(n:number,offerCode='pro_40_hours',at=start,days=30,sub=n):Purchase=>({
  transactionId:id('txn',n),subscriptionId:offerCode==='pro_3_hours'?null:id('sub',sub),offerCode,
  periodStart:offerCode==='pro_3_hours'?null:at,periodEnd:offerCode==='pro_3_hours'?null:at+days*day});
const proThenEnterprise=()=>{
  const pro=planPurchase(blank(),buy(1),start);
  pro.terms[0].spentMs=1234567;
  return planPurchase(pro,buy(2,'enterprise_weekly',start+10*day,7),start+10*day);
};

describe('isolated financial policy planner (not an enabled financial writer)',()=>{
  it('stacks packs forever and replay cannot grant twice',()=>{
    let s=planPurchase(blank(),buy(1,'pro_3_hours'),start);
    s=planPurchase(s,buy(2,'pro_3_hours'),start);
    s=planPurchase(s,buy(2,'pro_3_hours'),start+400*day);
    expect(financialAvailability(s)).toBe(21600000);expect(s.terms).toHaveLength(2);
    expect(s.terms.every(t=>t.end===null)).toBe(true);
  });
  it('rejects a changed replay and unsupported catalog',()=>{
    const s=planPurchase(blank(),buy(1),start);
    expect(()=>planPurchase(s,buy(1,'enterprise_weekly'),start)).toThrow();
    expect(()=>planPurchase(blank(),buy(1,'pro_100'),start)).toThrow();
  });
  it('queues a same-tier purchase without resetting current allowance',()=>{
    const s=planPurchase(planPurchase(blank(),buy(1),start),buy(2,'pro_40_hours',start+5*day),start+5*day);
    expect(s.terms.map(t=>t.status)).toEqual(['ACTIVE','QUEUED']);
    expect(financialAvailability(s)).toBe(144000000);
    expect(s.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({subscriptionId:id('sub',1),kind:'CANCEL_FUTURE'}),
      expect.objectContaining({subscriptionId:id('sub',2),kind:'RESCHEDULE',at:start+60*day}),
    ]));
    const later=advanceFinancialState(s,start+45*day);
    expect(later.terms[0].status).toBe('ENDED');expect(later.terms[1].end).toBe(start+60*day);
    expect(financialAvailability(advanceFinancialState(later,start+61*day))).toBe(0);
  });
  it('pauses exact unused Pro milliseconds and requests cancellation of future billing',()=>{
    const s=proThenEnterprise();
    expect(s.terms[0]).toMatchObject({status:'PAUSED',remainingTimeMs:20*day,spentMs:1234567,end:null});
    expect(s.subscriptions[0].cancelFuture).toBe(true);
    expect(s.actions.filter(a=>a.kind==='CANCEL_FUTURE')).toHaveLength(1);
    const resumed=advanceFinancialState(s,start+18*day);
    expect(resumed.terms[0]).toMatchObject({status:'ACTIVE',start:start+17*day,end:start+37*day,spentMs:1234567});
    expect(financialAvailability(resumed)).toBe(144000000-1234567);
    expect(resumed.terms).toHaveLength(2); // Resumption never creates a fresh purchase/grant.
  });
  it('Enterprise renewals keep Pro paused and discard old Enterprise allowance',()=>{
    let s=proThenEnterprise();s.terms[1].spentMs=1000;
    s=planPurchase(s,buy(3,'enterprise_weekly',start+17*day,7,2),start+17*day);
    expect(s.terms.map(t=>t.status)).toEqual(['PAUSED','ENDED','ACTIVE']);
    expect(financialAvailability(s)).toBe(108000000);
    const resumed=advanceFinancialState(s,start+25*day);
    expect(resumed.terms[0].end).toBe(start+44*day);
  });
  it('does not extend an initial paid period when evidence arrives late',()=>{
    const s=planPurchase(blank(),buy(1),start+2*day);
    expect(s.terms[0].end).toBe(start+30*day);
    expect(()=>planPurchase(blank(),buy(1),start+31*day)).toThrow();
  });
  it('rejects ambiguous overdue renewal after Pro already resumed',()=>{
    const s=advanceFinancialState(proThenEnterprise(),start+18*day);
    expect(()=>planPurchase(s,buy(3,'enterprise_weekly',start+17*day,7,2),start+18*day)).toThrow();
  });
  it('grace lasts one day and retries cannot extend it or fabricate minutes',()=>{
    let s=planPaymentFailure(proThenEnterprise(),id('sub',2),start+17*day);
    expect(s.terms[0].status).toBe('PAUSED');expect(financialAvailability(s)).toBe(0);
    s=planPaymentFailure(s,id('sub',2),start+17.5*day);
    expect(s.subscriptions[1].graceEnd).toBe(start+18*day);
    s=advanceFinancialState(s,start+19*day);
    expect(s.terms[0].end).toBe(start+38*day);
  });
  it('cancellation retains paid time but does not grant a renewal',()=>{
    const s=planCancellation(proThenEnterprise(),id('sub',2),start+11*day);
    expect(s.terms[1].status).toBe('ACTIVE');
    expect(advanceFinancialState(s,start+18*day).terms[0].end).toBe(start+37*day);
    expect(()=>planPurchase(s,buy(3,'enterprise_weekly',start+17*day,7,2),start+17*day)).toThrow();
  });
  it('full refund removes only attributable unused pack minutes and retains spend evidence',()=>{
    let s=planPurchase(planPurchase(blank(),buy(1,'pro_3_hours'),start),buy(2,'pro_3_hours'),start);
    s.terms[0].spentMs=1000;s=planFullRefund(s,id('txn',1),start);
    expect(financialAvailability(s)).toBe(10800000);expect(s.terms[0].spentMs).toBe(1000);
    expect(planFullRefund(s,id('txn',1),start)).toEqual(s);
  });
  it('refund of Enterprise immediately resumes preserved Pro remainder',()=>{
    const s=planFullRefund(proThenEnterprise(),id('txn',2),start+12*day);
    expect(s.terms[0]).toMatchObject({status:'ACTIVE',end:start+32*day,spentMs:1234567});
    expect(s.terms[1].status).toBe('REFUNDED');
    expect(s.actions.some(a=>a.subscriptionId===id('sub',2))).toBe(false);
  });
  it('does not change inputs or accept backwards time / overspent state',()=>{
    const original=proThenEnterprise(),copy=structuredClone(original);
    advanceFinancialState(original,start+40*day);expect(original).toEqual(copy);
    expect(()=>advanceFinancialState(original,start)).toThrow();
    original.terms[0].spentMs=Number.MAX_SAFE_INTEGER;
    expect(()=>financialAvailability(original)).toThrow();
  });
});
