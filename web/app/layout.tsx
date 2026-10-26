import type {Metadata} from 'next';
import Link from 'next/link';
import {SiteHeader} from './SiteHeader';
import {AdminRoleProvider,AdminRoleLink} from './account/AdminRoleNavigation';
import './globals.css';
import './cluera.css';
export const metadata:Metadata={metadataBase:new URL('https://cluera-ai-staging.vercel.app'),title:{default:'Cluera AI · Your interview workspace',template:'%s · Cluera AI'},description:'Account-managed AI answers, live transcription and an isolated Windows workspace.',openGraph:{title:'Cluera AI',description:'One account. Your context. A focused Windows workspace.',type:'website'}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="en"><body className="account-site cluera-site"><AdminRoleProvider><SiteHeader accountEdition/>{children}<footer><div><span className="wordmark"><span aria-hidden="true">C</span><strong>Cluera <em>AI</em></strong></span><p>Use only where interview assistance is permitted.</p></div><div><Link href="/download">Download</Link><Link href="/setup">Setup guide</Link><Link href="/account">My account</Link><Link href="/support">Support</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/refunds">Refunds</Link><AdminRoleLink/></div><small>© {new Date().getUTCFullYear()} Cluera AI.</small></footer></AdminRoleProvider></body></html>;}
