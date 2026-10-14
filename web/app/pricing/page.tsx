import {notFound} from 'next/navigation';
import {accountWebsite} from '../../lib/accounts/site';
import {AccountPricing} from '../AccountPricing';
import {readClueraBillingPresentation} from '../../lib/cluera/billingPresentation';
export const dynamic='force-dynamic';
export default function PricingPage(){
 if(!accountWebsite())notFound();
 if(process.env.CLUERA_BILLING_V2_ENABLED==='true')return currentCatalogPricing();
 return <main><AccountPricing/></main>;
}
async function currentCatalogPricing(){return <main><AccountPricing catalog={await readClueraBillingPresentation()}/></main>;}
