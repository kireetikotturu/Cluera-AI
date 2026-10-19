import {AccountAdmin} from './AccountAdmin';
import {headers} from 'next/headers';
import {notFound} from 'next/navigation';
import {accountAdminAccessRequest} from '../../../lib/accounts/adminAccess';
import {AdminAccessGate,AdminProtectedContent} from '../AdminRoleNavigation';
export const dynamic='force-dynamic';
export default async function AccountAdminPage(){
 const incoming=await headers();
 const access=await accountAdminAccessRequest(new Request('https://cluera-ai-staging.vercel.app/account/admin',
  {headers:{cookie:incoming.get('cookie')??''}}),false);
 if(access.status===403)notFound();
 if(access.status!==200)return <main className="account-page"><AdminAccessGate/></main>;
 return <main className="account-page account-admin-page"><AdminProtectedContent>
  <header className="account-admin-heading"><p>ACCOUNT CONTROL CENTER</p><h1>Account administration <span>Staging</span></h1><p>Customers, policies and releases. Every change stays verified and audited.</p></header><AccountAdmin/>
 </AdminProtectedContent></main>;
}
