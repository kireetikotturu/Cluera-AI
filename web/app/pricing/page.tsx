import {notFound} from 'next/navigation';
import {accountWebsite} from '../../lib/accounts/site';
import {AccountPricing} from '../AccountPricing';
import {readClueraBillingPresentation} from '../../lib/cluera/billingPresentation';
import ClueraCheckoutClient from '../account/checkout/ClueraCheckoutClient';
import {clueraCheckoutEnabled} from '../../lib/payments/cluera/config';
import {clueraBillingHistoryEnabled} from '../../lib/payments/cluera/history';
import {clueraCancellationEnabled} from '../../lib/payments/cluera/cancellation';
export const dynamic='force-dynamic';
export default function PricingPage(){
 if(!accountWebsite())notFound();
 if(process.env.CLUERA_BILLING_V2_ENABLED==='true')return currentCatalogPricing();
 return <main><AccountPricing/></main>;
}
async function currentCatalogPricing(){return <main className="account-page"><h1>Cluera plans and pricing</h1>
 <ClueraCheckoutClient offers={await readClueraBillingPresentation()??[]} enabled={clueraCheckoutEnabled()}
  historyEnabled={clueraBillingHistoryEnabled()} cancellationEnabled={clueraCancellationEnabled()} firstSubscriptionOnly/>
 </main>;}
