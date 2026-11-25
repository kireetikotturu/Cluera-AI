import type { Metadata, Viewport } from 'next';
import { LiveApp } from './LiveApp';

export const metadata: Metadata = { title: 'Live session', robots: { index: false, follow: false } };
// The live screen sits under the phone's keyboard and notch: let the page use the whole screen and shrink with the keyboard.
export const viewport: Viewport = { themeColor: '#07080d', colorScheme: 'dark', width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content' };
export const dynamic = 'force-dynamic';

export default function LivePage() {
  return process.env.SIGMAROUND_ACCOUNTS_ENABLED === 'true'
    ? <main><h1 className="account-page-title">Live session</h1><LiveApp /></main>
    : <main className="account-page"><p>Customer accounts are not available on this deployment yet.</p></main>;
}
