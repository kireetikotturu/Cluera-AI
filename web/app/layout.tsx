import type {Metadata,Viewport} from 'next';
import Link from 'next/link';
import {Plus_Jakarta_Sans,Instrument_Serif} from 'next/font/google';
import {SiteHeader} from './SiteHeader';
import {NavProgress} from './NavProgress';
import {Wordmark} from './BrandMark';
import {AdminRoleProvider,AdminRoleLink} from './account/AdminRoleNavigation';
import './globals.css';
import './cluera.css';
import './premium.css';

const sans=Plus_Jakarta_Sans({subsets:['latin'],variable:'--font-sans',display:'swap'});
const serif=Instrument_Serif({subsets:['latin'],weight:'400',style:['normal','italic'],variable:'--font-serif',display:'swap'});

export const metadata:Metadata={metadataBase:new URL('https://cluera-ai-staging.vercel.app'),title:{default:'Cluera AI · Your interview workspace',template:'%s · Cluera AI'},description:'Live transcription and instant AI answers for your interviews, with your résumé and job description in context.',openGraph:{title:'Cluera AI',description:'Live transcription and instant AI answers, in one focused Windows app.',type:'website'}};
export const viewport:Viewport={themeColor:'#07080d',colorScheme:'dark'};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="en" className={`${sans.variable} ${serif.variable}`} suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:"try{if(localStorage.getItem('cluera-signed-in-hint-v1')==='1')document.documentElement.setAttribute('data-signed-in','1')}catch(e){}"}}/></head><body className="account-site cluera-site"><NavProgress/><div className="ambient" aria-hidden="true"><i/><i/><i/></div><AdminRoleProvider><SiteHeader accountEdition/>{children}<footer><div><span className="wordmark"><Wordmark/></span><p>Live transcription and instant AI answers for your next interview. Use only where interview assistance is permitted.</p></div><div><Link href="/pricing">Pricing</Link><Link href="/download">Download</Link><Link href="/setup">Setup guide</Link><Link href="/account">My account</Link><Link href="/support">Support</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/refunds">Refunds</Link><AdminRoleLink/></div><small>© {new Date().getUTCFullYear()} Cluera AI. All rights reserved.</small></footer></AdminRoleProvider></body></html>;}
