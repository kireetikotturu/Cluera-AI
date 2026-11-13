'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { adminPlanSchema, adminPlanHistorySchema, type AdminPlan, type AdminPlanHistory } from '../../../lib/payments/cluera/adminPlans.contracts';
import { clueraPrice } from '../../../lib/payments/cluera/publicCatalog';

const ENDPOINT = '/api/account/payments/cluera/live/plans';
const listSchema = z.object({ code: z.literal('ACTIVE'), plans: z.array(adminPlanSchema).max(200), history: z.array(adminPlanHistorySchema).max(20).default([]) }).strict();
const appliedSchema = z.object({ code: z.literal('APPLIED'), plan: adminPlanSchema }).strict();
const refusalSchema = z.object({ code: z.string().max(40), message: z.string().max(300) });
type Change = { action: 'CREATE' | 'EDIT' | 'SET_ENABLED' | 'ARCHIVE' | 'RESTORE'; planId?: string; expectedRevisionId?: string; input: Record<string, unknown> };
type Proposal = { change: Change; heading: string; rows: Array<[string, string, string]>; warnings: string[]; reason: string };

/** Rupees like "549" or "549.50" to paise. Null when it is not a valid price of ₹1 to ₹1,00,000. */
export function rupeesToPaise(value: string): number | null {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, decimals = ''] = value.trim().split('.');
  const paise = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return paise >= 100 && paise <= 10_000_000 ? paise : null;
}
/** Hours like "3" or "1.5" to whole seconds. Null unless between about 1 minute and 1,000 hours. */
export function hoursToSeconds(value: string): number | null {
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const seconds = Math.round(Number(value.trim()) * 3600);
  return seconds >= 60 && seconds <= 3_600_000 ? seconds : null;
}
export const hoursText = (seconds: number) => { const hours = Math.round(seconds / 36) / 100; return `${hours} ${hours === 1 ? 'hour' : 'hours'}`; };

/** One plain-English line for the "Recent changes" list. */
export function describeChange(entry: AdminPlanHistory): string {
  const { before, after } = entry, name = after.name ?? before.name ?? 'a plan';
  const state = (value?: boolean) => value ? 'On' : 'Off';
  const parts: Record<string, string> = {
    PLAN_CREATE: `Added "${name}" (${after.amountPaise === undefined ? '' : clueraPrice(after.amountPaise)}, ${after.allowanceSeconds === undefined ? '' : hoursText(after.allowanceSeconds)}, ${state(after.enabled)})`,
    PLAN_SET_ENABLED: `Turned ${state(after.enabled)} "${name}"`, PLAN_ARCHIVE: `Removed "${name}"`, PLAN_RESTORE: `Restored "${name}"`,
  };
  if (entry.action === 'PLAN_EDIT') {
    const changes: string[] = [];
    if (before.name !== after.name) changes.push(`name "${before.name}" to "${after.name}"`);
    if (before.amountPaise !== after.amountPaise && before.amountPaise !== undefined && after.amountPaise !== undefined) changes.push(`price ${clueraPrice(before.amountPaise)} to ${clueraPrice(after.amountPaise)}`);
    if (before.allowanceSeconds !== after.allowanceSeconds && before.allowanceSeconds !== undefined && after.allowanceSeconds !== undefined) changes.push(`time ${hoursText(before.allowanceSeconds)} to ${hoursText(after.allowanceSeconds)}`);
    parts.PLAN_EDIT = `Edited "${name}": ${changes.join('; ') || 'details'}`;
  }
  const when = new Date(entry.at);
  return `${Number.isNaN(when.getTime()) ? entry.at : when.toLocaleString()} · ${entry.by} · ${parts[entry.action] ?? entry.action} · ${entry.reason}`;
}

/** Owner-friendly plan manager. Every change is confirmed with old and new values and audited by the server. */
export function AdminPlans({ disabled = false }: { disabled?: boolean }) {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null), [history, setHistory] = useState<AdminPlanHistory[]>([]);
  const [message, setMessage] = useState('Press "Refresh plans" to see what you are selling.');
  const [busy, setBusy] = useState(false), [form, setForm] = useState<{ mode: 'add' } | { mode: 'edit'; plan: AdminPlan } | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null), [problem, setProblem] = useState('');
  const [showRemoved, setShowRemoved] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
  const alive = useRef(true), running = useRef(false), pending = useRef<{ id: string; body: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const call = async (init?: RequestInit, query = '') => {
    const response = await fetch(ENDPOINT + query, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(15_000), ...init });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  };
  const refusal = (status: number, body: unknown) => {
    const parsed = refusalSchema.safeParse(body);
    return parsed.success ? parsed.data.message : status === 401 || status === 403 ? 'Sign in as Admin with your authenticator first.'
      : 'Something went wrong. Press "Refresh plans" and check before trying again.';
  };
  const refresh = useCallback(async (note?: string) => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setProblem('');
    try {
      const { status, body } = await call();
      if (!alive.current) return;
      const parsed = listSchema.safeParse(body);
      if (status !== 200 || !parsed.success) { setPlans(null); setProblem(refusal(status, body)); return; }
      setPlans(parsed.data.plans); setHistory(parsed.data.history); setMessage(note ?? (parsed.data.plans.some(plan => !plan.archived)
        ? 'These are your plans. Only plans that are On are shown to customers.' : 'You have no plans yet. Press "Add a plan" to create your first one.'));
    } catch { if (alive.current) { setPlans(null); setProblem('Plans could not be loaded. Check your connection and press "Refresh plans".'); } }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }, [disabled]);

  const askToConfirm = (next: Proposal) => { setProblem(''); setForm(null); setProposal(next); };
  const planRows = (plan: AdminPlan, to: Partial<{ name: string; amountPaise: number; allowanceSeconds: number; enabled: boolean }>): Array<[string, string, string]> => {
    const rows: Array<[string, string, string]> = [];
    const next = { name: plan.name, amountPaise: plan.amountPaise, allowanceSeconds: plan.allowanceSeconds, enabled: plan.enabled, ...to };
    if (next.name !== plan.name) rows.push(['Name', plan.name, next.name]);
    if (next.amountPaise !== plan.amountPaise) rows.push(['Price', clueraPrice(plan.amountPaise), clueraPrice(next.amountPaise)]);
    if (next.allowanceSeconds !== plan.allowanceSeconds) rows.push(['Time', hoursText(plan.allowanceSeconds), hoursText(next.allowanceSeconds)]);
    if (next.enabled !== plan.enabled) rows.push(['Status', plan.enabled ? 'On' : 'Off', next.enabled ? 'On' : 'Off']);
    return rows;
  };
  const openCheckoutWarning = (plan: AdminPlan) => plan.openCheckouts > 0 ? [`${plan.openCheckouts} customer${plan.openCheckouts === 1 ? ' has' : 's have'} an unpaid checkout open for this plan right now. After this change they will not be able to finish that checkout and may need to contact support.`] : [];

  function reviewForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget), name = String(values.get('name') ?? '').trim();
    const amountPaise = rupeesToPaise(String(values.get('price') ?? '')), allowanceSeconds = hoursToSeconds(String(values.get('hours') ?? ''));
    const reason = String(values.get('reason') ?? '').trim();
    if (name.length < 2 || name.length > 80) { setProblem('Give the plan a name of 2 to 80 characters, for example "Cluera 10 Hours".'); return; }
    if (amountPaise === null) { setProblem('Enter the price in rupees, for example 549 or 549.50. It must be between ₹1 and ₹1,00,000.'); return; }
    if (allowanceSeconds === null) { setProblem('Enter the time in hours, for example 3 or 1.5. It must be between 0.02 and 1000 hours.'); return; }
    if (reason.length > 400) { setProblem('Keep the reason under 400 characters.'); return; }
    if (form?.mode === 'edit') {
      const plan = form.plan, rows = planRows(plan, { name, amountPaise, allowanceSeconds });
      if (!rows.length) { setProblem('You did not change anything.'); return; }
      askToConfirm({ heading: `Change "${plan.name}"?`, rows, reason, warnings: [
        'The new price and time apply to FUTURE purchases only. Orders already paid and time already added never change.', ...openCheckoutWarning(plan)],
      change: { action: 'EDIT', planId: plan.planId, expectedRevisionId: plan.revisionId, input: { name, amountPaise, allowanceSeconds } } });
    } else {
      const enabled = values.get('enabled') === 'on';
      askToConfirm({ heading: `Add the plan "${name}"?`, reason, warnings: enabled ? ['Customers will be able to buy it as soon as you confirm.'] : ['It will stay Off until you turn it On.'],
        rows: [['Name', '—', name], ['Price', '—', clueraPrice(amountPaise)], ['Time', '—', hoursText(allowanceSeconds)], ['Status', '—', enabled ? 'On' : 'Off']],
        change: { action: 'CREATE', input: { name, amountPaise, allowanceSeconds, enabled } } });
    }
  }
  const toggle = (plan: AdminPlan) => askToConfirm({ heading: plan.enabled ? `Turn Off "${plan.name}"?` : `Turn On "${plan.name}"?`,
    rows: planRows(plan, { enabled: !plan.enabled }), reason: '', change: { action: 'SET_ENABLED', planId: plan.planId, expectedRevisionId: plan.revisionId, input: { enabled: !plan.enabled } },
    warnings: plan.enabled ? ['Customers will no longer see or be able to buy this plan. Past purchases and time already added are not affected.', ...openCheckoutWarning(plan)]
      : ['Customers will be able to buy this plan as soon as you confirm.'] });
  const remove = (plan: AdminPlan) => askToConfirm({ heading: `Remove "${plan.name}"?`,
    rows: [['Status', plan.enabled ? 'On' : 'Off', 'Removed (hidden)']], reason: '', change: { action: 'ARCHIVE', planId: plan.planId, expectedRevisionId: plan.revisionId, input: {} },
    warnings: ['The plan is turned Off and hidden. It is not deleted: paid history and time already added stay exactly as they are, and you can restore it later.', ...openCheckoutWarning(plan)] });
  const restore = (plan: AdminPlan) => askToConfirm({ heading: `Restore "${plan.name}"?`,
    rows: [['Status', 'Removed (hidden)', 'Off (visible to you only)']], reason: '', change: { action: 'RESTORE', planId: plan.planId, expectedRevisionId: plan.revisionId, input: {} },
    warnings: ['It comes back Off. Turn it On when you want customers to see it.'] });

  async function send(body: string, id: string) {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setProblem('');
    try {
      const { status, body: data } = await call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!alive.current) return;
      const applied = appliedSchema.safeParse(data);
      if (status === 200 && applied.success) {
        pending.current = null; setUnconfirmed(false); setProposal(null);
        const done = `Done. "${applied.data.plan.name}" is now ${clueraPrice(applied.data.plan.amountPaise)} for ${hoursText(applied.data.plan.allowanceSeconds)} and is ${applied.data.plan.archived ? 'removed' : applied.data.plan.enabled ? 'On' : 'Off'}. This change is saved in the history.`;
        setMessage(done);
        running.current = false; setBusy(false); await refresh(done); return;
      }
      // A clear refusal means nothing was written, so the owner can fix it and try again.
      if ([400, 401, 403, 404, 409, 429].includes(status) && refusalSchema.safeParse(data).success) {
        pending.current = null; setUnconfirmed(false); setProposal(null); setProblem(refusal(status, data)); return;
      }
      throw new Error('unknown');
    } catch {
      if (alive.current) { pending.current = { id, body }; setUnconfirmed(true);
        setProblem('We could not confirm whether that change was saved. Press "Check what happened" before doing anything else. Please do not repeat it.'); }
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  const confirm = () => {
    if (!proposal || pending.current) return;
    const id = crypto.randomUUID(), body = JSON.stringify({ ...proposal.change, operationId: id, ...(proposal.reason ? { reason: proposal.reason } : {}) });
    pending.current = { id, body }; void send(body, id);
  };
  const check = async () => {
    const current = pending.current; if (!current || running.current) return;
    running.current = true; setBusy(true);
    try {
      const { status, body } = await call(undefined, `?operation=${encodeURIComponent(current.id)}`);
      if (!alive.current) return;
      const applied = appliedSchema.safeParse(body);
      if (status === 200 && applied.success) { pending.current = null; setUnconfirmed(false); setProposal(null); setProblem('');
        const saved = `That change WAS saved: "${applied.data.plan.name}" is ${clueraPrice(applied.data.plan.amountPaise)} for ${hoursText(applied.data.plan.allowanceSeconds)}.`;
        setMessage(saved);
        running.current = false; setBusy(false); await refresh(saved); return; }
      if (status === 200) { pending.current = null; setUnconfirmed(false); setProposal(null); setProblem('');
        setMessage('That change was NOT saved. Nothing was changed. You can try again if you still want it.'); return; }
      setProblem('We still cannot check. Wait a minute and press "Check what happened" again. Please do not repeat the change.');
    } catch { if (alive.current) setProblem('We still cannot check. Wait a minute and press "Check what happened" again. Please do not repeat the change.'); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };

  const visible = (plans ?? []).filter(plan => !plan.archived), removed = (plans ?? []).filter(plan => plan.archived);
  const locked = disabled || busy || unconfirmed;
  const editing = form?.mode === 'edit' ? form.plan : null;
  return <section id="account-admin-plans" className="ai-provider-console" aria-labelledby="account-admin-plans-heading" aria-busy={busy}>
    <p className="account-ui-kicker">YOUR PLANS</p>
    <h2 id="account-admin-plans-heading">Plans customers can buy</h2>
    <p>Each plan is a one-time pack of time. Customers only see plans that are <strong>On</strong>. Changing a price or hours affects <strong>future purchases only</strong>: nothing already paid, and no time already added, ever changes.</p>
    <p role="status" aria-live="polite">{message}</p>
    {problem ? <p role="alert" className="account-admin-problem"><strong>{problem}</strong></p> : null}
    <div className="ai-provider-actions">
      <button type="button" disabled={disabled || busy} onClick={() => void refresh()}>Refresh plans</button>
      <button type="button" disabled={locked || plans === null} onClick={() => { setProposal(null); setProblem(''); setForm({ mode: 'add' }); }}>+ Add a plan</button>
      {unconfirmed ? <button type="button" disabled={disabled || busy} onClick={() => void check()}>Check what happened</button> : null}
    </div>
    {proposal ? <div role="alertdialog" aria-labelledby="plan-confirm-heading" className="account-admin-confirm">
      <h3 id="plan-confirm-heading">Are you sure? {proposal.heading}</h3>
      <table><thead><tr><th scope="col">What</th><th scope="col">Now</th><th scope="col">After you confirm</th></tr></thead>
        <tbody>{proposal.rows.map(([label, before, after]) => <tr key={label}><th scope="row">{label}</th><td>{before}</td><td><strong>{after}</strong></td></tr>)}</tbody></table>
      {proposal.warnings.map(text => <p key={text}>{text}</p>)}
      {proposal.reason ? <p>Reason you gave: {proposal.reason}</p> : null}
      <p>Your name, the time and these values are recorded automatically.</p>
      <div className="ai-provider-actions">
        <button type="button" disabled={disabled || busy || unconfirmed} onClick={confirm}>Yes, make this change</button>
        <button type="button" disabled={busy || unconfirmed} onClick={() => setProposal(null)}>No, go back</button>
      </div>
    </div> : null}
    {form ? <form key={editing?.planId ?? 'add'} onSubmit={reviewForm} className="account-admin-plan-form">
      <fieldset disabled={locked}><legend>{editing ? `Edit "${editing.name}"` : 'Add a plan'}</legend>
        <label>Plan name<input name="name" defaultValue={editing?.name ?? ''} minLength={2} maxLength={80} required placeholder="Cluera 10 Hours" /></label>
        <label>Price in rupees (₹)<input name="price" inputMode="decimal" defaultValue={editing ? String(editing.amountPaise / 100) : ''} required placeholder="1499" /></label>
        <label>Hours of time<input name="hours" inputMode="decimal" defaultValue={editing ? String(Math.round(editing.allowanceSeconds / 36) / 100) : ''} required placeholder="10" /></label>
        {editing ? null : <label><input name="enabled" type="checkbox" defaultChecked /> Turn it On straight away</label>}
        <label>Reason (optional)<input name="reason" maxLength={400} placeholder="For example: launch offer" /></label>
        <div className="ai-provider-actions"><button type="submit">Review the change</button><button type="button" onClick={() => { setForm(null); setProblem(''); }}>Cancel</button></div>
      </fieldset></form> : null}
    {plans === null ? null : <table className="account-admin-plans-table" aria-label="Your plans">
      <thead><tr><th scope="col">Name</th><th scope="col">Price</th><th scope="col">Time</th><th scope="col">Status</th><th scope="col">What you can do</th></tr></thead>
      <tbody>{visible.map(plan => <tr key={plan.planId}>
        <th scope="row">{plan.name}</th><td>{clueraPrice(plan.amountPaise)}</td><td>{hoursText(plan.allowanceSeconds)}</td>
        <td><strong className={plan.enabled ? 'plan-status-on' : 'plan-status-off'}>{plan.enabled ? '● On' : '○ Off'}</strong></td>
        <td><button type="button" disabled={locked} onClick={() => { setProposal(null); setProblem(''); setForm({ mode: 'edit', plan }); }}>Edit</button>{' '}
          <button type="button" disabled={locked} onClick={() => toggle(plan)}>{plan.enabled ? 'Turn Off' : 'Turn On'}</button>{' '}
          <button type="button" disabled={locked} onClick={() => remove(plan)}>Remove</button></td>
      </tr>)}</tbody></table>}
    {plans !== null && !visible.length ? <p className="account-admin-empty">No plans yet.</p> : null}
    {removed.length ? <details open={showRemoved} onToggle={event => setShowRemoved(event.currentTarget.open)}><summary>Removed plans ({removed.length})</summary>
      <ul>{removed.map(plan => <li key={plan.planId}>{plan.name} · {clueraPrice(plan.amountPaise)} · {hoursText(plan.allowanceSeconds)} <button type="button" disabled={locked} onClick={() => restore(plan)}>Restore</button></li>)}</ul>
      <p>Removed plans are hidden from customers but kept for your records. Nothing is ever deleted.</p></details> : null}
    {history.length ? <details><summary>Recent changes ({history.length}): who changed what, and when</summary>
      <ul>{history.map(entry => <li key={`${entry.at}:${entry.action}:${entry.after.name ?? ''}`}>{describeChange(entry)}</li>)}</ul>
      <p>This list is kept automatically and cannot be edited.</p></details> : null}
    <p>Monthly plans are not sold yet. Razorpay does not let a monthly plan be edited, so a price change there needs a brand-new plan; they stay hidden for now.</p>
  </section>;
}
