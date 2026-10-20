'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { checkoutRequest } from '../../../lib/payments/cluera/checkoutRequest';
import { clueraPublicCatalog, clueraPublicRevision, clueraPrice, clueraAllowance,
  type ClueraPublicRevision,
} from '../../../lib/payments/cluera/publicCatalog';

const listSchema = z.object({ code: z.literal('ACTIVE'), catalog: clueraPublicCatalog }).strict();
const appliedSchema = z.object({ code: z.literal('APPLIED'), revision: clueraPublicRevision }).strict();
const factorsSchema = z.object({ factors: z.array(z.object({ id: z.uuid(), status: z.literal('verified') }).strict()).max(20) }).strict();
type Factor = z.infer<typeof factorsSchema>['factors'][number];

function money(value: string): number | null {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimals = ''] = value.split('.');
  const paise = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return paise >= 100 && paise <= 10_000_000 ? paise : null;
}

/** Immutable future catalog revisions only; never changes an existing paid snapshot. */
export function BillingCatalog({ disabled = false, mode = 'test' }: { disabled?: boolean; mode?: 'test' | 'live' }) {
  const endpoint = mode === 'live' ? '/api/account/payments/cluera/live/admin' : '/api/account/payments/cluera/admin';
  const modeName = mode === 'live' ? 'Live' : 'Test';
  const [catalog, setCatalog] = useState<ClueraPublicRevision[]>([]);
  const [factors, setFactors] = useState<Factor[]>([]), [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(false);
  const [message, setMessage] = useState('Refresh the financial catalog explicitly. No background writes or polling.');
  const alive = useRef(false), running = useRef(false), epoch = useRef(0), disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const controller = useRef<AbortController | null>(null), operation = useRef<string | null>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (disabled) {
      epoch.current++; controller.current?.abort(); setAvailable(false); setFactors([]); setCatalog([]);
      setMessage('A verified Admin session and MFA are required. Financial changes are locked.');
    }
  }, [disabled]);
  const perform = async (work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (running.current || disabledRef.current) return;
    running.current = true; setBusy(true);
    const abort = new AbortController(), generation = epoch.current;
    controller.current = abort;
    const current = () => alive.current && !abort.signal.aborted && !disabledRef.current && generation === epoch.current;
    try { await work(AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]), current); }
    catch { if (current()) { setAvailable(false); setMessage('Billing administration is unavailable or the outcome is unknown. Verify the original operation; do not retry.'); } }
    finally { if (controller.current === abort) controller.current = null; running.current = false; if (alive.current) setBusy(false); }
  };
  const deny = () => { setAvailable(false); setCatalog([]); setFactors([]); setMessage('Verified Admin authorization and MFA are required. Sign in privately; do not submit another change.'); };
  const refresh = () => perform(async (signal, current) => {
    setAvailable(false);
    const response = await checkoutRequest(endpoint, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
    if (!current()) return;
    if (response.status === 401 || response.status === 403) { deny(); return; }
    if (!response.ok) { setMessage('The reviewed Cluera billing schema is not available. No catalog or payment activation was performed.'); return; }
    const data = listSchema.parse(await response.json());
    if (current()) { setCatalog(data.catalog); setAvailable(true); setMessage(operation.current
      ? 'The original change is still unresolved. Refreshing the catalog does not unlock it.'
      : 'Future revisions only. Existing orders, subscriptions, balances and historical prices remain immutable.'); }
  });
  const loadFactors = () => perform(async (signal, current) => {
    if (!available || operation.current) return;
    const response = await checkoutRequest(`${endpoint}?factors=1`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
    if (!current()) return;
    if (response.status === 401 || response.status === 403) { deny(); return; }
    if (!response.ok) throw new Error();
    const data = factorsSchema.parse(await response.json());
    if (current()) { setFactors(data.factors); setMessage(data.factors.length
      ? 'Use a fresh code from your existing authenticator for each audited change.'
      : 'No existing verified authenticator was returned. This catalog does not enroll or bypass MFA.'); }
  });
  const applyRevision = (row: ClueraPublicRevision) => {
    operation.current = null; setPending(false);
    setCatalog(previous => [...previous.filter(item => item.offerCode !== row.offerCode), row]);
    setAvailable(true); setMessage(`Audited change confirmed. The current catalog revision is ${row.enabled ? 'enabled' : 'disabled'}. Catalog availability does not activate checkout or change webhook/scheduler ownership.`);
  };
  const submit = (row: ClueraPublicRevision, form: HTMLFormElement) => {
    if (disabledRef.current || running.current || operation.current || !available || !factors.length) return;
    const values = new FormData(form), action = String(values.get('action'));
    const factorId = String(values.get('factor')), code = String(values.get('code'));
    const reason = String(values.get('reason')).trim();
    const field = form.elements.namedItem('code'); if (field instanceof HTMLInputElement) field.value = '';
    if (!factors.some(factor => factor.id === factorId) || !/^\d{6}$/.test(code) || reason.length < 10 || reason.length > 500) {
      setMessage('Choose your verified authenticator, enter a fresh six-digit code and provide a reason of 10–500 characters.'); return;
    }
    let input: Record<string, unknown>;
    if (action === 'CREATE_REVISION') {
      const amountPaise = money(String(values.get('price'))), allowanceMinutes = Number(values.get('minutes'));
      const name = String(values.get('name')).trim(), totalCount = row.kind === 'PACK' ? null : Number(values.get('totalCount'));
      const razorpayPlanId = row.kind === 'PACK' ? null : String(values.get('plan')).trim();
      if (amountPaise === null || !Number.isInteger(allowanceMinutes) || allowanceMinutes < 1 || allowanceMinutes > 60_000
        || name.length < 2 || name.length > 80 || (row.kind === 'RECURRING'
          && (!/^plan_[A-Za-z0-9]{8,64}$/.test(razorpayPlanId!) || !Number.isInteger(totalCount) || totalCount! < 1 || totalCount! > 120))) {
        setMessage(`Check the future price, whole-minute allowance, display name and exact separately prepared ${modeName} plan. Monthly subscriptions require 1–120 charges.`); return;
      }
      input = { name, amountPaise, allowanceSeconds: allowanceMinutes * 60, razorpayPlanId, totalCount };
    } else if (action === 'SET_ENABLED') input = { enabled: values.get('enabled') === 'on' };
    else { setMessage('Choose a supported catalog action.'); return; }
    const operationId = crypto.randomUUID(); operation.current = operationId; setPending(true);
    void perform(async (signal, current) => {
      const response = await checkoutRequest(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          action, offerCode: row.offerCode, expectedRevisionId: row.revisionId,
          operationId, factorId, code, reason, input,
        }) });
      if (!current()) return;
      if (!response.ok) {
        // These statuses are definitive pre-write authorization/validation rejections.
        // Conflict/timeout/server failures retain the original operation lock.
        if ([400, 401, 403, 429].includes(response.status)) { operation.current = null; setPending(false); }
        if (response.status === 401 || response.status === 403) { deny(); return; }
        setMessage('Change rejected or not confirmed. Keep an unknown operation locked and verify it without resubmitting.'); return;
      }
      const data = appliedSchema.parse(await response.json());
      if (data.revision.offerCode !== row.offerCode) throw new Error();
      if (current()) applyRevision(data.revision);
    });
  };
  const verify = () => perform(async (signal, current) => {
    const id = operation.current; if (!id) return;
    const response = await checkoutRequest(`${endpoint}?operation=${encodeURIComponent(id)}`,
      { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
    if (!current()) return;
    if (response.status === 401 || response.status === 403) { deny(); return; }
    if (!response.ok) throw new Error();
    const raw = await response.json();
    if ((raw as {code?:unknown}|null)?.code === 'APPLIED') { const data = appliedSchema.parse(raw); if (current()) applyRevision(data.revision); }
    else if (current()) setMessage('The original operation is not confirmed. Keep this page locked; no retry or replacement operation was sent.');
  });

  return <section className="ai-provider-console" aria-label="Cluera financial catalog" aria-busy={busy}>
    <p className="account-ui-kicker">IMMUTABLE FINANCIAL CATALOG</p>
    <h2>{modeName} billing plans &amp; future prices</h2>
    <p>Cluera owns future billing. New revisions never rewrite a paid order, a current subscription or the preserved Account/Paddle history.</p>
    <p role="status" aria-live="polite">{message}</p>
    <div className="ai-provider-actions">
      <button type="button" disabled={disabled || busy} onClick={() => void refresh()}>Refresh billing catalog</button>
      <button type="button" disabled={disabled || busy || !available || pending} onClick={() => void loadFactors()}>Load billing authenticators</button>
      {pending ? <button type="button" disabled={disabled || busy} onClick={() => void verify()}>Verify original billing change</button> : null}
    </div>
    <div className="ai-provider-grid">{catalog.map(row => <article className="ai-provider-card" key={row.offerCode}>
      <header><h3>{row.name}</h3><span>{row.enabled ? 'Catalog enabled' : 'Catalog disabled'}</span></header>
      <p>{clueraPrice(row.amountPaise)}{row.kind === 'RECURRING' ? ' / month' : ''} · {clueraAllowance(row.allowanceSeconds)}</p>
      <p>Revision {row.version} · {row.kind === 'PACK' ? 'Non-expiring, stackable pack' : `Monthly, no rollover, at most ${row.totalCount} charges`}</p>
      <p>{row.kind === 'PACK' ? 'No provider subscription plan required.' : row.testPlanValidated
        ? `Exact ${modeName} plan verified for this revision; lifecycle acceptance is still separate.`
        : `${modeName} plan verification required before catalog enablement.`}</p>
      <form key={row.revisionId} onSubmit={event => { event.preventDefault(); submit(row, event.currentTarget); }}>
        <fieldset disabled={disabled || busy || !available || pending || !factors.length}>
          <legend>Audited future configuration</legend>
          <label>Catalog action<select name="action"><option value="CREATE_REVISION">Create a disabled future revision</option><option value="SET_ENABLED">Set current catalog availability</option></select></label>
          <label>Future display name<input name="name" defaultValue={row.name} maxLength={80} /></label>
          <label>Future price (INR)<input name="price" inputMode="decimal" defaultValue={(row.amountPaise / 100).toFixed(2)} maxLength={9} /></label>
          <label>Future allowance (whole minutes)<input name="minutes" type="number" min={1} max={60_000} step={1} defaultValue={row.allowanceSeconds / 60} /></label>
          {row.kind === 'RECURRING' ? <>
            <label>Maximum monthly charges<input name="totalCount" type="number" min={1} max={120} step={1} defaultValue={row.totalCount ?? 120} /></label>
            <label>Separately prepared Razorpay {modeName} plan ID<input name="plan" autoComplete="off" spellCheck={false} maxLength={69} placeholder="plan_…" /></label>
          </> : null}
          <label><input name="enabled" type="checkbox" defaultChecked={row.enabled} /> Catalog enabled (availability action only)</label>
          <label>Reason<textarea name="reason" minLength={10} maxLength={500} required placeholder="Why is this future change needed?" /></label>
          <label>Existing verified authenticator<select name="factor" required><option value="">Choose authenticator</option>{factors.map((factor, index) => <option key={factor.id} value={factor.id}>Authenticator {index + 1}</option>)}</select></label>
          <label>Fresh six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
          <button type="submit">Confirm audited billing change</button>
        </fieldset>
      </form>
    </article>)}</div>
    <p>Future price changes require new immutable provider plans where applicable. This panel never creates provider plans, changes a current mandate, activates a payment flag, repoints a webhook/scheduler or manually grants credits.</p>
  </section>;
}
