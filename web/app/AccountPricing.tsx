import Link from 'next/link';
import {paymentOffers} from '../lib/payments/core/catalog';
import {offerDisplay} from '../lib/billing/offerDisplay';

export function AccountPricing(){
 const razorpay=process.env.SIGMAROUND_PAYMENT_PROVIDER==='razorpay';
 return <section id="pricing" className="section" aria-label="Account Sandbox pricing">
  <div className="section-heading"><p className="kicker">{razorpay?'Razorpay Test Mode · no Live payments':'Paddle Sandbox · TEST only'}</p><h2>Time for your shared account.</h2>
   <p>One lifetime 15-minute trial. The amounts below are reviewed INR catalog prices; this site is not collecting live payments. Sandbox payment testing is temporarily limited. Sign in to check your availability; purchases link to your account automatically.</p></div>
  <div className="account-purchase-grid">{paymentOffers.map(offer=>{const display=offerDisplay(offer);return <article key={offer.code}>
   <p className="kicker">{offer.interval?'Recurring plan':'No-expiry pack'}</p><h3>{offer.name}</h3><p>{display.label}</p><p>{display.terms}</p>
   <p>Managed Gemini answers, Deepgram transcription, selected context and screenshots. Concurrent sessions/devices share and consume the same server-side balance.</p>
   {razorpay&&offer.interval?<p>Razorpay recurring checkout is not operational yet. Plan and mandate acceptance are pending.</p>:null}
   <Link className="button secondary" href="/account/checkout">{razorpay?'View Test availability':'View Sandbox availability'}</Link>
  </article>;})}</div>
  <p>Eligible recurring allowance is consumed before packs. Same-tier periods queue. Enterprise pauses the exact unused Pro remainder and stops future Pro renewal; it resumes only after Enterprise ends. {razorpay?'These recurring entitlement rules are retained; Razorpay recurring fulfillment is not enabled. Payment methods require merchant-specific Test acceptance.':'Taxes and supported payment methods are determined by Paddle checkout.'} Remote Desktop and Mobile are not included in this test version.</p>
  <p>{razorpay?'No card, UPI or QR method is claimed accepted yet.':'QR/mobile payments are offered only where supported by Paddle for the currency, country and plan.'} A scan or checkout return is not proof of payment.</p>
 </section>;
}
