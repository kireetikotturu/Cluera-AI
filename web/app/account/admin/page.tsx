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
  <header className="account-admin-heading"><p>CLUERA ADMIN</p><h1>Cluera Admin</h1><p>Look after your AI keys, payments, plans and customers. Every change is saved in the history.</p></header><AccountAdmin liveBillingAdmin={process.env.CLUERA_LIVE_ADMIN_ENABLED==='true'}/>
 </AdminProtectedContent></main>;
}
