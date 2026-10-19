import {checkoutSelectionHref,type CheckoutSelection} from '../cluera/checkoutJourney';
/** Navigation only: destination still authorizes the customer and payment. */
export function selectedPlanReturn(selection:CheckoutSelection|null,userId:string,recovery:boolean):string|null{
 if(!selection||recovery||(selection.desktopAccount!==null&&selection.desktopAccount!==userId))return null;
 return checkoutSelectionHref(selection);
}
export function replaceAccountLocation(href:string){window.location.replace(href);}
