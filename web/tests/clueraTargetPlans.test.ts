import {describe,it,expect} from 'vitest';
import {clueraTargetPlans,CLUERA_TARGET_POLICY} from '../lib/cluera/targetPlans';
import {paymentOffers} from '../lib/payments/core/catalog';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';

describe('Cluera presentation policy separation',()=>{
 it('pins four owner-confirmed prices/seconds/periods with unique new policy IDs',()=>{
  expect(CLUERA_TARGET_POLICY).toBe('cluera-target-v2');
  expect(clueraTargetPlans.map(p=>[p.amount,p.seconds,p.interval])).toEqual([
   ['54900',10800,null],['549900',144000,'month'],['959900',360000,'month'],['1954900',720000,'month']]);
  expect(new Set(clueraTargetPlans.map(p=>p.id)).size).toBe(4);
  expect(Object.isFrozen(clueraTargetPlans)).toBe(true);expect(clueraTargetPlans.every(Object.isFrozen)).toBe(true);
 });
 it('does not rewrite or alias existing shared-ledger/Paddle policies and historical price IDs',()=>{
  for(const list of [paymentOffers,sandboxOffers]){
   const old=list.find(p=>p.code==='enterprise_weekly')!;
   expect([old.amount,old.seconds,old.interval]).toEqual(['549900',108000,'week']);
   expect(clueraTargetPlans.some(p=>p.id===String(old.code))).toBe(false);
  }
  expect(sandboxOffers.every(p=>p.priceId.startsWith('pri_'))).toBe(true);
 });
});
