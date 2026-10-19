'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { cancellationResource, cancellationResult, type CancellationCommand } from '../../../lib/payments/cluera/cancellationContracts';

const endpoint = '/api/account/payments/cluera/cancellation';
/** Only explicit customer confirmation creates a command. Once sent, every
 * subsequent action verifies the same operation using GET; no mutation retry. */
export default function SubscriptionCancellation({ accountId, subscriptionId, enabled = false, disabled = false }: {
  accountId: string; subscriptionId: string; enabled?: boolean; disabled?: boolean;
}) {
  const statusId = useId(), generation = useRef(0), pending = useRef<AbortController | null>(null);
  const identity = useRef({ accountId, subscriptionId, enabled, disabled });
  identity.current = { accountId, subscriptionId, enabled, disabled };
  const operation = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CancellationCommand | null>(null), [message, setMessage] = useState('');
  const valid = z.uuid().safeParse(accountId).success && cancellationResource.safeParse(subscriptionId).success;
  useEffect(() => {
    generation.current++; pending.current?.abort(); pending.current = null; operation.current = null;
    setConfirming(false); setBusy(false); setResult(null); setMessage('');
    return () => { generation.current++; pending.current?.abort(); pending.current = null; };
  }, [accountId, subscriptionId, enabled]);

  async function submit(check: boolean) {
    if (!valid || !enabled || disabled || pending.current || (!check && operation.current)) return;
    if (check && !operation.current) return;
    const owner = accountId, resource = subscriptionId, epoch = generation.current, controller = new AbortController();
    operation.current ??= crypto.randomUUID(); const id = operation.current;
    pending.current = controller; setBusy(true); setConfirming(false);
    const current = () => generation.current === epoch && !controller.signal.aborted && identity.current.accountId === owner
      && identity.current.subscriptionId === resource && identity.current.enabled && !identity.current.disabled;
    try {
      const response = await fetch(check ? `${endpoint}?expectedAccountId=${encodeURIComponent(owner)}&operationId=${encodeURIComponent(id)}` : endpoint,
        { method: check ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          ...(check ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedAccountId: owner, operationId: id, subscriptionId: resource }) }) });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { setMessage('Sign in with the matching verified Cluera account to check this request.'); return; }
      if (response.status === 429) { setMessage('Too many subscription requests. Wait before checking the original request.'); return; }
      if (!response.ok) throw Error('Unverified command.');
      const command = cancellationResult.parse(await response.json()).command;
      if (!current()) return;
      if (command.subscriptionId !== resource || (check && command.operationId !== id)) throw Error('Unverified command.');
      // SQL can return a previously recorded request for this subscription when
      // a reloaded page proposes a new UUID. Preserve the original operation.
      operation.current = command.operationId; setResult(command);
      setMessage(command.state === 'CONFIRMED' ? 'Razorpay independently confirms the subscription has ended. Existing paid usage follows its recorded expiry.'
        : command.state === 'ACCEPTED' ? 'Razorpay accepted the request to cancel at term end. Final cancellation is pending; your paid time is unchanged.'
          : 'The cancellation outcome needs verification. Check this original request; do not submit another cancellation.');
    } catch { if (current()) setMessage('The cancellation outcome is unknown. Check this original request; do not submit another cancellation.'); }
    finally { if (pending.current === controller) { pending.current = null; if (generation.current === epoch) setBusy(false); } }
  }
  if (!enabled || !valid) return null;
  return <div aria-label="Subscription renewal cancellation" aria-busy={busy}>
    {operation.current ? <>
      <p id={statusId} role="status" aria-live="polite">{message || 'Checking the original cancellation request...'}</p>
      {result?.state === 'CONFIRMED' ? null : <button type="button" disabled={busy || disabled} aria-describedby={statusId} onClick={() => void submit(true)}>Check original cancellation</button>}
    </> : confirming ? <>
      <p id={statusId}>Cancel future renewal at the end of this billing term? Your current paid time keeps its recorded expiry. This does not request a refund.</p>
      <button type="button" disabled={busy || disabled} aria-describedby={statusId} onClick={() => void submit(false)}>Confirm cancellation</button>
      <button type="button" disabled={busy || disabled} onClick={() => setConfirming(false)}>Keep renewal</button>
    </> : <button type="button" disabled={busy || disabled} onClick={() => setConfirming(true)}>Cancel renewal at term end</button>}
  </div>;
}
