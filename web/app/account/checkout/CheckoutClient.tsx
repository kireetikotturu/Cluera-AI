'use client';
import {useEffect,useRef,useState} from 'react';
import {checkoutFailureMessage} from '../../../lib/billing/checkout/failureMessage';

type PaddleClient={Environment:{set:(environment:'sandbox')=>void};Initialize:(options:{token:string;eventCallback:(event:{name?:string})=>void})=>void;
  Checkout:{open:(options:{transactionId:string;settings:{displayMode:'overlay';showAddDiscounts:false}})=>void;close:()=>void}};
declare global {interface Window {Paddle?:PaddleClient}}
let sdk:Promise<PaddleClient>|undefined;
let initializedToken:string|undefined;
let checkoutEvent:((event:{name?:string})=>void)|undefined;
function loadSdk(){
  if(window.Paddle)return Promise.resolve(window.Paddle);
  if(sdk)return sdk;
  sdk=new Promise<PaddleClient>((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://cdn.paddle.com/paddle/v2/paddle.js';script.async=true;
    const failed=()=>{clearTimeout(deadline);script.onload=null;script.onerror=null;script.remove();sdk=undefined;reject(new Error('Checkout unavailable'));};
    const deadline=setTimeout(failed,10000); // One user-initiated load deadline, never a poll.
    script.onload=()=>{clearTimeout(deadline);if(window.Paddle)resolve(window.Paddle);else failed();};
    script.onerror=failed;
    document.head.append(script);
  });return sdk;
}

/** No mount request, interval, storage or automatic _ptxn handling. An explicit
 * click opens only a server-verified owned transaction, never a query-supplied ID. */
export default function CheckoutClient({clientToken,offers,expectedAccountId,onCheckoutEvent,onBoundCheckout,serverBlocked=false,pendingOfferCode,pendingLabel,allowResume=false}:{clientToken:string;offers:{code:string;name:string;label:string;terms?:string}[];expectedAccountId?:string;onCheckoutEvent?:()=>void;onBoundCheckout?:(binding:{transactionId:string;offerCode:string})=>boolean|void;serverBlocked?:boolean;pendingOfferCode?:string;pendingLabel?:string;allowResume?:boolean}){
  const [busyOffer,setBusyOffer]=useState<string|null>(null);
  const [messages,setMessages]=useState<Record<string,string>>({});
  const [needsReview,setNeedsReview]=useState(false);
  const [opened,setOpened]=useState(false);
  const lock=useRef(false),reviewLock=useRef(false),alive=useRef(true),ids=useRef(new Map<string,string>());
  const listener=useRef<((event:{name?:string})=>void)|undefined>(undefined);
  const active=useRef<AbortController|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;active.current?.abort();
    if(checkoutEvent===listener.current)checkoutEvent=undefined;
    window.Paddle?.Checkout.close();};},[]);
  const message=(offerCode:string,text:string)=>{if(alive.current)setMessages(previous=>({...previous,[offerCode]:text}));};
  const requireReview=(offerCode:string,detail='')=>{reviewLock.current=true;if(alive.current)setNeedsReview(true);
    message(offerCode,detail||'Checkout needs verification. Do not retry or select another plan. Contact support before another attempt.');};
  async function openBoundTransaction(transactionId:string,offerCode:string){
    if(!alive.current)return;
    // Keep the same local operation and block all new plans through SDK outcomes.
    reviewLock.current=true;setOpened(true);
    // Reached only after a verified BOUND/RESUMABLE response. SDK/browser events
    // never acknowledge a binding or clear this child's operation lock.
    // A parent can reject a stale owner/epoch before deferred React cleanup.
    if(onBoundCheckout?.({transactionId,offerCode})===false)return;
    // Paddle.js can consume _ptxn at Initialize. Never load it with query/hash input.
    history.replaceState(history.state,'','/account/checkout');
    const paddle=await loadSdk();if(!alive.current)return;
    if(initializedToken&&initializedToken!==clientToken)throw new Error('Reload checkout');
    listener.current=event=>{if(!alive.current)return;
      if(event.name==='checkout.completed'){message(offerCode,'Payment submitted. Your balance updates only after server verification.');onCheckoutEvent?.();}
      else if(event.name==='checkout.closed'){message(offerCode,'Checkout closed. Closing is not proof of cancellation or failure; check the server account status before paying again.');onCheckoutEvent?.();}
      else if(event.name==='checkout.error'||event.name==='checkout.payment.failed'||event.name==='checkout.payment.error'){requireReview(offerCode);onCheckoutEvent?.();}};
    checkoutEvent=listener.current;
    if(!initializedToken){
      paddle.Environment.set('sandbox');paddle.Initialize({token:clientToken,eventCallback:event=>checkoutEvent?.(event)});
      initializedToken=clientToken;
    }
    paddle.Checkout.open({transactionId,settings:{displayMode:'overlay',showAddDiscounts:false}});
    message(offerCode,'Complete the sandbox checkout. Browser success does not grant account time.');
  }
  async function checkout(offerCode:string){
    if(serverBlocked||lock.current||reviewLock.current||!offers.some(offer=>offer.code===offerCode))return;
    lock.current=true;setBusyOffer(offerCode);
    message(offerCode,'Preparing verified sandbox checkout…');
    const controller=new AbortController();active.current=controller;
    try{
      const requestId=ids.current.get(offerCode)??crypto.randomUUID();ids.current.set(offerCode,requestId);
      const response=await fetch('/api/account/checkout',{method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,offerCode,...(expectedAccountId?{expectedAccountId}:{})}),
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
      if(!response.ok){
        if(response.status===401)message(offerCode,'Sign in with your verified Sigma account first.');
        else {
          let detail='';
          try{const result=await response.json();if(result?.checkout?.code==='PENDING')detail=checkoutFailureMessage(result.checkout.failure);}catch{ /* Unknown outcomes stay locked. */ }
          requireReview(offerCode,detail);
        }
        return;
      }
      const data=await response.json();
      if(data.checkout?.code!=='BOUND'||typeof data.checkout.transactionId!=='string'||!/^txn_[a-z0-9]{26}$/.test(data.checkout.transactionId))throw new Error('Invalid checkout');
      await openBoundTransaction(data.checkout.transactionId,offerCode);
    }catch{requireReview(offerCode);}
    finally{lock.current=false;if(alive.current)setBusyOffer(null);}
  }
  async function resume(){
    if(!allowResume||!expectedAccountId||!pendingOfferCode||lock.current||reviewLock.current||needsReview||opened)return;
    const offerCode=pendingOfferCode;lock.current=true;setBusyOffer(offerCode);
    message(offerCode,'Verifying the existing sandbox checkout…');
    const controller=new AbortController();active.current=controller;
    try{
      const response=await fetch(`/api/account/checkout-resume?expectedAccountId=${encodeURIComponent(expectedAccountId)}`,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
        referrerPolicy:'same-origin',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
      if(!response.ok)throw new Error('Existing checkout unavailable');
      const data=await response.json();
      if(data.checkout?.code!=='RESUMABLE'||typeof data.checkout.offerCode!=='string'||data.checkout.offerCode!==offerCode||!offers.some(offer=>offer.code===data.checkout.offerCode)||typeof data.checkout.transactionId!=='string'||!/^txn_[a-z0-9]{26}$/.test(data.checkout.transactionId))throw new Error('Invalid existing checkout');
      await openBoundTransaction(data.checkout.transactionId,offerCode);
    }catch{requireReview(offerCode,'The existing checkout could not be verified. Do not retry or start another purchase; refresh server status or contact support.');}
    finally{lock.current=false;if(alive.current)setBusyOffer(null);}
  }
  return <section aria-label="Sandbox plans">
    <p>Select a sandbox plan only when instructed to test payment. Only one checkout can be prepared at a time.</p>
    {allowResume&&<><p>This resumes the existing server-bound checkout. It does not create another transaction or grant credits.</p><button type="button" disabled={busyOffer!==null||needsReview||opened} onClick={()=>void resume()}>Resume existing Sandbox checkout</button></>}
    {(busyOffer||needsReview||opened)&&<p>{needsReview?'Plan selection is paused until the unresolved checkout is verified.':opened?'Check server payment status before making another purchase.':
      'Other plans are temporarily unavailable while the selected checkout is prepared.'}</p>}
    <div className="account-purchase-grid">{offers.map(offer=><div key={offer.code} role="group" aria-labelledby={`offer-${offer.code}`}>
      <h2 id={`offer-${offer.code}`}>{offer.name}</h2><p>{offer.label}</p>{offer.terms&&<p>{offer.terms}</p>}
      <button type="button" disabled={serverBlocked||busyOffer!==null||needsReview||opened} aria-busy={busyOffer===offer.code}
        aria-describedby={messages[offer.code]?`status-${offer.code}`:undefined}
        onClick={()=>void checkout(offer.code)}>{busyOffer===offer.code?'Preparing checkout…':serverBlocked?(pendingOfferCode===offer.code&&pendingLabel?pendingLabel:'Checkout unavailable'):'Continue in sandbox'}</button>
      {messages[offer.code]&&<p id={`status-${offer.code}`} role="status" aria-live="polite">{messages[offer.code]}</p>}
    </div>)}</div>
    <p>This is Paddle Sandbox, not a live purchase. Allowances are granted only by server reconciliation.</p>
  </section>;
}
