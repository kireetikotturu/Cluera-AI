import type {Metadata} from 'next';
import Link from 'next/link';
export const metadata:Metadata={title:'Terms of service',description:'The terms for using Cluera AI.'};
export default function TermsPage(){return <main className="content-page"><div className="content-hero"><p className="kicker">Legal</p><h1>Terms of service</h1><p>By creating an account or buying time you agree to these terms.</p></div>
 <div className="support-grid">
  <article><h2>The service</h2><p>Cluera AI is a Windows workspace with a website account. It provides AI answers and live transcription using time that you hold in your account balance. A free 15-minute trial is available once per account.</p></article>
  <article><h2>Your account</h2><p>Keep your sign-in details and authenticator private. You are responsible for activity on your account. We may suspend an account that is used to abuse the service or to break the law.</p></article>
  <article><h2>Time, packs and plans</h2><p>One-time packs add time that does not expire. Monthly plans add a fresh allowance each paid period, and unused monthly time does not roll over. Prices are shown in Indian rupees before you pay. Payments are handled by Razorpay; Cluera does not see or store your card or UPI details.</p></article>
  <article><h2>Acceptable use</h2><p>Use Cluera only where interview or meeting assistance is permitted. You are responsible for following the rules of any employer, school, exam or interviewer. Do not use the service for anything unlawful.</p></article>
  <article><h2>Availability</h2><p>We work to keep the service running but do not promise uninterrupted access. AI output can be wrong; check important answers yourself.</p></article>
  <article><h2>Refunds and contact</h2><p>See the <Link href="/refunds">refund and cancellation policy</Link>. Questions: <a href="mailto:clueraaisupport@gmail.com">clueraaisupport@gmail.com</a>.</p></article>
 </div></main>;}
