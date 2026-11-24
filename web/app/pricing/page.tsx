import {notFound} from 'next/navigation';
import {accountWebsite} from '../../lib/accounts/site';
import {AccountPricing} from '../AccountPricing';
import {readClueraBillingPresentation} from '../../lib/cluera/billingPresentation';
export const dynamic='force-dynamic';
/** Public prices: exactly the plans that are On in Admin, rendered on the server so they appear at once. */
export default async function PricingPage(){
 if(!accountWebsite())notFound();
 const catalog=await readClueraBillingPresentation();
 return <main className="pricing-page"><h1 className="sr-only">Cluera plans and pricing</h1><AccountPricing catalog={catalog}/></main>;
}
