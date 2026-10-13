import Link from 'next/link';
import {clueraTargetPlans} from '../lib/cluera/targetPlans';
import {offerDisplay} from '../lib/billing/offerDisplay';

export function AccountPricing(){
 return <section id="pricing" className="section" aria-label="Cluera planned pricing">
  <div className="section-heading"><p className="kicker">Cluera staging — payments unavailable</p><h2>Time for your shared account.</h2>
   <p>One lifetime 15-minute trial. These are the owner-confirmed planned INR prices, not active payment offers. Billing integration and payment acceptance are pending.</p></div>
  <div className="account-purchase-grid">{clueraTargetPlans.map(plan=>{const display=offerDisplay(plan);return <article key={plan.id}>
   <p className="kicker">{plan.interval?'Planned monthly allowance':'Planned no-expiry pack'}</p><h3>{plan.name}</h3><p>{display.label}</p><p>{display.terms}</p>
   <p>Managed answers, transcription, selected context and screenshots are awaiting secure provider activation and end-to-end acceptance. Concurrent devices share one server-side balance.</p>
   <p>Checkout unavailable. No card, UPI or QR method is claimed accepted yet.</p>
   <Link className="button secondary" href="/account/checkout">View availability</Link>
  </article>;})}</div>
  <p>Eligible recurring allowance is consumed before packs. Recurring integration and Stripe are unavailable. Existing balances and historical payment policies are unchanged. Remote Desktop and Mobile are not included in this staging version.</p>
 </section>;
}
