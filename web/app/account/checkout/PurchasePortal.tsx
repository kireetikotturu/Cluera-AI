'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {AccountCredits} from '../../../../desktop/src/shared/accountCredits';
import {usageDuration} from '../../../lib/usage/display';
import CheckoutClient from './CheckoutClient';
const paymentLabels:Record<string,string>={CREATING:'Preparing — do not retry',BOUND:'Awaiting authoritative payment verification',
 UNCERTAIN:'Needs operator verification — do not retry',REJECTED:'Attempt rejected — not proof of a completed payment',
 VERIFIED:'Server-verified entitlement',REFUNDED:'Refund reconciled — unused attributable time removed'};
const unresolvedStates=new Set(['CREATING','BOUND','UNCERTAIN']);
const paymentStates=new Set(Object.keys(paymentLabels));
const paymentOfferCodes=new Set(['pro_3_hours','pro_40_hours','enterprise_weekly','enterprise_monthly']);
type BoundCheckout={transactionId:string;offerCode:string};
export default function PurchasePortal({clientToken,offers,enabled}:{clientToken?:string;enabled:boolean;offers:{code:string;name:string;label:string;terms?:string}[]}){
 const [account,setAccount]=useState<AccountCredits|null>(null),[message,setMessage]=useState('Checking your verified Account session…');
 const [loading,setLoading]=useState(true);
 const [statusVerified,setStatusVerified]=useState(false),[checkoutEpoch,setCheckoutEpoch]=useState(0);
 const active=useRef<AbortController|null>(null),alive=useRef(false),owner=useRef<string|null>(null),lastFocus=useRef(0),queued=useRef(false);
 const desktopOwner=useRef<string|null|undefined>(undefined);
 const readSequence=useRef(0),currentCheckoutEpoch=useRef(0);
 const acknowledgedBinding=useRef<(BoundCheckout&{userId:string;epoch:number;readBarrier:number})|null>(null);
 const refresh=useCallback(async function refreshStatus(queue=false){
  if(active.current){if(queue)queued.current=true;return;}
  const controller=new AbortController();active.current=controller;setLoading(true);
  const read=++readSequence.current,bindingAtStart=acknowledgedBinding.current;
  let definiteDenial=false,failureMessage='Account billing status is unavailable.';
  const expected=desktopOwner.current??owner.current;
  const query=expected?`?desktopAccount=${encodeURIComponent(expected)}`:'';
  try{
   const response=await fetch(`/api/account/credits${query}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    // A definite session/owner denial invalidates the remembered browser owner.
    // The next read verifies the live browser session; an original desktop hint
    // remains pinned even after Paddle input stripping. Unknown reads do not
    // clear this fence or any CheckoutClient operation UUID.
    if((response.status===401||response.status===403)&&!controller.signal.aborted&&alive.current){
     definiteDenial=true;owner.current=null;acknowledgedBinding.current=null;
    }
    if(response.status===401){failureMessage='Sign in to the Account website with your verified desktop account, then reopen Buy Credits.';throw new Error();}
    if(response.status===403){failureMessage='The browser must use the same verified account as the desktop. Check your account or suspension status.';throw new Error();}
    if(!response.ok){failureMessage='Account billing status is unavailable. No new checkout was started by this status read.';throw new Error();}
    const value=await response.json() as AccountCredits;
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.userId!=='string'||typeof value.checkoutAvailable!=='boolean'||(expected&&value.userId!==expected)||
     (value.displayName!==undefined&&typeof value.displayName!=='string'))throw new Error('Account billing status is unavailable.');
    if(!Array.isArray(value.payments)||value.payments.some(payment=>
     !payment||typeof payment!=='object'||typeof payment.state!=='string'||!paymentStates.has(payment.state)||
     typeof payment.offerCode!=='string'||!paymentOfferCodes.has(payment.offerCode)||typeof payment.createdAt!=='string'||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(payment.createdAt)||!Number.isFinite(Date.parse(payment.createdAt))))
     throw new Error('Account billing status is unavailable.');
    if(!controller.signal.aborted&&alive.current){
     // Only a read begun after a verified binding acknowledgment may retire its
     // local operation. Browser events, older reads and rejected history alone
     // never clear uncertain writes or authorize another purchase.
     if(bindingAtStart&&acknowledgedBinding.current===bindingAtStart&&read>bindingAtStart.readBarrier&&
      bindingAtStart.epoch===currentCheckoutEpoch.current&&bindingAtStart.userId===value.userId&&owner.current===value.userId&&
      value.checkoutAvailable&&!value.payments.some(payment=>unresolvedStates.has(payment.state))){
      acknowledgedBinding.current=null;currentCheckoutEpoch.current++;
      setCheckoutEpoch(currentCheckoutEpoch.current);
     }
     owner.current=value.userId;setAccount(value);setStatusVerified(true);setMessage('Purchases and usage belong to your signed-in Account.');
    }
  }catch{if(!controller.signal.aborted&&alive.current){
   // Preserve the same child and its unknown operation UUID across unavailable
   // or mismatched reads. Hide it only after a definitive session/owner denial.
   setStatusVerified(false);if(definiteDenial)setAccount(null);
   setMessage(failureMessage);
  }}
  finally{if(active.current===controller){active.current=null;if(alive.current){setLoading(false);if(queued.current){queued.current=false;void refreshStatus();}}}}
 },[]);
 useEffect(()=>{
  if(desktopOwner.current===undefined)desktopOwner.current=new URL(location.href).searchParams.get('desktopAccount');
  alive.current=true;void refresh();
  const focused=()=>{const now=Date.now();if(now-lastFocus.current<5000)return;lastFocus.current=now;void refresh();};window.addEventListener('focus',focused);window.addEventListener('online',focused);
  return()=>{alive.current=false;queued.current=false;active.current?.abort();active.current=null;window.removeEventListener('focus',focused);window.removeEventListener('online',focused);};
 },[refresh]);
 const pending=(account?.payments??[]).find(payment=>unresolvedStates.has(payment.state));
 const canCheckout=enabled&&Boolean(clientToken)&&statusVerified&&Boolean(account?.checkoutAvailable)&&!pending;
 const showCheckout=Boolean(account&&enabled&&clientToken);
 const acknowledgeBinding=(binding:BoundCheckout)=>{
  if(alive.current&&account&&owner.current===account.userId&&currentCheckoutEpoch.current===checkoutEpoch){
   acknowledgedBinding.current={...binding,userId:account.userId,epoch:checkoutEpoch,readBarrier:readSequence.current};
   return true;
  }
  return false;
 };
 const needsVerification=pending?.state==='UNCERTAIN';
 const pendingLabel=needsVerification?'Verification required':pending?.state==='BOUND'?'Existing checkout pending':'Preparing checkout';
 const availability=account&&!statusVerified&&!loading?'Server payment status is unavailable. Displayed history may be stale; purchase and resume remain disabled until a fresh verified read.':
  pending?(needsVerification?'An earlier checkout needs verification. Do not retry or select another plan. No new payment was started by this page.':
  pending.state==='BOUND'?'An existing checkout is awaiting authoritative payment verification. Do not start another checkout or select another plan.':
  'An existing checkout is being prepared. Do not retry or select another plan.'):
  !enabled||!clientToken?'Sandbox payments are paused or unavailable. No live purchase can be started.':
  !account?(loading?'Checking your sign-in and server payment status.':'Sign in with your verified Account to check purchase availability.'):
  'Sandbox payment testing is currently limited. Checkout is not available for this account. Normal customer purchases do not require administrator approval.';
 return <section aria-label="Buy Account credits"><p role="status">{message}</p>
  <p>Sign in, choose a plan, then pay through secure Paddle Checkout. Your account is linked automatically; no account ID entry or administrator approval is needed to buy credits.</p>
  {account?.displayName&&<p>Signed in as {account.displayName}. <a href="/account">Manage account / sign out</a></p>}
  {!account&&<a href="/account">Sign in / manage account</a>}
  {!canCheckout&&<><div className="account-checkout-notice" role="status" aria-live="polite"><h2>{pending?(needsVerification?'Checkout needs verification':'Existing checkout pending'):!account?'Sign in to buy credits':'Checkout unavailable'}</h2><p>{availability}</p>{pending&&<p>Use Refresh server payment status for a read-only update. An unresolved checkout does not prove a completed payment, and a rejected attempt is retained only in history.</p>}</div>
   {!showCheckout&&<div className="account-purchase-grid">{offers.map(offer=><article key={offer.code}><h2>{offer.name}</h2><p>{offer.label}</p>{offer.terms&&<p>{offer.terms}</p>}<button type="button" disabled>{pending?.offerCode===offer.code?pendingLabel:'Checkout unavailable'}</button></article>)}</div>}</>}
  {showCheckout&&<CheckoutClient key={`${account!.userId}-${checkoutEpoch}`} clientToken={clientToken!} offers={offers} expectedAccountId={account!.userId} onCheckoutEvent={()=>void refresh(true)} onBoundCheckout={acknowledgeBinding}
   serverBlocked={!canCheckout||loading} pendingOfferCode={pending?.offerCode} pendingLabel={pendingLabel} allowResume={pending?.state==='BOUND'&&statusVerified&&!loading}/>}
  {account&&<section aria-label="Server payment status"><h2>Server-confirmed status</h2>
   {Number.isSafeInteger(account.availableMilliseconds)&&<p>Available time: {usageDuration(account.availableMilliseconds)}. No browser callback grants credits.</p>}
   <ul>{(account.payments??[]).slice(0,10).map((payment,index)=><li key={`${payment.createdAt}-${index}`}>{offers.find(offer=>offer.code===payment.offerCode)?.name??'Account purchase'}: {paymentLabels[payment.state]??'Status unavailable'}{Number.isFinite(Date.parse(payment.createdAt))&&<> · <time dateTime={payment.createdAt}>{new Date(payment.createdAt).toLocaleString()}</time></>}</li>)}</ul>
   <p>Closing checkout does not prove cancellation. Pending/failed browser events are not a paid entitlement. A status refresh never starts a transaction or grants time; do not pay twice.</p>
  </section>}
  <button type="button" disabled={loading} onClick={()=>void refresh()}>{loading?'Checking server status…':'Refresh server payment status'}</button>
  <p>Payment methods, including QR/mobile options where supported, are presented only by Paddle’s secure checkout. Availability depends on currency, location, device and gateway configuration. A QR scan or browser success never grants time.</p>
 </section>;
}
