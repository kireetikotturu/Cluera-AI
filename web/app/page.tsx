import {AccountHome} from './AccountWebsite';
import {accountWebsite} from '../lib/accounts/site';
import {readClueraBillingPresentation} from '../lib/cluera/billingPresentation';
export const dynamic='force-dynamic';
export default function HomePage(){
 accountWebsite();
 if(process.env.CLUERA_BILLING_V2_ENABLED==='true')return currentCatalogHome();
 return <AccountHome/>;
}
async function currentCatalogHome(){return <AccountHome catalog={await readClueraBillingPresentation()}/>;}
