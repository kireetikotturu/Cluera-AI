import Link from 'next/link';
import {clueraTargetPlans} from '../lib/cluera/targetPlans';
import {offerDisplay} from '../lib/billing/offerDisplay';
import {clueraPrice,clueraAllowance,type ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';

export function AccountPricing({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 if(catalog?.length===4)return <section id="pricing" className="section" aria-label="Cluera reviewed catalog">
  <div className="section-heading"><p className="kicker">Cluera AI - Razorpay Test catalog</p><h2>Time for your shared account.</h2>
   <p>Current future-purchase revisions managed through verified Admin MFA. Existing orders, paid allowances and historical prices never change. Checkout availability is separately controlled.</p></div>
  <div className="account-purchase-grid">{catalog.map(plan=><article key={plan.revisionId}>
   <p className="kicker">{plan.kind==='PACK'?'Non-expiring pack':'Monthly allowance'}</p><h3>{plan.name}</h3>
   <p>{clueraPrice(plan.amountPaise)}{plan.kind==='RECURRING'?' / month':''}</p><p>{clueraAllowance(plan.allowanceSeconds)} - {plan.kind==='PACK'?'packs stack; no expiry':`no rollover; up to ${plan.totalCount} monthly charges`}</p>
   <p>Revision {plan.version}. {plan.enabled&&plan.testPlanValidated?'Catalog ready for separately approved Test acceptance.':'Offer unavailable pending catalog/provider acceptance.'}</p>
   <p>Payment methods and actual provider delivery remain subject to acceptance; this page does not start checkout.</p>
   <Link className="button secondary" href="/account/checkout">View availability</Link>
  </article>)}</div><p>One lifetime 15-minute trial. Eligible recurring allowance is consumed before packs. Stripe, Live, Remote Desktop and Mobile remain unavailable.</p>
 </section>;
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
