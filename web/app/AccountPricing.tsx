import Link from 'next/link';
import {clueraTargetPlans} from '../lib/cluera/targetPlans';
import {offerDisplay} from '../lib/billing/offerDisplay';
import {clueraPrice,clueraAllowance,type ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';
import styles from './cluera-commerce.module.css';

export function AccountPricing({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 // A known catalog is exactly the list of plans that are On (it may be empty); null means "not readable".
 const reviewed=catalog!==null;
 return <section id="pricing" className={`section ${styles.pricingSection}`} aria-label={reviewed?'Cluera reviewed catalog':'Cluera planned pricing'}>
  <div className={`section-heading ${styles.heading}`}>
   <p className={styles.eyebrow}>{reviewed?'Pricing':'Pricing preview'}</p>
   <h2>Simple pricing. <span className="accent-serif">Pay for time.</span></h2>
   <p>{reviewed
    ?'Buy the time you need. Packs never expire, stack together and work across all your devices.'
    :'Start with 15 free minutes. Paid plans are coming soon.'}</p>
  </div>
  <div className={styles.trialNote}><span aria-hidden="true" className={styles.noteIcon}>15</span><p><strong>Start free with 15 minutes.</strong> Every new account gets a one-time trial, no card needed.</p></div>
  <div className={`account-purchase-grid ${styles.grid}`}>
   {reviewed&&!catalog!.length?<p className={styles.availability} role="status">No plans are on sale right now. Please check back soon.</p>:reviewed?catalog!.map(plan=><article key={plan.revisionId} className={`${styles.card} reveal`} aria-label={plan.name}>
    <div className={styles.cardTop}><p className={styles.eyebrow}>{plan.kind==='PACK'?'Non-expiring pack':'Monthly allowance'}</p></div>
    <h3>{plan.name}</h3>
    <p className={styles.price}>{clueraPrice(plan.amountPaise)}<span>{plan.kind==='RECURRING'?' / month':' one time'}</span></p>
    <p className={styles.allowance}>{clueraAllowance(plan.allowanceSeconds)}{plan.kind==='RECURRING'?' per month':''}</p>
    <ul className={styles.features}>
     <li><span aria-hidden="true">✓</span>{plan.kind==='PACK'?'Never expires, packs stack':'Monthly hours do not roll over'}</li>
     <li><span aria-hidden="true">✓</span>Use on all your devices</li>
     <li><span aria-hidden="true">✓</span>{plan.kind==='PACK'?'One-time purchase':`Up to ${plan.totalCount} monthly charges`}</li>
    </ul>
    <p className={styles.availability} id={`pricing-${plan.offerCode}`}>Secure payment with UPI, cards or netbanking.</p>
    <Link className={`button ${styles.action}`} href={`/account/checkout?offer=${encodeURIComponent(plan.offerCode)}`} aria-label={`${plan.kind==='PACK'?'Buy Now':'Subscribe'}: ${plan.name}`} aria-describedby={`pricing-${plan.offerCode}`}>{plan.kind==='PACK'?'Buy Now':'Subscribe'}</Link>
   </article>):clueraTargetPlans.map(plan=>{const display=offerDisplay(plan);return <article key={plan.id} className={styles.card} aria-label={plan.name}>
    <div className={styles.cardTop}><p className={styles.eyebrow}>{plan.interval?'Monthly plan':'One-time pack'}</p><span className={styles.badge}>Coming soon</span></div>
    <h3>{plan.name}</h3>
    <p className={styles.price}>{clueraPrice(Number(plan.amount))}<span>{plan.interval?' / month':' one time'}</span></p>
    <p className={styles.allowance}>{display.hours} hours{plan.interval?' per month':''}</p>
    <ul className={styles.features}>
     <li><span aria-hidden="true">✓</span>{plan.interval?'Monthly hours do not roll over':'Never expires, packs stack'}</li>
     <li><span aria-hidden="true">✓</span>Use on all your devices</li>
     <li><span aria-hidden="true">✓</span>{plan.interval?'Monthly allowance':'Flexible one-time top-up'}</li>
    </ul>
    <p className={styles.terms}>{display.terms}</p>
    <p className={styles.availability} id={`pricing-${plan.offerCode}`}>This plan is not on sale yet.</p>
    <Link className={`button secondary ${styles.action}`} href={`/account/checkout?offer=${encodeURIComponent(plan.offerCode)}`} aria-label={`Check availability: ${plan.name}`} aria-describedby={`pricing-${plan.offerCode}`}>Check availability</Link>
   </article>;})}
  </div>
  <div className={styles.safetyNote}><p><Link href="/account#signup">Create your free account</Link> to start your trial, then come back here whenever you need more time.</p></div>
 </section>;
}
