import {z} from 'zod';
import {clueraOfferCode} from '../payments/cluera/publicCatalog';
import {clueraTargetPlans} from './targetPlans';

/** Navigation hints only: never a price, revision, Auth identity or payment permission. */
const selectionSchema=z.object({offerCode:clueraOfferCode.nullable(),desktopAccount:z.uuid().nullable()})
 .strict().refine(value=>value.offerCode!==null||value.desktopAccount!==null);
export type CheckoutSelection=z.infer<typeof selectionSchema>;
const storageKey='cluera.checkout-selection.v1',maxAge=30*60*1000;
type SelectionStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

export function selectionFromSearch(search:string):CheckoutSelection|null{
 if(search.length>4096)return null;
 const query=new URLSearchParams(search);
 if(query.getAll('offer').length>1||query.getAll('desktopAccount').length>1)return null;
 const parsed=selectionSchema.safeParse({offerCode:query.get('offer'),desktopAccount:query.get('desktopAccount')});
 return parsed.success?parsed.data:null;
}
export function clearCheckoutSelection(storage:SelectionStorage){try{storage.removeItem(storageKey);}catch{/* Storage can be unavailable; never block Auth. */}}
export function resolveCheckoutSelection(search:string,storage:SelectionStorage,now=Date.now()):CheckoutSelection|null{
 const query=new URLSearchParams(search),selected=selectionFromSearch(search);
 if(query.has('offer')||query.has('desktopAccount')){
  if(!selected){clearCheckoutSelection(storage);return null;}
  try{storage.setItem(storageKey,JSON.stringify({version:1,savedAt:now,selection:selected}));}catch{/* URL handoff still works. */}
  return selected;
 }
 try{
  const raw=storage.getItem(storageKey);if(raw===null)return null;
  const stored=z.object({version:z.literal(1),savedAt:z.number().int().nonnegative(),selection:selectionSchema}).strict().parse(JSON.parse(raw));
  if(stored.savedAt>now+5000||now-stored.savedAt>maxAge){clearCheckoutSelection(storage);return null;}
  return stored.selection;
 }catch{clearCheckoutSelection(storage);return null;}
}
export function checkoutSelectionHref(selection:CheckoutSelection,account=false):string{
 const safe=selectionSchema.parse(selection),query=new URLSearchParams();
 if(safe.offerCode)query.set('offer',safe.offerCode);
 if(safe.desktopAccount)query.set('desktopAccount',safe.desktopAccount);
 return `${account?'/account':'/account/checkout'}?${query}${account?'#login':''}`;
}
export function checkoutSelectionName(selection:CheckoutSelection):string{
 return clueraTargetPlans.find(plan=>plan.offerCode===selection.offerCode)?.name??'Cluera billing';
}
