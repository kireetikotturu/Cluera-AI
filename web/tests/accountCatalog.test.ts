import {expect,it} from 'vitest';
import {approvedCatalog} from '../lib/accounts/catalog';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
const policies=()=>sandboxOffers.map((o,i)=>({code:o.code,name:o.name,enabled:true,priority:i}));
it('joins display/availability policy to immutable price and allowance mapping',()=>{
 const input=policies();input[0].enabled=false;input[1].priority=100;
 const result=approvedCatalog(input);expect(result).toHaveLength(4);expect(result[0].enabled).toBe(false);expect(result.at(-1)?.code).toBe('pro_40_hours');
 expect(result.find(o=>o.code==='pro_3_hours')).toMatchObject({priceId:'pri_01m42b4wbjta3q8r5rm9var416',amount:'54900',seconds:10800});
});
it('fails closed on duplicate/missing/foreign catalog IDs and attempts to supply pricing',()=>{
 expect(()=>approvedCatalog(policies().slice(1))).toThrow();expect(()=>approvedCatalog([policies()[0],...policies().slice(0,3)])).toThrow();
 expect(()=>approvedCatalog(policies().map((p,i)=>i? p:{...p,code:'pro_100'}))).toThrow();
 expect(()=>approvedCatalog(policies().map(p=>({...p,amount:'1'})))).toThrow();
});
