import type {Metadata} from 'next';
import {AccountSetup} from '../AccountWebsite';
export const metadata:Metadata={title:'Cluera setup guide',description:'Verify your existing account and prepare your Cluera Windows workspace.'};
export default function SetupPage(){return <AccountSetup/>;}
