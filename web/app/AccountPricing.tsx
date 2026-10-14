import Link from 'next/link';
import {clueraTargetPlans} from '../lib/cluera/targetPlans';
import {offerDisplay} from '../lib/billing/offerDisplay';
import {clueraPrice,clueraAllowance,type ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';
import {checkoutSelectionHref} from '../lib/cluera/checkoutJourney';
import styles from './cluera-commerce.module.css';

export function AccountPricing({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 const reviewed=catalog?.length===4;
 return <section id="pricing" className={`section ${styles.pricingSection}`} aria-label={reviewed?'Cluera reviewed catalog':'Cluera planned pricing'}>
  <div className={`section-heading ${styles.heading}`}>
   <p className={styles.eyebrow}>{reviewed?'Cluera AI · Razorpay Test catalog':'Cluera staging · payments unavailable'}</p>
   <h2>Your time. One shared balance.</h2>
   <p>{reviewed
    ?'Current future-purchase revisions managed through verified Admin MFA. Existing orders, paid allowances and historical prices never change. Checkout availability is separately controlled.'
    :'One lifetime 15-minute trial. These are the owner-confirmed planned INR prices, not active payment offers. Billing integration and payment acceptance are pending.'}</p>
  </div>
  <div className={styles.trialNote}><span aria-hidden="true" className={styles.noteIcon}>15</span><p><strong>Start with your lifetime 15-minute trial.</strong> Concurrent devices share one server-side balance. Eligible recurring allowance is consumed before packs.</p></div>
  <div className={`account-purchase-grid ${styles.grid}`}>
   {reviewed?catalog!.map(plan=><article key={plan.revisionId} className={styles.card} aria-label={plan.name}>
    <div className={styles.cardTop}><p className={styles.eyebrow}>{plan.kind==='PACK'?'Non-expiring pack':'Monthly allowance'}</p><span className={styles.badge}>Test catalog</span></div>
    <h3>{plan.name}</h3>
    <p className={styles.price}>{clueraPrice(plan.amountPaise)}<span>{plan.kind==='RECURRING'?' / month':' one time'}</span></p>
    <p className={styles.allowance}>{clueraAllowance(plan.allowanceSeconds)}{plan.kind==='RECURRING'?' per month':''}</p>
    <ul className={styles.features}>
     <li><span aria-hidden="true">✓</span>{plan.kind==='PACK'?'Packs stack; no expiry':'Monthly hours do not roll over'}</li>
     <li><span aria-hidden="true">✓</span>One account balance across devices</li>
     <li><span aria-hidden="true">✓</span>{plan.kind==='PACK'?'One-time purchase':`Up to ${plan.totalCount} monthly charges`}</li>
    </ul>
    <p className={styles.availability}>Revision {plan.version}. {plan.enabled&&plan.testPlanValidated?'Catalog ready for separately approved Test acceptance.':'Offer unavailable pending catalog/provider acceptance.'}</p>
    <Link className={`button secondary ${styles.action}`} href={checkoutSelectionHref({offerCode:plan.offerCode,desktopAccount:null})} aria-label={`View availability for ${plan.name}`}>View availability<span aria-hidden="true">→</span></Link>
   </article>):clueraTargetPlans.map(plan=>{const display=offerDisplay(plan);return <article key={plan.id} className={styles.card} aria-label={plan.name}>
    <div className={styles.cardTop}><p className={styles.eyebrow}>{plan.interval?'Planned monthly allowance':'Planned no-expiry pack'}</p><span className={styles.badge}>Preview</span></div>
    <h3>{plan.name}</h3>
    <p className={styles.price}>{clueraPrice(Number(plan.amount))}<span>{plan.interval?' / month':' one time'}</span></p>
    <p className={styles.allowance}>{display.hours} hours{plan.interval?' per month':''}</p>
    <ul className={styles.features}>
     <li><span aria-hidden="true">✓</span>{plan.interval?'Monthly hours do not roll over':'No expiry; verified packs stack'}</li>
     <li><span aria-hidden="true">✓</span>One account balance across devices</li>
     <li><span aria-hidden="true">✓</span>{plan.interval?'Monthly allowance':'Flexible one-time top-up'}</li>
    </ul>
    <p className={styles.terms}>{display.terms}</p>
    <p className={styles.availability}>Checkout unavailable. No card, UPI or QR method is claimed accepted yet.</p>
    <Link className={`button secondary ${styles.action}`} href={checkoutSelectionHref({offerCode:plan.offerCode,desktopAccount:null})} aria-label={`View availability for ${plan.name}`}>View availability<span aria-hidden="true">→</span></Link>
   </article>;})}
  </div>
  <div className={styles.safetyNote}><p><strong>Availability comes before payment.</strong> {reviewed?'Payment methods and actual provider delivery remain subject to acceptance; this page does not start checkout.':'Managed answers, transcription, selected context and screenshots are awaiting secure provider activation and end-to-end acceptance.'}</p>
   <p>{reviewed?'Stripe, Live, Remote Desktop and Mobile remain unavailable.':'Recurring integration and Stripe are unavailable. Existing balances and historical payment policies are unchanged. Remote Desktop and Mobile are not included in this staging version.'}</p></div>
 </section>;
}
