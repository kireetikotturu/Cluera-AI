import type {Metadata} from 'next';
import Link from 'next/link';
export const metadata:Metadata={title:'Privacy policy',description:'What Cluera AI collects and how it is used.'};
export default function PrivacyPage(){return <main className="content-page"><div className="content-hero"><p className="kicker">Legal</p><h1>Privacy policy</h1><p>What we collect, why, and who else sees it.</p></div>
 <div className="support-grid">
  <article><h2>What we collect</h2><p>Your email address and sign-in information, your time balance and usage history, the context text you choose to save, and payment references (order and payment IDs and amounts) so that we can credit your time and answer billing questions.</p></article>
  <article><h2>What is sent to AI providers</h2><p>When you start a session, the audio, screenshots and text you choose to use are sent to our AI providers (Google Gemini and Deepgram) to produce answers and transcripts. Provider keys are held on our servers and are never sent to your device.</p></article>
  <article><h2>Payments</h2><p>Payments are processed by Razorpay. Your card, UPI or bank details go to Razorpay and are not stored by Cluera.</p></article>
  <article><h2>Where data is kept</h2><p>Account data is stored with our database provider (Supabase), website hosting (Vercel) and relay hosting (Render). We do not sell your data.</p></article>
  <article><h2>Your choices</h2><p>You can ask us to export or delete your account data by emailing <a href="mailto:clueraaisupport@gmail.com">clueraaisupport@gmail.com</a> from your account email. Some payment records must be kept for accounting and legal reasons.</p></article>
  <article><h2>More</h2><p>Read the <Link href="/terms">terms of service</Link> and <Link href="/refunds">refund policy</Link>.</p></article>
 </div></main>;}
