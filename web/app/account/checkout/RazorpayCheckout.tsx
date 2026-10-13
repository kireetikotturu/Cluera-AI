'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { usageDuration } from '../../../lib/usage/display';

const states = z.enum(['CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED']);
const historySchema = z.array(z.object({ offerCode: z.string(), state: states, createdAt: z.iso.datetime({ offset: true }) })).max(10);
const creditsSchema = z.object({ userId: z.uuid(), displayName: z.string().max(80).optional(),
  availableMilliseconds: z.number().int().nonnegative(), checkoutAvailable: z.boolean(), payments: historySchema });
const statusSchema = z.object({ payment: z.object({ code: z.enum(['AVAILABLE','PENDING']), userId: z.uuid(),
  pending: z.object({ id: z.uuid(), state: z.enum(['CREATING','BOUND','UNCERTAIN']), offerCode: z.literal('pro_3_hours'),
    orderId: z.string().regex(/^order_[A-Za-z0-9]{8,64}$/).nullable() }).nullable(), history: historySchema,
    resolvedOrderIds: z.array(z.string().regex(/^order_[A-Za-z0-9]{8,64}$/)).max(50) }) });
const boundSchema = z.object({ payment: z.object({ code: z.literal('BOUND'), orderId: z.string().regex(/^order_[A-Za-z0-9]{8,64}$/),
  keyId: z.string().regex(/^rzp_test_[A-Za-z0-9]{8,64}$/), amount: z.literal(54900), currency: z.literal('INR'), offerCode: z.literal('pro_3_hours') }).strict() });
type CheckoutInstance = { open(): void; close(): void; on(event: string, callback: () => void): void };
declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => CheckoutInstance } }

async function loadRazorpay(signal: AbortSignal): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.async = true;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', fail); script.onload = null; script.onerror = null; };
    const fail = () => { cleanup(); script.remove(); reject(new Error('Checkout unavailable.')); };
    const timer = setTimeout(fail, 10000);
    script.onload = () => { cleanup(); window.Razorpay ? resolve() : fail(); }; script.onerror = fail;
    signal.addEventListener('abort', fail, { once: true }); if (signal.aborted) { fail(); return; }
    document.head.append(script);
  });
}
/** Isolated Account-only first provider. No SDK/order/POST on mount or refresh. */
export default function RazorpayCheckout({ enabled, offers }: { enabled: boolean; offers: { code: string; name: string; label: string; terms?: string }[] }) {
  const [credits, setCredits] = useState<z.infer<typeof creditsSchema> | null>(null);
  const [eligible, setEligible] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Checking your verified account…');
  const alive = useRef(false), owner = useRef<string | null>(null), desktopOwner = useRef<string | null>(null);
  const read = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const uncertain = useRef(false), knownOrder = useRef<string | null>(null), operationId = useRef<string | null>(null);
  const instance = useRef<CheckoutInstance | null>(null), checkoutAbort = useRef<AbortController | null>(null);
  const epoch = useRef(0), queued = useRef(false), lastFocus = useRef(0);
  const refresh = useCallback(async function refreshStatus(trailing = false) {
    if (read.current) { if (trailing) queued.current = true; return; }
    const controller = new AbortController(); read.current = controller; setBusy(true); const generation = epoch.current;
    try {
      const hint = desktopOwner.current ?? owner.current;
      const response = await fetch(`/api/account/credits${hint ? `?desktopAccount=${encodeURIComponent(hint)}` : ''}`, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (response.status === 401 || response.status === 403) {
        if (!controller.signal.aborted && alive.current) { epoch.current++; owner.current = null; write.current?.abort(); checkoutAbort.current?.abort(); instance.current?.close();
          instance.current = null; knownOrder.current = null; operationId.current = null; uncertain.current = false; setCredits(null); }
        throw new Error('Session denied.');
      }
      if (!response.ok) throw new Error('Unavailable.');
      const account = creditsSchema.parse(await response.json());
      if ((hint && account.userId !== hint) || controller.signal.aborted || !alive.current || generation !== epoch.current) throw new Error('Owner changed.');
      owner.current = account.userId; setCredits(account);
      if (!enabled) { setEligible(false); setMessage('Razorpay Test Mode awaits private owner setup. No checkout is enabled.'); return; }
      const statusResponse = await fetch(`/api/account/payments/checkout?expectedAccountId=${encodeURIComponent(account.userId)}`, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (statusResponse.status === 401 || statusResponse.status === 403) {
        if (!controller.signal.aborted && alive.current) { epoch.current++; owner.current = null; write.current?.abort(); checkoutAbort.current?.abort(); instance.current?.close();
          instance.current = null; knownOrder.current = null; operationId.current = null; uncertain.current = false; setCredits(null); }
        throw new Error('Session denied.');
      }
      if (!statusResponse.ok) throw new Error('Unavailable.');
      const status = statusSchema.parse(await statusResponse.json()).payment;
      if (status.userId !== account.userId || (status.code === 'AVAILABLE') !== (status.pending === null)
        || controller.signal.aborted || !alive.current || generation !== epoch.current || owner.current !== account.userId) throw new Error('Owner changed.');
      // A truly unknown CREATE outcome never unlocks from an eligible snapshot.
      // A known order is retired ONLY after its own VERIFIED/REFUNDED history
      // is observed through the server's exact pending read; no browser authority.
      if (knownOrder.current && status.code === 'AVAILABLE' && status.resolvedOrderIds.includes(knownOrder.current) && !uncertain.current) {
        checkoutAbort.current?.abort(); instance.current?.close(); instance.current = null; knownOrder.current = null; operationId.current = null; }
      setEligible(status.code === 'AVAILABLE' && !knownOrder.current && !uncertain.current && !write.current);
      setMessage(uncertain.current ? 'Checkout needs operator verification. Do not retry.' : status.code === 'PENDING'
        ? 'A Razorpay attempt is awaiting authoritative verification. Do not start another.' : 'Your verified account can purchase the one-time pack.');
    } catch { if (!controller.signal.aborted && alive.current) { setEligible(false); setMessage('Account/payment status is unavailable or denied. Refresh status only; do not retry a payment.'); } }
    finally { if (read.current === controller) read.current = null; if (alive.current) setBusy(false);
      if (queued.current && alive.current) { queued.current = false; void refreshStatus(); } }
  }, [enabled]);
  useEffect(() => {
    alive.current = true; desktopOwner.current = new URLSearchParams(location.search).get('desktopAccount');
    void refresh();
    const onFocus = () => { if (Date.now() - lastFocus.current < 5000) return; lastFocus.current = Date.now(); void refresh(); };
    window.addEventListener('focus', onFocus); window.addEventListener('online', onFocus);
    return () => { alive.current = false; epoch.current++; read.current?.abort(); write.current?.abort(); checkoutAbort.current?.abort(); instance.current?.close();
      window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); };
  }, [refresh]);
  const buy = async () => {
    if (!enabled || !eligible || busy || !credits || write.current || uncertain.current || knownOrder.current) return;
    const userId = credits.userId, generation = epoch.current, controller = new AbortController(); write.current = controller;
    operationId.current ??= crypto.randomUUID(); uncertain.current = true; setEligible(false); setBusy(true);
    const current = () => alive.current && !controller.signal.aborted && epoch.current === generation && owner.current === userId;
    try {
      const response = await fetch('/api/account/payments/checkout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CREATE', provider: 'razorpay', offerCode: 'pro_3_hours', expectedAccountId: userId, requestId: operationId.current }) });
      if (!response.ok) throw new Error('Unknown order outcome.');
      const order = boundSchema.parse(await response.json()).payment;
      if (!current()) return; knownOrder.current = order.orderId; uncertain.current = false; checkoutAbort.current = controller;
      await loadRazorpay(controller.signal); if (!current() || !window.Razorpay) return;
      // Strip all external provider inputs only after pinning the desktop owner.
      history.replaceState(null, '', '/account/checkout');
      const checkout = new window.Razorpay({ key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency,
        name: 'Cluera AI TEST', description: 'SigmaPro 3 Hours · 10,800 non-expiring seconds', retry: { enabled: false },
        handler: async (raw: unknown) => {
          if (!current()) return;
          try {
            const callback = z.object({ razorpay_order_id: z.literal(order.orderId), razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/),
              razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw);
            const verified = await fetch('/api/account/payments/checkout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'VERIFY_CALLBACK', expectedAccountId: userId, orderId: order.orderId,
                paymentId: callback.razorpay_payment_id, signature: callback.razorpay_signature }) });
            if (!verified.ok) throw new Error();
            if (current()) setMessage('Callback verified; awaiting signed webhook and captured-payment verification. No browser credit grant.');
          } catch { if (current()) setMessage('Payment outcome requires verification. Do not retry.'); }
          if (current()) void refresh(true);
        }, modal: { ondismiss: () => { if (current()) void refresh(true); } } });
      checkout.on('payment.failed', () => { if (current()) { setMessage('Payment failed or is uncertain. Do not retry.'); void refresh(true); } });
      if (!current()) { checkout.close(); return; } instance.current = checkout; checkout.open(); setMessage('Complete only this Razorpay Test Mode checkout.');
    } catch { if (current()) setMessage('Checkout outcome requires verification. Do not retry or select another provider.'); }
    finally { if (write.current === controller) write.current = null; if (alive.current) setBusy(false); }
  };
  return <section aria-label="Account payment gateways">
    <fieldset disabled={busy}><legend>Payment gateway</legend><label><input type="radio" name="gateway" checked readOnly /> Razorpay Test Mode</label>
      <label><input type="radio" name="gateway" disabled /> Stripe — not available</label></fieldset>
    <p role="status" aria-live="polite">{message}</p>
    {credits ? <><p>Signed in as {credits.displayName?.trim() || 'verified customer'} · Available time: {usageDuration(credits.availableMilliseconds)}</p>
      <p>Your session supplies account identity; no account ID entry or administrator approval.</p></> : <a href="/account">Sign in to your Account</a>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh server status</button>
    <div className="account-pricing-grid">{offers.map(offer => <article key={offer.code} className="account-plan-card">
      <h2>{offer.name}</h2><p>{offer.label}</p>{offer.terms ? <p>{offer.terms}</p> : null}
      {offer.code === 'pro_3_hours' ? <button type="button" disabled={!eligible || busy || !enabled} onClick={() => void buy()}>Pay ₹549 in Razorpay Test Mode</button>
        : <p>Recurring integration pending mandate and lifecycle acceptance — not available.</p>}
    </article>)}</div>
    <h2>Server-confirmed payment history</h2>
    <p>Paddle records are preserved for verification. Paddle checkout and its existing draft are not opened or canceled here.</p>
    {credits?.payments.map((payment, index) => <p key={`${payment.createdAt}:${index}`}>{payment.offerCode} · {payment.state} · <time dateTime={payment.createdAt}>{payment.createdAt}</time></p>)}
  </section>;
}
