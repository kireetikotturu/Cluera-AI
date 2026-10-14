import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { assertCheckoutStaging } from '../../../lib/billing/checkout/service';
import { sandboxCheckoutEnabled } from '../../../lib/billing/checkout/gate';
import { readAccountCatalog } from '../../../lib/accounts/catalog';
import PurchasePortal from './PurchasePortal';
import {offerDisplay} from '../../../lib/billing/offerDisplay';
import RazorpayCheckout from './RazorpayCheckout';
import { razorpayCheckoutEnabled } from '../../../lib/payments/core/config';
import {STAGING_DATABASE,STAGING_SITE} from '../../../lib/accountRelay/config';
import ClueraCheckoutClient from './ClueraCheckoutClient';
import {clueraCheckoutEnabled} from '../../../lib/payments/cluera/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Cluera sandbox checkout', robots: { index: false, follow: false } };

/** A private staging enablement gate, never a token/query parameter, enables UI. */
export default async function CheckoutPage() {
  if(process.env.CLUERA_BILLING_V2_ENABLED==='true'){
    if(process.env.SIGMAROUND_ACCOUNTS_ENABLED!=='true'||process.env.SIGMAROUND_ACCOUNT_ORIGIN!==STAGING_SITE
      ||process.env.NEXT_PUBLIC_SUPABASE_URL!==STAGING_DATABASE)notFound();
    return <main className="account-page"><h1>Buy Cluera credits</h1>
      <p>Razorpay Test only. Checkout requires a separately approved rollout and the existing verified tester gate. No Live payments or Stripe.</p>
      <ClueraCheckoutClient enabled={clueraCheckoutEnabled()}/>
      <a href="/account">Return to your account</a></main>;
  }
  // Presentation only: a paused new Cluera rollout must not need old Paddle
  // credentials merely to explain an unavailable purchase. Financial APIs keep
  // their original, independent provider/project/credential/tester guards.
  if(process.env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED!=='true'){
    if(process.env.SIGMAROUND_ACCOUNTS_ENABLED!=='true'||process.env.SIGMAROUND_ACCOUNT_ORIGIN!==STAGING_SITE
      ||process.env.NEXT_PUBLIC_SUPABASE_URL!==STAGING_DATABASE)notFound();
    return <main className="account-page"><h1>Buy Cluera credits</h1><p>Test payments are paused. No payment is enabled in this Cluera workspace. Recurring offers and Stripe are unavailable.</p>
      <p>Owner-confirmed planned pricing only; these are not active catalog offers. Existing payment history and allowances are unchanged.</p>
      <ClueraCheckoutClient enabled={false}/><a href="/account">Return to your account</a></main>;
  }
  let staging = false;
  try { assertCheckoutStaging(process.env); staging = true; } catch { /* Non-staging: no checkout surface. */ }
  if (!staging) notFound();
  const enabled=sandboxCheckoutEnabled();
   let offers;try{offers=await readAccountCatalog();}catch{return <main className="account-page"><h1>Buy Account credits</h1><p>The approved catalog is unavailable. No checkout was started.</p><a href="/account">Return to your account</a></main>;}
   if(process.env.SIGMAROUND_PAYMENT_PROVIDER==='razorpay')return <main className="account-page"><h1>Buy Account credits</h1>
    <p>Razorpay Test Mode · no Live payments. One-time pack first; recurring offers and Stripe are not operational yet.</p>
    <RazorpayCheckout enabled={razorpayCheckoutEnabled()} offers={offers.filter(offer=>offer.enabled).map(offer=>({code:offer.code,name:offer.name,...offerDisplay(offer)}))}/>
    <a href="/account">Return to your account</a></main>;
   return <main className="account-page"><h1>Buy Account credits</h1><p>Paddle Sandbox · TEST only · no live payment. Payment testing is temporarily restricted in staging; normal customer purchases are self-service.</p>
    <PurchasePortal enabled={enabled} clientToken={enabled?process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:undefined} offers={offers.filter(offer=>offer.enabled).map(offer=>({code:offer.code,name:offer.name,
      ...offerDisplay(offer)}))}/>
    <a href="/account">Return to your account</a></main>;
}
