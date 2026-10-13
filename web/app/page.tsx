import {AccountHome} from './AccountWebsite';
import {accountWebsite} from '../lib/accounts/site';
export const dynamic='force-dynamic';
export default function HomePage(){accountWebsite();return <AccountHome/>;}
