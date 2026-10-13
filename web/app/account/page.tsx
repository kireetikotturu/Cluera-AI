import type { Metadata } from 'next';
import { AccountPanel } from './AccountPanel';
export const metadata: Metadata = { title: 'Your Cluera account', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default function AccountPage() {
  return <main className="account-page"><h1>Your Cluera account</h1>
    {process.env.SIGMAROUND_ACCOUNTS_ENABLED === 'true'
      ? <AccountPanel/>
      : <p>Customer accounts are not available on this deployment yet.</p>}
  </main>;
}
