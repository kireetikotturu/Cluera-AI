'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { usageDuration } from '../../../lib/usage/display';
import { clueraTargetPlans } from '../../../lib/cluera/targetPlans';
import { clueraBoundCheckout, clueraCatalogResponse, clueraCheckoutStatus,
  clueraAllowance, clueraPrice, type ClueraPublicRevision, type ClueraBoundCheckout,
} from '../../../lib/payments/cluera/publicCatalog';

const endpoint = '/api/account/payments/cluera';
const creditsSchema = z.object({ userId: z.uuid(), displayName: z.string().max(80).optional(),
  availableMilliseconds: z.number().int().nonnegative(), payments: z.array(z.object({
    offerCode: z.string().max(80), state: z.enum(['CREATING', 'BOUND', 'UNCERTAIN', 'REJECTED', 'VERIFIED', 'REFUNDED']),
    createdAt: z.iso.datetime({ offset: true }),
  })).max(10),
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
export default function ClueraCheckoutClient({ enabled, offers = [] }: {
  enabled: boolean; offers?: ClueraPublicRevision[];
}) {
  const [catalog, setCatalog] = useState<ClueraPublicRevision[]>(offers);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [busy, setBusy] = useState(false), [eligible, setEligible] = useState(false);
  const [message, setMessage] = useState('Checking your verified Cluera account…');
  const alive = useRef(false), epoch = useRef(0), owner = useRef<string | null>(null);
  const desktopOwner = useRef<string | null>(null), invalidHint = useRef(false), enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const overlayAbort = useRef<AbortController | null>(null), overlay = useRef<CheckoutInstance | null>(null);
  const uncertain = useRef(false), requestId = useRef<string | null>(null), binding = useRef<ClueraBoundCheckout | null>(null);
  const trailing = useRef(false), lastFocus = useRef(0);

  const deny = useCallback(() => {
    epoch.current++; owner.current = null;
    write.current?.abort(); overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
    binding.current = null; requestId.current = null; uncertain.current = false;
    if (alive.current) { setCredits(null); setEligible(false); setBusy(false); setMessage('Sign in with the matching verified Cluera account to continue.'); }
  }, []);

  const refresh = useCallback(async function refreshStatus(queue = false) {
    if (read.current || write.current) { if (queue) trailing.current = true; return; }
    if (invalidHint.current) { deny(); return; }
    const controller = new AbortController(), generation = epoch.current;
    const current = () => alive.current && !controller.signal.aborted && epoch.current === generation;
    read.current = controller; setBusy(true); setEligible(false);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    try {
      const hint = desktopOwner.current ?? owner.current;
      const [accountResponse, catalogResponse] = await Promise.all([
        fetch(`/api/account/credits${hint ? `?desktopAccount=${encodeURIComponent(hint)}` : ''}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
        fetch(`${endpoint}/catalog`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
      ]);
      if (!current()) return;
      if (accountResponse.status === 401 || accountResponse.status === 403) { deny(); return; }
      if (!accountResponse.ok) throw new Error();
      const account = creditsSchema.parse(await accountResponse.json());
      if (!current()) return;
      if (hint && account.userId !== hint) { deny(); return; }
      owner.current = account.userId; setCredits(account);
      if (!catalogResponse.ok) { setCatalog([]); throw new Error(); }
      const freshCatalog = clueraCatalogResponse.parse(await catalogResponse.json()).catalog;
      if (!current()) return; setCatalog(freshCatalog);
      if (!enabledRef.current) {
        setMessage('Cluera billing migration is awaiting approval. Checkout is disabled; no payment is requested.'); return;
      }
      const response = await fetch(`${endpoint}/checkout?expectedAccountId=${encodeURIComponent(account.userId)}`,
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { deny(); return; }
      if (!response.ok) throw new Error();
      const status = clueraCheckoutStatus.parse(await response.json()).payment;
      if (!current()) return;
      if (status.userId !== account.userId || owner.current !== account.userId) { deny(); return; }
      const known = binding.current;
      // Only a fresh exact server-confirmed resolution can retire a known binding.
      // An unknown CREATE outcome cannot be cleared by an AVAILABLE snapshot.
      if (known && status.code === 'AVAILABLE' && !uncertain.current
        && (known.orderId ? status.resolvedOrderIds.includes(known.orderId)
          : Boolean(known.subscriptionId && status.resolvedSubscriptionIds.includes(known.subscriptionId)))) {
        overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
        binding.current = null; requestId.current = null;
      }
      const canBuy = status.code === 'AVAILABLE' && !status.pending && !uncertain.current && !binding.current;
      setEligible(canBuy);
      setMessage(uncertain.current ? 'A checkout outcome is unknown. Keep this attempt for verification; do not retry.'
        : status.pending?.legacy ? 'An existing Account-era Razorpay attempt still requires verification. It is preserved, not resumed or recreated here. New checkout stays locked.'
        : status.code === 'PENDING' || binding.current ? 'Your payment or mandate is awaiting authoritative verification. Do not create another attempt.'
          : status.code === 'DISABLED' ? 'This account is not enabled for the separately approved Razorpay Test acceptance.'
            : 'Your verified account may begin one explicitly approved Razorpay Test checkout.');
    } catch {
      if (current()) { setEligible(false); setMessage(!enabledRef.current
        ? 'Cluera billing migration is awaiting approval. Checkout is disabled; no payment is requested.'
        : 'Account or payment verification is unavailable. Refresh status only; do not retry a payment.'); }
    } finally {
      if (read.current === controller) read.current = null;
      if (current()) setBusy(false);
      if (alive.current && trailing.current && !write.current) { trailing.current = false; void refreshStatus(); }
    }
  }, [deny]);

  useEffect(() => {
    alive.current = true;
    const hint = new URLSearchParams(location.search).get('desktopAccount');
    invalidHint.current = hint !== null && !z.uuid().safeParse(hint).success;
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
    if (!enabled) {
      setEligible(false); write.current?.abort(); overlayAbort.current?.abort(); overlay.current?.close(); overlay.current = null;
      setMessage('Cluera billing migration is awaiting approval. Checkout is disabled; no payment is requested.');
    }
  }, [enabled]);

  const buy = async (revision: ClueraPublicRevision) => {
    if (!enabledRef.current || !eligible || busy || !credits || read.current || write.current
      || uncertain.current || binding.current || !revision.enabled || !revision.testPlanValidated) return;
    const accountId = credits.userId, generation = epoch.current, controller = new AbortController();
    const current = () => alive.current && enabledRef.current && !controller.signal.aborted
      && epoch.current === generation && owner.current === accountId;
    write.current = controller; requestId.current ??= crypto.randomUUID(); uncertain.current = true;
    setEligible(false); setBusy(true);
    try {
      const response = await fetch(`${endpoint}/checkout`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedAccountId: accountId, requestId: requestId.current, revisionId: revision.revisionId }) });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { deny(); return; }
      if (!response.ok) throw new Error();
      const checkout = clueraBoundCheckout.parse(await response.json()).payment;
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
      const [accountResponse, statusResponse] = await Promise.all([
        fetch(`/api/account/credits?desktopAccount=${encodeURIComponent(accountId)}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
        fetch(`${endpoint}/checkout?expectedAccountId=${encodeURIComponent(accountId)}`,
          { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }),
      ]);
      if (!current()) return;
      if ([accountResponse.status, statusResponse.status].some(status => status === 401 || status === 403)) { deny(); return; }
      if (!accountResponse.ok || !statusResponse.ok) throw new Error();
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
      setCredits(verifiedAccount);
      const Constructor = razorpay(); if (!Constructor) throw new Error();
      history.replaceState(null, '', '/account/checkout');
      const instance = new Constructor({ key: checkout.keyId, name: 'Cluera AI TEST',
        description: `${revision.name} · ${clueraAllowance(revision.allowanceSeconds)}`,
        ...(checkout.orderId ? { order_id: checkout.orderId, amount: checkout.amountPaise, currency: checkout.currency }
          : { subscription_id: checkout.subscriptionId }),
        retry: { enabled: false }, theme: { color: '#8b5cf6' },
        handler: async (raw: unknown) => {
          if (!current()) return;
          try {
            const common = { razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/), razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/) };
            const callback = checkout.orderId
              ? z.object({ ...common, razorpay_order_id: z.literal(checkout.orderId) }).strict().parse(raw)
              : z.object({ ...common, razorpay_subscription_id: z.literal(checkout.subscriptionId!) }).strict().parse(raw);
            const result = await fetch(`${endpoint}/callback`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expectedAccountId: accountId, orderId: checkout.orderId, subscriptionId: checkout.subscriptionId,
                paymentId: callback.razorpay_payment_id, signature: callback.razorpay_signature }) });
            if (!current()) return;
            if (result.status === 401 || result.status === 403) { deny(); return; }
            if (!result.ok) throw new Error();
            z.object({ payment: z.object({ code: z.literal('AWAITING_WEBHOOK') }).strict() }).strict().parse(await result.json());
            if (current()) setMessage('Callback checked. Credits require a genuine signed webhook and independent captured-payment evidence; mandate approval alone grants nothing.');
          } catch { if (current()) setMessage('The payment outcome needs verification. Do not retry or start another order.'); }
          if (current()) void refresh(true);
        }, modal: { ondismiss: () => { if (current()) void refresh(true); } },
      });
      instance.on('payment.failed', () => {
        if (current()) { setMessage('Payment failed or is incomplete. Do not retry.'); void refresh(true); }
      });
      if (!current()) { instance.close(); return; }
      overlay.current = instance; instance.open();
      setMessage('Use only Razorpay Test details for this approved attempt. A success screen never grants credits.');
    } catch { if (current()) setMessage('Checkout is incomplete or unknown. Keep this attempt for verification; do not retry.'); }
    finally {
      if (write.current === controller) write.current = null;
      if (alive.current && epoch.current === generation) setBusy(false);
      if (alive.current && trailing.current) { trailing.current = false; void refresh(); }
    }
  };

  const rows = catalog.length ? catalog : null;
  return <section className="account-checkout-console" aria-label="Cluera billing" aria-busy={busy}>
    <p className="account-ui-kicker">CLUERA BILLING · RAZORPAY TEST</p>
    <h2>Time for your next session</h2>
    <p>Server-owned account, price revision and payment evidence. No customer account-ID entry.</p>
    <p role="status" aria-live="polite">{message}</p>
    {credits ? <p>Signed in as {credits.displayName?.trim() || 'verified customer'} · Available time: {usageDuration(credits.availableMilliseconds)}</p>
      : <a href="/account">Sign in to Cluera AI</a>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh billing status</button>
    <div className="account-pricing-grid">{rows ? rows.map(revision => <article key={revision.revisionId} className="account-plan-card">
      <p className="account-ui-kicker">{revision.kind === 'PACK' ? 'ONE-TIME PACK' : 'MONTHLY SUBSCRIPTION'}</p>
      <h3>{revision.name}</h3><p>{clueraPrice(revision.amountPaise)}{revision.kind === 'RECURRING' ? ' / month' : ''}</p>
      <p>{clueraAllowance(revision.allowanceSeconds)} · {revision.kind === 'PACK' ? 'no expiry; packs stack' : `no rollover; up to ${revision.totalCount} monthly charges`}</p>
      <p>Revision {revision.version} · {revision.enabled ? 'Catalog enabled' : 'Catalog disabled'}</p>
      {revision.kind === 'RECURRING' && !revision.testPlanValidated ? <p>Test plan and lifecycle acceptance pending. Not available.</p> : null}
      <button type="button" disabled={!enabled || !eligible || busy || !revision.enabled || !revision.testPlanValidated}
        onClick={() => void buy(revision)}>{revision.kind === 'PACK' ? `Pay ${clueraPrice(revision.amountPaise)} in Test Mode` : `Subscribe for ${clueraPrice(revision.amountPaise)} in Test Mode`}</button>
    </article>) : clueraTargetPlans.map(plan => <article key={plan.id} className="account-plan-card">
      <p className="account-ui-kicker">PRESENTATION ONLY · NOT YET PURCHASABLE</p>
      <h3>{plan.name}</h3><p>{clueraPrice(Number(plan.amount))}{plan.interval ? ' / month' : ''}</p>
      <p>{clueraAllowance(plan.seconds)} · {plan.interval ? 'no rollover' : 'no expiry; packs stack'}</p>
      <button type="button" disabled>Checkout awaiting migration approval</button>
    </article>)}</div>
    <p>Recurring Test setup is not production acceptance. Payment-method availability must be verified; no ₹19,549 UPI mandate is promised. Stripe and customer BYOK are unavailable.</p>
    <h3>Preserved server-confirmed history</h3>
    <p>Existing Account and Paddle financial history remains intact. Old drafts are not resumed, canceled or retried here.</p>
    {credits?.payments.length ? <ul>{credits.payments.map((payment, index) => <li key={`${payment.createdAt}:${index}`}>
      {payment.offerCode} · {payment.state} · <time dateTime={payment.createdAt}>{payment.createdAt}</time>
    </li>)}</ul> : <p>No historical entries are displayed in this snapshot.</p>}
  </section>;
}
