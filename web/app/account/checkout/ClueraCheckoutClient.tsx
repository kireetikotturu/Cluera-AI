'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from '../../cluera-commerce.module.css';
import ClueraBillingHistory from './ClueraBillingHistory';
import {checkoutRequest} from '../../../lib/payments/cluera/checkoutRequest';
import {checkoutDenial, checkoutDenialMessage, checkoutFailureMessage, type CheckoutDenial} from '../../../lib/payments/cluera/checkoutFailure';
import type {ClueraBillingHistory as BillingHistory} from '../../../lib/payments/cluera/historyContracts';
import { z } from 'zod';
import { usageDuration } from '../../../lib/usage/display';
import {offerDisplay} from '../../../lib/billing/offerDisplay';
import { clueraTargetPlans } from '../../../lib/cluera/targetPlans';
import {selectionFromSearch,checkoutSelectionHref,checkoutSelectionName,type CheckoutSelection} from '../../../lib/cluera/checkoutJourney';
import { clueraBoundCheckoutForMode, clueraCatalogResponse, clueraCheckoutStatus,
  clueraAllowance, clueraPrice, type ClueraPublicRevision, type ClueraBoundCheckout,
} from '../../../lib/payments/cluera/publicCatalog';

const creditsSchema = z.object({ userId: z.uuid(), displayName: z.string().max(80).optional(),
  availableMilliseconds: z.number().int().nonnegative(), payments: z.array(z.object({
    offerCode: z.string().max(80), state: z.enum(['CREATING', 'BOUND', 'UNCERTAIN', 'REJECTED', 'VERIFIED', 'REFUNDED']),
    createdAt: z.iso.datetime({ offset: true }),
  })).max(10),
  plans:z.array(z.object({state:z.enum(['ACTIVE','QUEUED','PAUSED','ENDED','REFUNDED']),
    paymentState:z.enum(['ACTIVE','PAST_DUE','CANCELED','PAUSED'])})).max(30).optional(),
});
type Credits = z.infer<typeof creditsSchema>;
type CheckoutInstance = { open(): void; close(): void; on(event: string, callback: () => void): void };
type CheckoutConstructor = new (options: Record<string, unknown>) => CheckoutInstance;
const razorpay = () => (window as Window & { Razorpay?: CheckoutConstructor }).Razorpay;

async function loadSdk(signal: AbortSignal): Promise<void> {
  if (razorpay()) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.async = true;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', fail); script.onload = null; script.onerror = null; };
    const fail = () => { cleanup(); script.remove(); reject(new Error('Checkout unavailable.')); };
    const timer = setTimeout(fail, 10_000);
    script.onload = () => { cleanup(); razorpay() ? resolve() : fail(); }; script.onerror = fail;
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) { fail(); return; }
    document.head.append(script);
  });
}

/** Explicit user action only. Browser callbacks never fulfill or grant usage. */
export default function ClueraCheckoutClient({ enabled, offers = [], historyEnabled = false, cancellationEnabled = false, firstSubscriptionOnly = false, mode = 'test' }: {
  enabled: boolean; offers?: ClueraPublicRevision[]; historyEnabled?: boolean; cancellationEnabled?: boolean; firstSubscriptionOnly?:boolean; mode?:'test'|'live';
}) {
  const endpoint = mode === 'live' ? '/api/account/payments/cluera/live' : '/api/account/payments/cluera';
  const modeRef=useRef(mode);modeRef.current=mode;
  const statusId = useId();
  const [catalog, setCatalog] = useState<ClueraPublicRevision[]>(offers);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [selection,setSelection]=useState<CheckoutSelection|null>(null);
  const [busy, setBusy] = useState(false), [eligible, setEligible] = useState(false);
  const [signedOut,setSignedOut]=useState(false);
  const [watchPayment, setWatchPayment] = useState(false);
  const [observationCycle, setObservationCycle] = useState(0);
  const [historyVersion,setHistoryVersion]=useState(0);
  const verifiedCallback=useRef<{paymentId:string;revisionId:string;amountPaise:number}|null>(null);
  const completed=useRef(false);
  const balanceCurrent = useRef(false);
  const [resumeRevisionId, setResumeRevisionId] = useState<string | null>(null);
  const [message, setMessage] = useState('Checking your verified Cluera account…');
  const alive = useRef(false), epoch = useRef(0), owner = useRef<string | null>(null);
  const desktopOwner = useRef<string | null>(null), invalidHint = useRef(false), enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const overlayAbort = useRef<AbortController | null>(null), overlay = useRef<CheckoutInstance | null>(null);
  const uncertain = useRef(false), requestId = useRef<string | null>(null), binding = useRef<ClueraBoundCheckout | null>(null);
  const trailing = useRef(false), lastFocus = useRef(0);
  const pendingObserved = useRef(false);

  const deny = useCallback((reason: CheckoutDenial = 'ACCOUNT_MISMATCH') => {
    const preserveAccount = reason === 'TEST_PURCHASER_REQUIRED';
    epoch.current++; trailing.current = false;
    if (!preserveAccount) owner.current = null;
    write.current?.abort(); overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
    if (!preserveAccount) { binding.current = null; requestId.current = null; uncertain.current = false; }
    pendingObserved.current = false; verifiedCallback.current=null;completed.current=false;balanceCurrent.current=false;setWatchPayment(false);
    setResumeRevisionId(null);
    if (alive.current) { setSignedOut(reason === 'SIGNED_OUT');if (!preserveAccount) setCredits(null); setEligible(false); setBusy(false); setMessage(checkoutDenialMessage[reason]); }
  }, []);

  const rejectResponse = useCallback(async (response: Awaited<ReturnType<typeof checkoutRequest>>, current: () => boolean, resuming = false) => {
    if (response.ok) return false;
    const reason = checkoutDenial(response.status, await response.json());
    if (current()) {
      if (reason) deny(reason);
      else { setEligible(false); setMessage(resuming && response.status >= 500
        ? 'The existing order cannot safely continue. Verification or configuration is unavailable. Preserve it; do not create or retry a payment.'
        : checkoutFailureMessage(response.status)); }
    }
    return true;
  }, [deny]);

  const refresh = useCallback(async function refreshStatus(queue = false) {
    if (read.current || write.current) { if (queue) trailing.current = true; return; }
    if (invalidHint.current) { deny(); return; }
    const controller = new AbortController(), generation = epoch.current;
    const current = () => alive.current && modeRef.current===mode && !controller.signal.aborted && epoch.current === generation;
    read.current = controller; completed.current=false;balanceCurrent.current=false;setBusy(true); setEligible(false);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    try {
      const hint = desktopOwner.current ?? owner.current;
      const [accountResponse, catalogResponse] = await Promise.all([
        checkoutRequest(`/api/account/credits${hint ? `?desktopAccount=${encodeURIComponent(hint)}` : ''}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
        checkoutRequest(`${endpoint}/catalog`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
      ]);
      if (!current()) return;
      if (await rejectResponse(accountResponse, current)) return;
      const account = creditsSchema.parse(await accountResponse.json());
      if (!current()) return;
      if (hint && account.userId !== hint) { deny(); return; }
      owner.current = account.userId; setSignedOut(false);setCredits(account);setHistoryVersion(value=>value+1);
      if (!catalogResponse.ok) { setCatalog([]); throw new Error(); }
      const freshCatalog = clueraCatalogResponse.parse(await catalogResponse.json()).catalog;
      if (!current()) return; setCatalog(freshCatalog);
      if (!enabledRef.current) {
        setMessage('Cluera payment acceptance is pending. Checkout is disabled; no payment is requested.'); return;
      }
      const response = await checkoutRequest(`${endpoint}/checkout?expectedAccountId=${encodeURIComponent(account.userId)}`,
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
      if (!current()) return;
      if (await rejectResponse(response, current)) return;
      const status = clueraCheckoutStatus.parse(await response.json()).payment;
      if (!current()) return;
      if (status.userId !== account.userId || owner.current !== account.userId) { deny(); return; }
      const known = binding.current;
      // Only a fresh exact server-confirmed resolution can retire a known binding.
      // An unknown CREATE outcome cannot be cleared by an AVAILABLE snapshot.
      const resolvedKnown=Boolean(known && status.code === 'AVAILABLE' && !uncertain.current
        && (known.orderId ? status.resolvedOrderIds.includes(known.orderId)
          : Boolean(known.subscriptionId && status.resolvedSubscriptionIds.includes(known.subscriptionId))));
      if (resolvedKnown) {
        overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
        binding.current = null; requestId.current = null;
      }
      // Credits were read before this status. Read them once more after a
      // pending-to-resolved transition so a worker committing between the two
      // reads cannot leave the displayed balance behind the verified payment.
      if (resolvedKnown || pendingObserved.current && status.code === 'AVAILABLE') trailing.current = true;
      pendingObserved.current = status.code === 'PENDING';
      setWatchPayment(status.code === 'PENDING' || Boolean(binding.current) || uncertain.current);
      // This is only a candidate for an explicit read-only verification. The
      // server must still prove an untouched same order with zero payments.
      const pending = status.pending;
      setResumeRevisionId(pending && !pending.legacy && pending.kind === 'PACK' && pending.state === 'BOUND'
        && pending.orderId !== null && !binding.current && freshCatalog.some(row => row.revisionId === pending.revisionId && row.enabled && row.testPlanValidated)
        ? pending.revisionId : null);
      const canBuy = status.code === 'AVAILABLE' && !status.pending && !uncertain.current && !binding.current;
      // A resolution needs the trailing balance read to finish successfully.
      // History alone must not attest a stale or failed credits snapshot.
      balanceCurrent.current = canBuy && !trailing.current;
      setEligible(canBuy);
      setMessage(uncertain.current ? 'A checkout outcome is unknown. Keep this attempt for verification; do not retry.'
        : status.pending?.legacy ? 'An existing Account-era Razorpay attempt still requires verification. It is preserved, not resumed or recreated here. New checkout stays locked.'
        : status.code === 'PENDING' || binding.current ? 'Your payment or mandate is awaiting authoritative verification. Do not create another attempt.'
          : status.code === 'DISABLED' ? 'Purchases are not currently available for this account.'
            : completed.current ? 'Payment verified. Your available time and billing history are up to date.'
              : `Review your plan, then continue to secure Razorpay ${mode==='test'?'Test ':''}checkout.`);
    } catch {
      if (current()) { setEligible(false); setMessage(!enabledRef.current
        ? 'Cluera payment acceptance is pending. Checkout is disabled; no payment is requested.'
        : 'Account or payment verification is unavailable. Refresh status only; do not retry a payment.'); }
    } finally {
      if (read.current === controller) read.current = null;
      if (current()) setBusy(false);
      if (alive.current && trailing.current && !write.current) { trailing.current = false; void refreshStatus(); }
    }
  }, [deny, rejectResponse, endpoint, mode]);

  useEffect(() => {
    alive.current = true;
    setSelection(selectionFromSearch(location.search));
    const query=new URLSearchParams(location.search),hint=query.get('desktopAccount');
    invalidHint.current = query.getAll('desktopAccount').length>1||(hint !== null && !z.uuid().safeParse(hint).success);
    desktopOwner.current = invalidHint.current ? null : hint;
    void refresh();
    const focus = () => { if (Date.now() - lastFocus.current < 5_000) return; lastFocus.current = Date.now(); void refresh(); };
    window.addEventListener('focus', focus); window.addEventListener('online', focus);
    return () => {
      alive.current = false; epoch.current++; trailing.current = false;
      read.current?.abort(); read.current = null; write.current?.abort(); write.current = null;
      overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!watchPayment || !enabled) return;
    // A signed receipt can finish after the browser callback. Bounded GET-only
    // checks cover that normal delay without a second checkout or worker wake.
    // Four checks in two minutes stay within the existing authentication limit.
    let checks = 0;
    const timer = setInterval(() => {
      checks++;
      if (checks === 4) clearInterval(timer);
      if (document.visibilityState !== 'hidden') void refresh(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [enabled, refresh, watchPayment, observationCycle]);
  useEffect(() => {
    if (!enabled) {
      setWatchPayment(false);
      setResumeRevisionId(null);
      setEligible(false); write.current?.abort(); overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
      setMessage('Cluera payment acceptance is pending. Checkout is disabled; no payment is requested.');
    }
  }, [enabled]);

  const monthlyBlocked=firstSubscriptionOnly&&(credits?.plans===undefined||credits.plans.some(plan=>['ACTIVE','PAUSED','QUEUED'].includes(plan.state)||plan.paymentState!=='CANCELED'));
  const buy = async (revision: ClueraPublicRevision, resume = false) => {
    if (!enabledRef.current || (resume ? resumeRevisionId !== revision.revisionId : !eligible || uncertain.current)
      || busy || !credits || read.current || write.current || binding.current || !revision.enabled || !revision.testPlanValidated
      ||(revision.kind==='RECURRING'&&monthlyBlocked)) return;
    const accountId = credits.userId, generation = epoch.current, controller = new AbortController();
    const current = () => alive.current && modeRef.current===mode && enabledRef.current && !controller.signal.aborted
      && epoch.current === generation && owner.current === accountId;
    write.current = controller;
    if (!resume) { requestId.current ??= crypto.randomUUID(); uncertain.current = true; }
    setResumeRevisionId(null);
    verifiedCallback.current=null;completed.current=false;balanceCurrent.current=false;
    setWatchPayment(true);
    setObservationCycle(value => value + 1);
    setEligible(false); setBusy(true);
    try {
      const response = await checkoutRequest(resume ? `${endpoint}/resume?expectedAccountId=${encodeURIComponent(accountId)}` : `${endpoint}/checkout`,
        { method: resume ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          ...(resume ? {} : { headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedAccountId: accountId, requestId: requestId.current, revisionId: revision.revisionId }) }) });
      if (!current()) return;
      if (await rejectResponse(response, current, resume)) return;
      const checkout = clueraBoundCheckoutForMode(mode).parse(await response.json()).payment;
      if (!current()) return;
      if (checkout.revisionId !== revision.revisionId || checkout.offerCode !== revision.offerCode
        || checkout.kind !== revision.kind || checkout.amountPaise !== revision.amountPaise) throw new Error();
      binding.current = checkout; uncertain.current = false; overlayAbort.current = controller;
      await loadSdk(controller.signal); if (!current()) return;
      // HttpOnly account cookies can change in another tab while CREATE or SDK
      // loading is in flight. Refs alone cannot attest the CURRENT browser owner.
      // These GETs revalidate that owner and the exact canonical binding; no
      // provider mutation, callback, credit or replacement order is triggered.
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      const [accountResponse, statusResponse, resumeResponse] = await Promise.all([
        checkoutRequest(`/api/account/credits?desktopAccount=${encodeURIComponent(accountId)}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
        checkoutRequest(`${endpoint}/checkout?expectedAccountId=${encodeURIComponent(accountId)}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
        ...(resume ? [checkoutRequest(`${endpoint}/resume?expectedAccountId=${encodeURIComponent(accountId)}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal })] : []),
      ]);
      if (!current()) return;
      if (await rejectResponse(accountResponse, current) || await rejectResponse(statusResponse, current)
        || resumeResponse && await rejectResponse(resumeResponse, current)) return;
      const verifiedAccount = creditsSchema.parse(await accountResponse.json());
      if (!current()) return;
      if (verifiedAccount.userId !== accountId) { deny(); return; }
      const verifiedStatus = clueraCheckoutStatus.parse(await statusResponse.json()).payment;
      if (!current()) return;
      if (verifiedStatus.userId !== accountId) { deny(); return; }
      const pending = verifiedStatus.pending;
      if (verifiedStatus.code !== 'PENDING' || !pending || pending.legacy || pending.state !== 'BOUND'
        || pending.kind !== checkout.kind || pending.revisionId !== checkout.revisionId || pending.offerCode !== checkout.offerCode
        || pending.orderId !== checkout.orderId || pending.subscriptionId !== checkout.subscriptionId) throw new Error();
      if (resume) {
        if (!resumeResponse?.ok) throw new Error();
        const fresh = clueraBoundCheckoutForMode(mode).parse(await resumeResponse.json()).payment;
        if (!current()) return;
        if (fresh.orderId !== checkout.orderId || fresh.subscriptionId !== checkout.subscriptionId || fresh.kind !== checkout.kind
          || fresh.revisionId !== checkout.revisionId || fresh.offerCode !== checkout.offerCode || fresh.amountPaise !== checkout.amountPaise || fresh.keyId !== checkout.keyId) throw new Error();
      }
      setCredits(verifiedAccount);
      const Constructor = razorpay(); if (!Constructor) throw new Error();
      history.replaceState(null, '', '/account/checkout');
      let callbackStarted = false, exitObserved = false;
      const observeExit = (notice: string) => {
        if (!current() || exitObserved) return;
        exitObserved = true;
        setObservationCycle(value => value + 1);
        setMessage(notice); void refresh(true);
      };
      const instance = new Constructor({ key: checkout.keyId, name: mode === 'test' ? 'Cluera AI TEST' : 'Cluera AI',
        description: `${revision.name} · ${clueraAllowance(revision.allowanceSeconds)}`,
        ...(checkout.orderId ? { order_id: checkout.orderId, amount: checkout.amountPaise, currency: checkout.currency }
          : { subscription_id: checkout.subscriptionId }),
        retry: { enabled: false }, theme: { color: '#8b5cf6' },
        handler: async (raw: unknown) => {
          if (!current() || callbackStarted) return;
          callbackStarted = true;
          try {
            const common = { razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/), razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/) };
            const callback = checkout.orderId
              ? z.object({ ...common, razorpay_order_id: z.literal(checkout.orderId) }).strict().parse(raw)
              : z.object({ ...common, razorpay_subscription_id: z.literal(checkout.subscriptionId!) }).strict().parse(raw);
            const result = await checkoutRequest(`${endpoint}/callback`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expectedAccountId: accountId, orderId: checkout.orderId, subscriptionId: checkout.subscriptionId,
                paymentId: callback.razorpay_payment_id, signature: callback.razorpay_signature }) });
            if (!current()) return;
            if (await rejectResponse(result, current)) return;
            z.object({ payment: z.object({ code: z.literal('AWAITING_WEBHOOK') }).strict() }).strict().parse(await result.json());
            if (current()) {
              verifiedCallback.current={paymentId:callback.razorpay_payment_id,revisionId:checkout.revisionId,amountPaise:checkout.amountPaise};
              setMessage('Payment processing. We are confirming your payment and updating your balance automatically.');
            }
          } catch { if (current()) setMessage('The payment outcome needs verification. Do not retry or start another order.'); }
          if (current()) {
            // Checkout may have remained open longer than the original read
            // window. Observe delayed receipts from this return, not from Buy.
            setObservationCycle(value => value + 1);
            void refresh(true);
          }
        }, modal: { ondismiss: () => observeExit('Checkout closed. We are checking whether a payment completed.') },
      });
      instance.on('payment.failed', () => {
        observeExit('Payment failed or is incomplete. Do not retry.');
      });
      if (!current()) { instance.close(); return; }
      overlay.current = instance; instance.open();
      setMessage(mode==='test'?'Razorpay Test checkout is open. Use Test details only. Your balance updates after payment verification.'
        :'Razorpay checkout is open. Your balance updates after payment verification.');
    } catch { if (current()) setMessage(resume
      ? 'The existing order cannot safely continue. Preserve it for verification; do not create or retry a payment.'
      : 'Checkout is incomplete or unknown. Keep this attempt for verification; do not retry.'); }
    finally {
      if (write.current === controller) write.current = null;
      if (alive.current && epoch.current === generation) setBusy(false);
      if (alive.current && trailing.current) { trailing.current = false; void refresh(); }
    }
  };

  const historyLoaded=(history:BillingHistory)=>{
    const expected=verifiedCallback.current;
    if(!expected||!balanceCurrent.current||history.userId!==owner.current||binding.current||uncertain.current||pendingObserved.current)return;
    if(history.payments.some(payment=>payment.state==='VERIFIED'&&payment.paymentId===expected.paymentId&&payment.revision.revisionId===expected.revisionId&&payment.revision.amountPaise===expected.amountPaise)){
      completed.current=true;setMessage('Payment verified. Your available time and billing history are up to date.');
    }
  };
  const rows = catalog.length ? catalog : null;
  return <section className={`account-checkout-console ${styles.checkout}`} aria-label="Cluera billing" aria-busy={busy}>
    <header className={styles.checkoutHeader}>
      <p className={styles.eyebrow}>Cluera billing · Razorpay{mode==='test'?' Test':''}</p>
      <h2>Time for your next session</h2>
      <p>Choose a one-time pack or an available monthly plan. Review the price and terms before continuing.</p>
    </header>
    <div className={styles.status} id={statusId} role="status" aria-live="polite"><p>{message}</p></div>
    {firstSubscriptionOnly?<aside aria-label="Monthly purchase availability"><p>Monthly checkout supports your first subscription only. Additional monthly purchases, queued subscriptions and upgrades are unavailable.</p>
      {monthlyBlocked&&credits?<p>Your current subscription must be resolved before another monthly checkout. One-time packs remain separate.</p>:null}</aside>:null}
    {selection?<aside className="cluera-plan-handoff" aria-label="Selected Cluera plan"><p>Selected plan: <strong>{checkoutSelectionName(selection)}</strong></p>
      <p>Review the price and terms below. Payment starts only when you choose Buy Now or Subscribe Now.</p></aside>:null}
    <div className={styles.accountSummary}>
      {credits ? <dl><div><dt>Signed in as</dt><dd>{credits.displayName?.trim() || 'verified customer'}</dd></div><div><dt>Available time</dt><dd>{usageDuration(credits.availableMilliseconds)}</dd></div></dl>
        : <a className={styles.signIn} href={selection?checkoutSelectionHref(selection,true):'/account#login'}>Sign in to Cluera AI</a>}
      <button className={styles.refresh} type="button" disabled={busy} onClick={() => void refresh()}>Refresh billing status</button>
      {enabled && resumeRevisionId ? <button type="button" disabled={busy} onClick={() => {
        const revision = catalog.find(row => row.revisionId === resumeRevisionId); if (revision) void buy(revision, true);
      }}>Continue existing checkout</button> : null}
    </div>
    <div className={`account-pricing-grid ${styles.grid}`}>{rows ? rows.map(revision => {
      const canPurchase = enabled && eligible && !busy && revision.enabled && revision.testPlanValidated&&!(revision.kind==='RECURRING'&&monthlyBlocked);
      const canSignIn = enabled && signedOut && !credits && !busy && revision.enabled && revision.testPlanValidated;
      const action = canPurchase ? revision.kind === 'PACK' ? 'Buy Now' : 'Subscribe Now' : 'Checkout unavailable';
      return <article key={revision.revisionId} aria-label={revision.name} className={`account-plan-card ${styles.card}${selection?.offerCode===revision.offerCode?' cluera-plan-selected':''}`}>
        {selection?.offerCode===revision.offerCode?<p className="cluera-selection-badge">Selected plan</p>:null}
        <div className={styles.cardTop}><p className={styles.eyebrow}>{revision.kind === 'PACK' ? 'One-time pack' : 'Monthly subscription'}</p><span className={styles.badge}>{mode==='test'?'Test Mode only':'Secure payment'}</span></div>
        <h3>{revision.name}</h3>
        <p className={styles.price}>{clueraPrice(revision.amountPaise)}<span>{revision.kind === 'RECURRING' ? ' / month' : ' one time'}</span></p>
        <p className={styles.allowance}>{clueraAllowance(revision.allowanceSeconds)}{revision.kind === 'RECURRING' ? ' per month' : ''}</p>
        <ul className={styles.features}>
          <li><span aria-hidden="true">✓</span>{revision.kind === 'PACK' ? 'No expiry; packs stack' : 'Monthly hours do not roll over'}</li>
          <li><span aria-hidden="true">✓</span>One shared account balance</li>
          <li><span aria-hidden="true">✓</span>{revision.kind === 'PACK' ? 'One-time purchase' : `No rollover; up to ${revision.totalCount} monthly charges`}</li>
        </ul>
        <p className={styles.revision}>{revision.kind==='PACK'?'One payment. No automatic renewal.':'Renews monthly. Cancel future renewal while keeping your paid term. Unused monthly hours expire.'}</p>
        {revision.kind === 'RECURRING' && !revision.testPlanValidated ? <p className={styles.availability}>Plan and lifecycle acceptance pending. Not available.</p> : null}
        {canSignIn?<a className={styles.action} href={checkoutSelectionHref({offerCode:revision.offerCode,desktopAccount:desktopOwner.current},true)}
          aria-label={`Sign in to ${revision.kind==='PACK'?'buy':'subscribe'}: ${revision.name}`}>Sign in to {revision.kind==='PACK'?'buy':'subscribe'}</a>
          :<button className={styles.action} data-offer-code={revision.offerCode} type="button" disabled={!canPurchase} aria-label={`${action}: ${revision.name}`} aria-describedby={statusId}
          onClick={() => void buy(revision)}>{action}</button>}
      </article>;
    }) : clueraTargetPlans.map(plan => {
      const display = offerDisplay(plan);
      return <article key={plan.id} aria-label={plan.name} className={`account-plan-card ${styles.card}${selection?.offerCode===plan.offerCode?' cluera-plan-selected':''}`}>
        {selection?.offerCode===plan.offerCode?<p className="cluera-selection-badge">Selected plan</p>:null}
        <div className={styles.cardTop}><p className={styles.eyebrow}>Presentation only</p><span className={styles.badge}>Not yet purchasable</span></div>
        <h3>{plan.name}</h3>
        <p className={styles.price}>{clueraPrice(Number(plan.amount))}<span>{plan.interval ? ' / month' : ' one time'}</span></p>
        <p className={styles.allowance}>{display.hours} hours{plan.interval ? ' per month' : ''}</p>
        <ul className={styles.features}>
          <li><span aria-hidden="true">✓</span>{plan.interval ? 'Monthly hours do not roll over' : 'No expiry; verified packs stack'}</li>
          <li><span aria-hidden="true">✓</span>One shared account balance</li>
        </ul>
        <p className={styles.terms}>{display.terms}</p>
        <button className={styles.action} data-offer-code={plan.offerCode} type="button" disabled aria-label={`Checkout unavailable: ${plan.name}`} aria-describedby={statusId}>Checkout unavailable</button>
      </article>;
    })}</div>
    <div className={styles.safetyNote}><p>Razorpay shows the payment methods available for this plan and merchant. Your balance and billing history update automatically after verification. If a payment remains pending, keep its reference and <a href="mailto:clueraaisupport@gmail.com">contact support</a> before attempting another purchase.</p></div>
    <details className={styles.history} aria-label="Preserved server-confirmed history"><summary>Earlier payment attempts</summary>
      <h3>Preserved server-confirmed history</h3>
      <p>This clean Cluera project shows only its current server snapshot. Earlier Account and Paddle database history was not imported; provider-side obligations remain subject to independent reconciliation. Old drafts are not resumed, canceled or retried here.</p>
      {credits?.payments.length ? <ul>{credits.payments.map((payment, index) => <li key={`${payment.createdAt}:${index}`}>
        <span>{payment.offerCode}</span><span className={styles.badge}>{payment.state}</span><time dateTime={payment.createdAt}>{payment.createdAt}</time>
      </li>)}</ul> : <p>No historical entries are displayed in this snapshot.</p>}
    </details>
    <ClueraBillingHistory key={mode} mode={mode} accountId={credits?.userId??null} enabled={historyEnabled} disabled={busy} cancellationEnabled={cancellationEnabled} autoLoad refreshKey={historyVersion} onLoaded={historyLoaded}/>
  </section>;
}
