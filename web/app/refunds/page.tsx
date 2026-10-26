import type {Metadata} from 'next';
export const metadata:Metadata={title:'Refund and cancellation policy',description:'How refunds and cancellations work for Cluera AI.'};
export default function RefundsPage(){return <main className="content-page"><div className="content-hero"><p className="kicker">Legal</p><h1>Refund and cancellation policy</h1><p>Clear rules for one-time packs and monthly plans.</p></div>
 <div className="support-grid">
  <article><h2>One-time packs</h2><p>A pack is a one-time payment with no automatic renewal. To ask for a refund, email <a href="mailto:clueraaisupport@gmail.com">clueraaisupport@gmail.com</a> from your account email with the payment ID shown in your billing history. Requests are reviewed case by case, and a refund can only be made for time that has not been used.</p></article>
  <article><h2>Monthly plans</h2><p>You can cancel a monthly plan from your billing page at any time. Cancelling stops future renewals; you keep the time you already paid for until the end of the paid period. Unused monthly time does not roll over.</p></article>
  <article><h2>How refunds are paid</h2><p>Approved refunds go back to the original payment method through Razorpay. Banks usually take 5 to 7 working days to show the money.</p></article>
  <article><h2>Failed or double payments</h2><p>If money left your account but no time appeared, do not pay again. Wait a few minutes and use Refresh billing status; then email support with the payment ID. A payment that Razorpay did not capture is returned by your bank automatically.</p></article>
 </div></main>;}
