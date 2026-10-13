import type {SandboxOffer} from './sandboxCatalog';

/** Reviewed integer paise/seconds only; display is not payment authority. */
export function offerDisplay(offer:Pick<SandboxOffer,'amount'|'seconds'|'interval'>){
 const price=`₹${new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(Number(offer.amount)/100)}`;
 const hours=offer.seconds/3600;
 const period=offer.interval==='month'?'month':offer.interval==='week'?'week':null;
 return {price,hours,label:`${price} · ${hours} hours${period?` per ${period}`:' · no expiry'}`,
  terms:period?`Renews every ${period}. Unused recurring hours do not roll over. Cancellation keeps access until the paid period ends.`:
    'One-time 3-hour pack. No expiry; multiple verified purchases stack.',
 };
}
