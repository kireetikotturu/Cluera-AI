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
export default function ClueraCheckoutClient({ enabled, offers = [], historyEnabled = false, cancellationEnabled = false, firstSubscriptionOnly = false, mode = 'test', checkoutWindowSeconds = 600, pricing = false, catalogKnown = false }: {
  enabled: boolean; offers?: ClueraPublicRevision[]; historyEnabled?: boolean; cancellationEnabled?: boolean; firstSubscriptionOnly?:boolean; mode?:'test'|'live'; checkoutWindowSeconds?:number; pricing?:boolean; catalogKnown?:boolean;
}) {
  const endpoint = mode === 'live' ? '/api/account/payments/cluera/live' : '/api/account/payments/cluera';
  const modeRef=useRef(mode);modeRef.current=mode;
  const statusId = useId();
  const [catalog, setCatalog] = useState<ClueraPublicRevision[]>(offers);
  const [catalogLoaded, setCatalogLoaded] = useState(catalogKnown);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [selection,setSelection]=useState<CheckoutSelection|null>(null);
  const [busy, setBusy] = useState(false), [eligible, setEligible] = useState(false);
  const [quietRead, setQuietRead] = useState(false);
  const [preparing,setPreparing]=useState(false),[remaining,setRemaining]=useState<number|null>(null),[cooldown,setCooldown]=useState(0);
  const cooldownUntil=useRef(0),windowDeadline=useRef<number|null>(null),windowTimer=useRef<ReturnType<typeof setInterval>|null>(null);
  const needsReconcile=useRef(false),exitNotice=useRef<string|null>(null);
  const preparationFailure=useRef<string|null>(null);
  const resumeProof=useRef<string|null>(null);
  const windowSeconds=Number.isInteger(checkoutWindowSeconds)&&checkoutWindowSeconds>=60&&checkoutWindowSeconds<=1800?checkoutWindowSeconds:600;
  const [signedOut,setSignedOut]=useState(false);
  const [watchPayment, setWatchPayment] = useState(false);
  const [observationCycle, setObservationCycle] = useState(0);
  const [historyVersion,setHistoryVersion]=useState(0);
  const verifiedCallback=useRef<{paymentId:string;revisionId:string;amountPaise:number}|null>(null);
  const callbackObserved=useRef(false);
  const completed=useRef(false);
  const balanceCurrent = useRef(false);
  const [resumeRevisionId, setResumeRevisionId] = useState<string | null>(null);
  const [cancellable, setCancellable] = useState(false), [cancelling, setCancelling] = useState(false);
  const cancelNotice = useRef<string | null>(null);
  const [message, setMessage] = useState('Checking your verified Cluera account…');
  const alive = useRef(false), epoch = useRef(0), owner = useRef<string | null>(null);
  const desktopOwner = useRef<string | null>(null), invalidHint = useRef(false), enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const overlayAbort = useRef<AbortController | null>(null), overlay = useRef<CheckoutInstance | null>(null);
  const uncertain = useRef(false), requestId = useRef<string | null>(null), binding = useRef<ClueraBoundCheckout | null>(null);
  const trailing = useRef(false), lastFocus = useRef(0);
  const pendingObserved = useRef(false);
  const clearWindow=useCallback(()=>{if(windowTimer.current)clearInterval(windowTimer.current);windowTimer.current=null;windowDeadline.current=null;if(alive.current)setRemaining(null);},[]);

  const deny = useCallback((reason: CheckoutDenial = 'ACCOUNT_MISMATCH') => {
    const preserveAccount = reason === 'TEST_PURCHASER_REQUIRED' || reason === 'LIVE_PURCHASER_REQUIRED';
    epoch.current++; trailing.current = false;
    clearWindow();needsReconcile.current=false;exitNotice.current=null;preparationFailure.current=null;resumeProof.current=null;
    if (!preserveAccount) owner.current = null;
    write.current?.abort(); overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
    if (!preserveAccount) { binding.current = null; requestId.current = null; uncertain.current = false; }
    pendingObserved.current = false; verifiedCallback.current=null;callbackObserved.current=false;completed.current=false;balanceCurrent.current=false;setWatchPayment(false);
    setResumeRevisionId(null);
    if (alive.current) { setPreparing(false);setSignedOut(reason === 'SIGNED_OUT');if (!preserveAccount) setCredits(null); setEligible(false); setBusy(false); setMessage(checkoutDenialMessage[reason]); }
  }, [clearWindow]);

  const rejectResponse = useCallback(async (response: Awaited<ReturnType<typeof checkoutRequest>>, current: () => boolean, resuming = false) => {
    if (response.ok) return false;
    const body=await response.json(),reason = checkoutDenial(response.status, body);
    if (current()) {
      if(response.status===429){cooldownUntil.current=Date.now()+response.retryAfterSeconds*1000;setCooldown(response.retryAfterSeconds);}
      if (reason) deny(reason);
      else { setEligible(false); const notice = resuming && response.status >= 500
        ? 'We could not reopen this order right now. Try again in a moment, or cancel it and start a new one.'
        : checkoutFailureMessage(response.status,body);
        if (write.current || resuming) { preparationFailure.current=notice;resumeProof.current=null;setResumeRevisionId(null); }
        setMessage(notice); }
    }
    return true;
  }, [deny]);

  const refresh = useCallback(async function refreshStatus(queue = false, quiet = false) {
    if(Date.now()<cooldownUntil.current)return;
    if (read.current || write.current) { if (queue) trailing.current = true; return; }
    if (invalidHint.current) { deny(); return; }
    const controller = new AbortController(), generation = epoch.current;
    const current = () => alive.current && modeRef.current===mode && !controller.signal.aborted && epoch.current === generation;
    read.current = controller; completed.current=false;balanceCurrent.current=false;setQuietRead(quiet);setBusy(true); setEligible(false);
    // Each transport bounds its own fetch and body read to fifteen seconds.
    // A shared deadline would cut short resume after slower account/status reads
    // and discard its useful refusal. Account changes still abort the whole chain.
    const signal = controller.signal;
    let checkingResume=false;
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
      if (!current()) return; setCatalog(freshCatalog); setCatalogLoaded(true);
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
        clearWindow();exitNotice.current=null;preparationFailure.current=null;resumeProof.current=null;
        overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
        binding.current = null; requestId.current = null;callbackObserved.current=false;
      }
      // Credits were read before this status. Read them once more after a
      // pending-to-resolved transition so a worker committing between the two
      // reads cannot leave the displayed balance behind the verified payment.
      if (resolvedKnown || pendingObserved.current && status.code === 'AVAILABLE') trailing.current = true;
      pendingObserved.current = status.code === 'PENDING';
      setCancellable(mode==='live' && status.code === 'PENDING' && Boolean(status.pending) && !status.pending?.legacy && status.pending?.kind === 'PACK' && !callbackObserved.current);
      setWatchPayment(status.code === 'PENDING' || Boolean(binding.current) || uncertain.current);
      // This is only a candidate for an explicit read-only verification. The
      // server must still prove an untouched same order with zero payments.
      const pending = status.pending;
      const resumable=pending && !pending.legacy && pending.kind === 'PACK' && pending.state === 'BOUND'
        && pending.orderId !== null && !overlay.current && !uncertain.current && !callbackObserved.current
        && (!binding.current||binding.current.orderId===pending.orderId)
        && freshCatalog.some(row => row.revisionId === pending.revisionId && row.enabled && row.testPlanValidated);
      const proofKey=resumable?`${pending.orderId}:${pending.revisionId}`:null;
      setResumeRevisionId(resumable && resumeProof.current===proofKey && !preparationFailure.current && !needsReconcile.current ? pending.revisionId : null);
      if(resumable&&(needsReconcile.current||!preparationFailure.current&&resumeProof.current!==proofKey)){
        needsReconcile.current=false;checkingResume=true;
        setMessage('Checking whether your saved order can continue…');
        const proof=await checkoutRequest(`${endpoint}/resume?expectedAccountId=${encodeURIComponent(account.userId)}`,
          {credentials:'same-origin',cache:'no-store',redirect:'error',signal});
        if(!current())return;
        if(!proof.ok){setResumeRevisionId(null);await rejectResponse(proof,current,true);return;}
        const same=clueraBoundCheckoutForMode(mode).parse(await proof.json()).payment;
        if(same.orderId!==pending.orderId||same.revisionId!==pending.revisionId)throw Error('Binding changed');
        preparationFailure.current=null;resumeProof.current=proofKey;checkingResume=false;setResumeRevisionId(pending.revisionId);
      }
      // A BOUND database row is not a fresh provider proof. Background polling
      // must not erase a failed preparation or silently offer that order again.
      if(preparationFailure.current && (status.code==='PENDING'||binding.current||uncertain.current)) {
        setMessage(preparationFailure.current);return;
      }
      const canBuy = status.code === 'AVAILABLE' && !status.pending && !uncertain.current && !binding.current;
      // A resolution needs the trailing balance read to finish successfully.
      // History alone must not attest a stale or failed credits snapshot.
      balanceCurrent.current = canBuy && !trailing.current;
      setEligible(canBuy);
      setMessage(uncertain.current ? 'We could not confirm your last checkout. Tap Refresh billing status, or cancel it below and start again.'
        : status.pending?.legacy ? 'An older payment attempt is still being checked. Contact Cluera support if this does not clear.'
        : status.code === 'PENDING' || binding.current ? exitNotice.current ?? (callbackObserved.current ? 'Payment received. We are confirming it and will add your hours automatically, usually within 2 minutes.' : 'You have an unfinished payment. Continue it, or cancel it to start a new one.')
          : status.code === 'DISABLED' ? 'Purchases are not currently available for this account.'
            : completed.current ? 'Payment verified. Your available time and billing history are up to date.'
              : cancelNotice.current ?? `Review your plan, then continue to secure Razorpay ${mode==='test'?'Test ':''}checkout.`);
    } catch {
      if (current()) { setResumeRevisionId(null);setEligible(false); const notice = !enabledRef.current
        ? 'Cluera payment acceptance is pending. Checkout is disabled; no payment is requested.'
        : 'Could not load your payment status. Tap Refresh billing status to try again.';
        if(checkingResume){preparationFailure.current=notice;resumeProof.current=null;}setMessage(notice); }
    } finally {
      if (read.current === controller) read.current = null;
      if (current()) setBusy(false);
      if (alive.current && trailing.current && !write.current) { trailing.current = false; void refreshStatus(false, true); }
    }
  }, [deny, rejectResponse, endpoint, mode, clearWindow]);

  useEffect(()=>{if(!cooldown)return;const timer=setInterval(()=>setCooldown(Math.max(0,Math.ceil((cooldownUntil.current-Date.now())/1000))),1000);return()=>clearInterval(timer);},[cooldown>0]);

  useEffect(() => {
    alive.current = true;
    setSelection(selectionFromSearch(location.search));
    const query=new URLSearchParams(location.search),hint=query.get('desktopAccount');
    invalidHint.current = query.getAll('desktopAccount').length>1||(hint !== null && !z.uuid().safeParse(hint).success);
    desktopOwner.current = invalidHint.current ? null : hint;
    void refresh();
    const focus = () => { if (overlay.current || Date.now() - lastFocus.current < 5_000) return; lastFocus.current = Date.now(); void refresh(false, true); };
    window.addEventListener('focus', focus); window.addEventListener('online', focus);
    return () => {
      alive.current = false; epoch.current++; trailing.current = false;
      clearWindow();
      read.current?.abort(); read.current = null; write.current?.abort(); write.current = null;
      overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus);
    };
  }, [refresh,clearWindow]);
  useEffect(() => {
    if (!watchPayment || !enabled) return;
    // A signed receipt can finish after the browser callback. Bounded GET-only
    // checks cover that normal delay without a second checkout or worker wake.
    // Four checks in two minutes stay within the existing authentication limit.
    let checks = 0;
    const timer = setInterval(() => {
      checks++;
      if (checks === 4) clearInterval(timer);
      if (document.visibilityState !== 'hidden') void refresh(true, true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [enabled, refresh, watchPayment, observationCycle]);
  useEffect(() => {
    if (!enabled) {
      clearWindow();setPreparing(false);
      setWatchPayment(false);
      setResumeRevisionId(null);
      setEligible(false); write.current?.abort(); overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
      setMessage('Cluera payment acceptance is pending. Checkout is disabled; no payment is requested.');
    }
  }, [enabled,clearWindow]);

  const monthlyBlocked=firstSubscriptionOnly&&(credits?.plans===undefined||credits.plans.some(plan=>['ACTIVE','PAUSED','QUEUED'].includes(plan.state)||plan.paymentState!=='CANCELED'));
  const buy = async (revision: ClueraPublicRevision, resume = false) => {
    if (!enabledRef.current || (resume ? resumeRevisionId !== revision.revisionId : !eligible || uncertain.current)
      || Date.now()<cooldownUntil.current || !credits || write.current || overlay.current || (!resume&&(busy||read.current||binding.current)) || !revision.enabled || !revision.testPlanValidated
      ||(revision.kind==='RECURRING'&&monthlyBlocked)) return;
    // A deliberate continuation supersedes a background read. It still performs
    // fresh account, server binding and provider checks before opening Checkout.
    read.current?.abort();read.current=null;trailing.current=false;epoch.current++;
    overlayAbort.current?.abort();clearWindow();exitNotice.current=null;preparationFailure.current=null;
    const accountId = credits.userId, generation = epoch.current, controller = new AbortController();
    const current = () => alive.current && modeRef.current===mode && enabledRef.current && !controller.signal.aborted
      && epoch.current === generation && owner.current === accountId;
    write.current = controller; cancelNotice.current = null;
    if (!resume) { requestId.current ??= crypto.randomUUID(); uncertain.current = true; }
    setResumeRevisionId(null);
    verifiedCallback.current=null;callbackObserved.current=false;completed.current=false;balanceCurrent.current=false;
    setWatchPayment(true);
    setObservationCycle(value => value + 1);
    setEligible(false); setBusy(true);setPreparing(true);
    let stage:'order'|'sdk'|'session'='order';
    setMessage(resume?'Checking your existing order with Razorpay…':'Creating your secure checkout…');
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
      stage='sdk';setMessage('Loading the Razorpay payment window…');
      await loadSdk(controller.signal); if (!current()) return;
      stage='session';setMessage('Confirming your account and order before opening Razorpay…');
      // HttpOnly account cookies can change in another tab while CREATE or SDK
      // loading is in flight. Refs alone cannot attest the CURRENT browser owner.
      // These GETs revalidate that owner and the exact canonical binding; no
      // provider mutation, callback, credit or replacement order is triggered.
      const signal = controller.signal;
      // Serialize authenticated reads: each may rotate the same browser cookies.
      const accountResponse=await checkoutRequest(`/api/account/credits?desktopAccount=${encodeURIComponent(accountId)}`,
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
      if(!current()||await rejectResponse(accountResponse,current))return;
      const statusResponse=await checkoutRequest(`${endpoint}/checkout?expectedAccountId=${encodeURIComponent(accountId)}`,
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
      if(!current()||await rejectResponse(statusResponse,current))return;
      const resumeResponse=resume?await checkoutRequest(`${endpoint}/resume?expectedAccountId=${encodeURIComponent(accountId)}`,
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }):undefined;
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
      // The official Checkout opens over this page. Preserve the selected plan,
      // desktop account hint and current route when the customer closes it.
      let callbackStarted = false, exitObserved = false;
      const observeExit = (notice: string) => {
        if (!current() || exitObserved) return;
        exitObserved = true;
        clearWindow();overlay.current=null;needsReconcile.current=true;exitNotice.current=notice;
        setObservationCycle(value => value + 1);
        setMessage(notice); void refresh(true);
      };
      const instance = new Constructor({ key: checkout.keyId, name: mode === 'test' ? 'Cluera AI TEST' : 'Cluera AI',
        description: `${revision.name} · ${clueraAllowance(revision.allowanceSeconds)}`,
        ...(checkout.orderId ? { order_id: checkout.orderId, amount: checkout.amountPaise, currency: checkout.currency }
          : { subscription_id: checkout.subscriptionId }),
        retry: { enabled: true, max_count: 3 }, timeout: windowSeconds, theme: { color: '#8b5cf6', backdrop_color: '#080b14' },
        handler: async (raw: unknown) => {
          if (!current() || callbackStarted) return;
          callbackStarted = true;callbackObserved.current=true;
          exitObserved=true;clearWindow();overlay.current=null;exitNotice.current=null;needsReconcile.current=false;
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
          } catch { if (current()) setMessage('Payment received. We are confirming it and will add your hours automatically, usually within 2 minutes.'); }
          if (current()) {
            // Checkout may have remained open longer than the original read
            // window. Observe delayed receipts from this return, not from Buy.
            setObservationCycle(value => value + 1);
            void refresh(true);
          }
        }, modal: { backdropclose: false, escape: true,
          ondismiss: () => observeExit('Payment window closed. If you did not finish paying, you were not charged. Continue the payment or cancel the order below.') },
      });
      // Razorpay keeps its window open with a retry option after a failed attempt.
      instance.on('payment.failed', () => {
        if (!current() || exitObserved) return;
        setMessage('That payment did not go through and you were not charged. Try again in the Razorpay window, or close it and cancel the order.');
      });
      if (!current()) { instance.close(); return; }
      overlay.current = instance; instance.open();
      if(exitObserved||!current())return;
      windowDeadline.current=Date.now()+windowSeconds*1000;setRemaining(windowSeconds);
      windowTimer.current=setInterval(()=>{
        const seconds=Math.max(0,Math.ceil(((windowDeadline.current??Date.now())-Date.now())/1000));setRemaining(seconds);
        if(seconds===0&&current()){
          observeExit('The payment window timed out. If you did not finish paying, you were not charged. Continue the payment or cancel the order below.');
          instance.close();
        }
      },1000);
      setMessage(mode==='test'?'Razorpay Test checkout is open. Use Test details only. Your balance updates after payment verification.'
        :'Razorpay checkout is open. Your balance updates after payment verification.');
    } catch { if (current()) {
      const notice=stage==='sdk'
        ? 'The Razorpay window could not load. Check your connection or ad blocker, then tap Continue payment.'
        : resume ? 'We could not reopen this order. Tap Refresh billing status, or cancel it and start a new one.'
          : 'We could not start checkout. Tap Refresh billing status, or cancel the unfinished order and try again.';
      preparationFailure.current=notice;needsReconcile.current=false;setResumeRevisionId(null);setMessage(notice);
    } }
    finally {
      if (write.current === controller) write.current = null;
      if (alive.current && epoch.current === generation) {setBusy(false);setPreparing(false);}
      if (alive.current && trailing.current) { trailing.current = false; void refresh(false, true); }
    }
  };

  const cancelOrder = async () => {
    if (!credits || cancelling || write.current || overlay.current || mode !== 'live') return;
    const accountId = credits.userId;
    read.current?.abort(); read.current = null; trailing.current = false;
    setCancelling(true); setBusy(true); setMessage('Cancelling your unfinished order…');
    try {
      const response = await checkoutRequest(`${endpoint}/abandon`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedAccountId: accountId }) });
      if (!alive.current) return;
      if (await rejectResponse(response, () => alive.current)) return;
      const result = z.object({ result: z.object({ code: z.enum(['CANCELLED','PAYMENT_IN_PROGRESS','TOO_SOON','ALREADY_RESOLVED','NOTHING_PENDING']) }) })
        .parse(await response.json()).result.code;
      if (result === 'CANCELLED' || result === 'NOTHING_PENDING' || result === 'ALREADY_RESOLVED') {
        clearWindow(); overlayAbort.current?.abort();
        binding.current = null; requestId.current = null; uncertain.current = false; callbackObserved.current = false;
        preparationFailure.current = null; resumeProof.current = null; needsReconcile.current = false;
        setResumeRevisionId(null); setCancellable(false);
      }
      exitNotice.current = null;
      const notice = result === 'CANCELLED' ? 'Order cancelled. You were not charged. You can choose a plan and buy again.'
        : result === 'PAYMENT_IN_PROGRESS' ? 'A payment for this order is already being processed, so it cannot be cancelled. Your hours will be added automatically once it is confirmed, usually within 2 minutes.'
        : result === 'TOO_SOON' ? 'This checkout was started a moment ago. Please wait a few minutes, then try cancelling again.'
        : 'This order is already finished. Your balance is up to date.';
      if (result === 'PAYMENT_IN_PROGRESS' || result === 'TOO_SOON') exitNotice.current = notice; else cancelNotice.current = notice;
      setMessage(notice);
    } catch { if (alive.current) setMessage('Could not cancel the order right now. Please try again in a moment.'); }
    finally {
      if (alive.current) { setCancelling(false); setBusy(false); setHistoryVersion(value => value + 1); void refresh(false, true); }
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
  return <section className={`account-checkout-console ${styles.checkout} ${pricing?styles.pricingSection:''}`} aria-label="Cluera billing" aria-busy={preparing}>
    <header className={styles.checkoutHeader}>
      <p className={styles.eyebrow}>Cluera billing · Razorpay{mode==='test'?' Test':''}</p>
      <h2>{pricing?'Your next great conversation starts here.':'Time for your next session'}</h2>
      <p>Pick the time you need. Pay securely and your hours are added to your account automatically.</p>
    </header>
    <ol className={styles.steps} aria-label="Purchase steps"><li>01 <span>Choose your time</span></li><li>02 <span>Secure checkout</span></li><li>03 <span>Balance updated</span></li></ol>
    <div className={styles.status} id={statusId} role="status" aria-live="polite"><p>{message}</p></div>
    {busy&&(preparing||!quietRead)?<div className={styles.progress} role="progressbar" aria-label={preparing?'Preparing your secure checkout…':'Refreshing payment status…'}><span/></div>:null}
    {cooldown>0?<p role="status" className={styles.availability}>Please wait {cooldown}s before another billing check. Your order and balance are preserved.</p>:null}
    {remaining!==null?<p className={styles.windowNotice}>Payment window: <strong>{Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</strong> remaining.</p>:null}
    {firstSubscriptionOnly&&(catalog.some(row=>row.kind==='RECURRING')||!catalogLoaded)?<details className={styles.purchasePolicy}><summary>Monthly plans and changes</summary><p>One monthly subscription at a time. Change plans after cancellation is confirmed and your paid term ends. Automatic upgrades are unavailable.</p>
      {monthlyBlocked&&credits?<p>Your current subscription must be resolved before another monthly checkout. One-time packs remain separate.</p>:null}</details>:null}
    {selection?<aside className="cluera-plan-handoff" aria-label="Selected Cluera plan"><p>Selected plan: <strong>{checkoutSelectionName(selection)}</strong></p>
      <p>Review the price and terms. Nothing is charged until you complete payment.</p></aside>:null}
    <div className={styles.accountSummary}>
      {credits ? <dl><div><dt>Signed in as</dt><dd>{credits.displayName?.trim() || 'verified customer'}</dd></div><div className={styles.balance}><dt>Available time</dt><dd>{usageDuration(credits.availableMilliseconds)}</dd><p>Shared across your devices</p></div></dl>
        : <a className={styles.signIn} href={selection?checkoutSelectionHref(selection,true):'/account#login'}>Sign in to Cluera AI</a>}
      <button className={styles.refresh} type="button" disabled={busy||cooldown>0} onClick={() => {needsReconcile.current=true;void refresh();}}>Refresh billing status</button>
      {enabled && (resumeRevisionId || cancellable) && remaining===null ? <div className={styles.resumePanel}><div><strong>You have an unfinished payment</strong>
        <p>{resumeRevisionId?'Continue it to finish paying, or cancel it to start over.':'Cancel it to start a new purchase. You will not be charged.'}</p></div>
        {resumeRevisionId?<button className={styles.resume} type="button" disabled={preparing||cancelling||cooldown>0} onClick={() => {
          const revision = catalog.find(row => row.revisionId === resumeRevisionId); if (revision) void buy(revision, true);
        }}>Continue payment</button>:null}
        {cancellable?<button className={styles.refresh} type="button" disabled={preparing||cancelling||cooldown>0} onClick={() => void cancelOrder()}>{cancelling?'Cancelling…':'Cancel order'}</button>:null}
      </div> : null}
    </div>
    <div className={`account-pricing-grid ${styles.grid}`}>{rows ? rows.map(revision => {
      const canPurchase = enabled && eligible && !busy && !cooldown && revision.enabled && revision.testPlanValidated&&!(revision.kind==='RECURRING'&&monthlyBlocked);
      const canSignIn = enabled && signedOut && !credits && !busy && revision.enabled && revision.testPlanValidated;
      const savedOrder = enabled && resumeRevisionId === revision.revisionId && revision.enabled && revision.testPlanValidated;
      const canContinue = savedOrder && !preparing && !cooldown && remaining === null;
      const action = savedOrder ? 'Continue payment' : revision.kind === 'PACK' ? 'Buy Now' : 'Subscribe';
      const availabilityId = `${statusId}-${revision.revisionId}`;
      const availability = !revision.enabled || !revision.testPlanValidated
        ? revision.kind === 'RECURRING' ? 'Subscriptions for this plan are not open yet.' : 'Purchases for this plan are not open yet.'
        : !enabled ? 'Payments are currently paused.'
        : cooldown > 0 ? `Please wait ${cooldown}s before continuing.`
        : remaining !== null ? 'Your Razorpay payment window is open.'
        : preparing ? 'Preparing secure payment…'
        : savedOrder ? 'Finish your unfinished payment for this plan.'
        : busy && !quietRead ? 'Checking payment availability…'
        : revision.kind === 'RECURRING' && monthlyBlocked && credits ? 'Another subscription cannot start until your current plan is resolved.'
        : canPurchase || canSignIn ? 'Pay securely in the Razorpay popup.'
        : cancellable ? 'Finish or cancel your unfinished payment above to buy this plan.'
        : 'See the payment status above before continuing.';
      return <article key={revision.revisionId} aria-label={revision.name} className={`account-plan-card ${styles.card}${selection?.offerCode===revision.offerCode?' cluera-plan-selected':''}`}>
        {selection?.offerCode===revision.offerCode?<p className="cluera-selection-badge">Selected plan</p>:null}
        <div className={styles.cardTop}><p className={styles.eyebrow}>{revision.kind === 'PACK' ? 'One-time pack' : 'Monthly subscription'}</p><span className={styles.badge}>{revision.kind==='PACK'?'Flexible top-up':revision.allowanceSeconds===360000?'For regular sessions':'Monthly allowance'}</span></div>
        <h3>{revision.name}</h3>
        <p className={styles.price}>{clueraPrice(revision.amountPaise)}<span>{revision.kind === 'RECURRING' ? ' / month' : ' one time'}</span></p>
        <p className={styles.allowance}>{clueraAllowance(revision.allowanceSeconds)}{revision.kind === 'RECURRING' ? ' per month' : ''}</p>
        <ul className={styles.features}>
          <li><span aria-hidden="true">✓</span>{revision.kind === 'PACK' ? 'No expiry; packs stack' : 'Monthly hours do not roll over'}</li>
          <li><span aria-hidden="true">✓</span>One shared account balance</li>
          <li><span aria-hidden="true">✓</span>{revision.kind === 'PACK' ? 'One-time purchase' : `No rollover; up to ${revision.totalCount} monthly charges`}</li>
        </ul>
        <p className={styles.revision}>{revision.kind==='PACK'?'One payment. No automatic renewal.':'Renews monthly. Cancel future renewal while keeping your paid term. Unused monthly hours expire.'}</p>
        <p className={styles.availability} id={availabilityId}>{availability}</p>
        {canSignIn?<a className={styles.action} href={checkoutSelectionHref({offerCode:revision.offerCode,desktopAccount:desktopOwner.current},true)}
          aria-label={`Sign in to ${revision.kind==='PACK'?'buy':'subscribe'}: ${revision.name}`}>Sign in to {revision.kind==='PACK'?'buy':'subscribe'}</a>
          :<button className={styles.action} data-offer-code={revision.offerCode} data-checkout-action={savedOrder?'resume':'purchase'} type="button" disabled={!canPurchase&&!canContinue} aria-label={`${action}: ${revision.name}`} aria-describedby={`${statusId} ${availabilityId}`}
          onClick={() => void buy(revision, savedOrder)}>{action}</button>}
      </article>;
    }) : catalogLoaded ? <p className={styles.availability} role="status">No plans are on sale right now. Please check back soon. Your existing time and billing history are unchanged.</p> : clueraTargetPlans.map(plan => {
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
        <p className={styles.availability}>This plan is not open for purchase yet.</p>
        <button className={styles.action} data-offer-code={plan.offerCode} data-checkout-action="purchase" type="button" disabled aria-label={`${plan.interval?'Subscribe':'Buy Now'}: ${plan.name}`} aria-describedby={statusId}>{plan.interval?'Subscribe':'Buy Now'}</button>
      </article>;
    })}</div>
    <div className={styles.safetyNote}><p>Pay with UPI, card, netbanking or wallet in the secure Razorpay window. Your hours are added automatically after payment, usually within 2 minutes. If you close the window without paying, you are not charged: continue the payment or cancel it. Need help? <a href="mailto:clueraaisupport@gmail.com">Contact support</a>.</p></div>
    {/* On the pricing page the history stays mounted (it confirms a finished payment) but is not shown. */}
    <div hidden={pricing}><ClueraBillingHistory key={mode} mode={mode} accountId={credits?.userId??null} enabled={historyEnabled} disabled={busy} cancellationEnabled={cancellationEnabled} autoLoad refreshKey={historyVersion} onLoaded={historyLoaded}/></div>
  </section>;
}
