import {notFound} from 'next/navigation';
import {accountWebsite} from '../../lib/accounts/site';
import {AccountPricing} from '../AccountPricing';
export const dynamic='force-dynamic';
export default function PricingPage(){
 if(!accountWebsite())notFound();
 return <main><AccountPricing/></main>;
}
