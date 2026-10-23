import Link from 'next/link';
import {clueraTargetPlans} from '../lib/cluera/targetPlans';
import {offerDisplay} from '../lib/billing/offerDisplay';
import {clueraPrice,clueraAllowance,type ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';
import styles from './cluera-commerce.module.css';

export function AccountPricing({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 const reviewed=catalog?.length===4;
 return <section id="pricing" className={`section ${styles.pricingSection}`} aria-label={reviewed?'Cluera reviewed catalog':'Cluera planned pricing'}>
  <div className={`section-heading ${styles.heading}`}>
   <p className={styles.eyebrow}>{reviewed?'Cluera AI · Razorpay Test catalog':'Cluera staging · payments unavailable'}</p>
   <h2>Your time. One shared balance.</h2>
   <p>{reviewed
    ?'Choose the time you need. One-time packs never expire; monthly plans include a fresh allowance each billing period.'
    :'Start with a lifetime 15-minute trial. Paid plans are not yet available.'}</p>
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
    <p className={styles.availability} id={`pricing-${plan.offerCode}`}>Open checkout to verify your account and this plan's current availability. Nothing is charged on this page.</p>
    <Link className={`button secondary ${styles.action}`} href={`/account/checkout?offer=${encodeURIComponent(plan.offerCode)}`} aria-label={`${plan.kind==='PACK'?'Buy Now':'Subscribe'}: ${plan.name}`} aria-describedby={`pricing-${plan.offerCode}`}>{plan.kind==='PACK'?'Buy Now':'Subscribe'}</Link>
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
    <p className={styles.availability} id={`pricing-${plan.offerCode}`}>Payments are not enabled for this preview. Open checkout to see the current server status; no payment starts here.</p>
    <Link className={`button secondary ${styles.action}`} href={`/account/checkout?offer=${encodeURIComponent(plan.offerCode)}`} aria-label={`Check availability: ${plan.name}`} aria-describedby={`pricing-${plan.offerCode}`}>Check availability</Link>
   </article>;})}
  </div>
  <div className={styles.safetyNote}><p><Link href="/account#signup">Create your account</Link> to start your trial. Approved Test customers can open <Link href="/pricing">plans and billing</Link>.</p>
   <p>Remote Desktop and Mobile are not included. Existing paid allowances and historical prices never change.</p></div>
 </section>;
}
