import {it,expect} from 'vitest';
import {selectionFromSearch,resolveCheckoutSelection,checkoutSelectionHref,checkoutSelectionName,clearCheckoutSelection} from '../lib/cluera/checkoutJourney';
const key='cluera.checkout-selection.v1',now=1_800_000_000_000;
const account='00000000-0000-4000-8000-000000000801';
function storage(){const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};}
it.each(['cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2'])('preserves only approved offer navigation (%s)',offer=>{
 const selected=selectionFromSearch(`?offer=${offer}&desktopAccount=${account}`)!;
 expect(checkoutSelectionHref(selected)).toBe(`/account/checkout?offer=${offer}&desktopAccount=${account}`);
 expect(checkoutSelectionHref(selected,true)).toBe(`/account?offer=${offer}&desktopAccount=${account}#login`);
 expect(checkoutSelectionName(selected)).toMatch(/^Cluera/);
});
it.each(['?offer=pro_3_hours','?offer=https://foreign.invalid','?offer=cluera_pack_3h_v2&offer=cluera_monthly_40h_v2',
 '?offer=cluera_pack_3h_v2&desktopAccount=bad','?desktopAccount='+account+'&desktopAccount='+account])('rejects malformed/duplicate/legacy handoffs without reflecting them (%s)',search=>{
 expect(selectionFromSearch(search)).toBeNull();
});
it('drops arbitrary return URLs, prices, provider IDs and flags; they cannot affect the fixed destination',()=>{
 const selected=selectionFromSearch('?offer=cluera_pack_3h_v2&next=//foreign.invalid&amount=1&order_id=order_foreign&enabled=true')!;
 expect(checkoutSelectionHref(selected)).toBe('/account/checkout?offer=cluera_pack_3h_v2');
 expect(selectionFromSearch('?next=https://foreign.invalid')).toBeNull();
});
it('retains only bounded non-secret navigation state across a same-browser OAuth/email return',()=>{
 const s=storage(),selected=resolveCheckoutSelection('?offer=cluera_monthly_100h_v2',s,now);
 expect(resolveCheckoutSelection('',s,now+60_000)).toEqual(selected);
 expect(JSON.parse(s.getItem(key)!)).toEqual({version:1,savedAt:now,selection:{offerCode:'cluera_monthly_100h_v2',desktopAccount:null}});
 clearCheckoutSelection(s);expect(resolveCheckoutSelection('',s,now+60_000)).toBeNull();
});
it.each([now-30*60_000-1,now+5001])('rejects expired/future stored selections (%s)',savedAt=>{
 const s=storage();s.setItem(key,JSON.stringify({version:1,savedAt,selection:{offerCode:'cluera_pack_3h_v2',desktopAccount:null}}));
 expect(resolveCheckoutSelection('',s,now)).toBeNull();expect(s.getItem(key)).toBeNull();
});
it('invalid explicit handoffs cannot recover a stale stored plan; unexpected private fields are refused',()=>{
 const s=storage();resolveCheckoutSelection('?offer=cluera_pack_3h_v2',s,now);
 expect(resolveCheckoutSelection('?offer=bad',s,now)).toBeNull();expect(s.getItem(key)).toBeNull();
 s.setItem(key,JSON.stringify({version:1,savedAt:now,selection:{offerCode:'cluera_pack_3h_v2',desktopAccount:null},token:'synthetic-not-a-token'}));
 expect(resolveCheckoutSelection('',s,now)).toBeNull();
});
it('disabled storage never blocks a valid URL selection or Auth',()=>{
 const s={getItem:()=>{throw Error();},setItem:()=>{throw Error();},removeItem:()=>{throw Error();}};
 expect(resolveCheckoutSelection('?offer=cluera_pack_3h_v2',s,now)?.offerCode).toBe('cluera_pack_3h_v2');
 expect(resolveCheckoutSelection('',s,now)).toBeNull();
});
