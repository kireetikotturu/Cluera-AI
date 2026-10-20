import {notFound} from 'next/navigation';
import {accountWebsite} from '../../lib/accounts/site';
import {AccountPricing} from '../AccountPricing';
import {readClueraBillingPresentation} from '../../lib/cluera/billingPresentation';
import ClueraCheckoutClient from '../account/checkout/ClueraCheckoutClient';
import {billingUiCapabilities} from '../../lib/payments/cluera/billingUi';
export const dynamic='force-dynamic';
export default function PricingPage(){
 if(!accountWebsite())notFound();
 if(process.env.CLUERA_BILLING_V2_ENABLED==='true')return currentCatalogPricing();
 return <main><AccountPricing/></main>;
}
async function currentCatalogPricing(){const billing=billingUiCapabilities();return <main className="account-page"><h1>Cluera plans and pricing</h1>
 <ClueraCheckoutClient key={billing.mode} offers={await readClueraBillingPresentation()??[]} {...billing} firstSubscriptionOnly/>
 </main>;}
