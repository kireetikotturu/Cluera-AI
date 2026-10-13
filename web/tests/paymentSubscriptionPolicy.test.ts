import { it,expect } from 'vitest';
import { recurringMethodPolicy,verifyRecurringPlan,subscriptionState } from '../lib/payments/subscriptions/policy';
import { paymentOffers } from '../lib/payments/core/catalog';
import { sandboxOffers } from '../lib/billing/sandboxCatalog';
it('extracts provider-independent rules without changing any approved Paddle amount/allowance/cycle',()=>{
 expect(sandboxOffers.map(({priceId:_,...policy})=>policy)).toEqual(paymentOffers);
 expect(paymentOffers.map(p=>[p.code,p.amount,p.seconds,p.interval])).toEqual([
 ['pro_3_hours','54900',10800,null],['pro_40_hours','549900',144000,'month'],['enterprise_weekly','549900',108000,'week'],['enterprise_monthly','1954900',720000,'month']]);
});
it('UPI and high-value RuPay recurring are not promised for19549 monthly; other cards still require AFA',()=>{
 expect(recurringMethodPolicy('enterprise_monthly','upi').supportedByPolicy).toBe(false);
 expect(recurringMethodPolicy('enterprise_monthly','card','RuPay').supportedByPolicy).toBe(false);
 expect(recurringMethodPolicy('enterprise_monthly','card','Visa')).toMatchObject({requiresPerDebitAuthentication:true,operational:false});
 expect(recurringMethodPolicy('pro_40_hours','upi')).toMatchObject({supportedByPolicy:true,requiresMandate:true,operational:false,customerPausedUpiCanBeResumedByMerchant:false});
});
it.each(paymentOffers.filter(p=>p.interval))('verifies exact provider plan for $code without creating/subscribing/granting',offer=>{
 const plan={id:'plan_synthetic0001',entity:'plan',period:offer.interval==='week'?'weekly':'monthly',interval:1,item:{amount:Number(offer.amount),currency:'INR',active:true}};
 expect(verifyRecurringPlan(offer.code,plan.id,plan).allowanceMilliseconds).toBe(offer.seconds*1000);
 expect(()=>verifyRecurringPlan(offer.code,plan.id,{...plan,interval:2})).toThrow();
 expect(()=>verifyRecurringPlan(offer.code,plan.id,{...plan,item:{...plan.item,amount:100}})).toThrow();
});
it('created/authenticated/setup/unknown states cannot be treated as paid active terms',()=>{
 for(const state of ['created','authenticated','invented'])expect(subscriptionState(state)).toBe('PENDING');
 expect(subscriptionState('pending')).toBe('PAST_DUE');expect(subscriptionState('halted')).toBe('PAST_DUE');
 expect(subscriptionState('paused')).toBe('PAUSED');expect(subscriptionState('cancelled')).toBe('CANCELED');
});
