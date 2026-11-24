import Link from 'next/link';
import {clueraPrice,clueraAllowance,type ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';
import {BuyLink} from './BuyLink';
import styles from './cluera-commerce.module.css';

export function AccountPricing({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 // A known catalog is exactly the list of plans that are On (it may be empty); null means "not readable".
 const reviewed=catalog!==null;
 return <section id="pricing" className={`section ${styles.pricingSection}`} aria-label={reviewed?'Cluera reviewed catalog':'Cluera pricing'}>
  <div className={`section-heading ${styles.heading}`}>
   <p className={styles.eyebrow}>Pricing</p>
   <h2>Simple pricing. <span className="accent-serif">Pay for time.</span></h2>
   <p>{reviewed
    ?'Buy the time you need. Packs never expire, stack together and work across all your devices.'
    :'Start with 15 free minutes. Plans are loading, please refresh in a moment.'}</p>
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
    <BuyLink className={`button ${styles.action}`} offerCode={plan.offerCode} label={`${plan.kind==='PACK'?'Buy Now':'Subscribe'}: ${plan.name}`}>{plan.kind==='PACK'?'Buy Now':'Subscribe'}</BuyLink>
   </article>):<p className={styles.availability} role="status">We could not load the plans just now. <Link href="/pricing">Refresh</Link> in a moment, or <Link href="/support">contact support</Link>.</p>}
  </div>
  <div className={`${styles.safetyNote} when-signed-out`}><p><Link href="/account#signup">Create your free account</Link> to start your trial, then come back here whenever you need more time.</p></div>
 </section>;
}
