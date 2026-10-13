'use client';
import { useEffect, useRef, useState } from 'react';
import { AccountWorkspace } from './AccountWorkspace';
import './account-ui.css';

interface Account { userId: string; email: string; trialSecondsGranted: number; remoteDesktop: false }
type FormMode = 'login' | 'signup' | 'forgot-password';
export function AccountPanel() {
  const [account, setAccount] = useState<Account | null>(null);
  const [mode, setMode] = useState<FormMode>('login');
  const [recovery, setRecovery] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const selectMode = () => {
      if (inFlight.current) return;
      const hash = window.location.hash;
      if (hash === '#signup') setMode('signup');
      else if (hash === '#forgot-password') setMode('forgot-password');
      else if (hash === '#login' || !hash) setMode('login');
      setVisible(false);
    };
    selectMode();
    window.addEventListener('hashchange', selectMode);
    const controller = new AbortController();
    fetch('/api/account/session', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!controller.signal.aborted) {
        if (response.ok) { setAccount(data.account); setRecovery(data.passwordRecovery === true); }
        else if (response.status !== 401) setMessage(data.error ?? 'Account service is unavailable.');
      }
    }).catch(() => { if (!controller.signal.aborted) setMessage('Unable to check your account. Please retry.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); window.removeEventListener('hashchange', selectMode); };
  }, []);
  async function submit(action: string, values: object = {}) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/account/${action}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!alive.current) return;
      if (!response.ok) { setMessage(data.error ?? 'The request failed.'); return; }
      if (data.redirectUrl) { window.location.assign(data.redirectUrl); return; }
      if (data.account) { setAccount(data.account); setRecovery(false); }
      if (action === 'logout' || action === 'reset-password') { setAccount(null); setRecovery(false); setMode('login'); }
      setMessage(data.message ?? '');
    } catch { if (alive.current) setMessage('Connection failed or timed out. Check your account or email before submitting again.'); }
    finally { inFlight.current = false; if (alive.current) { setBusy(false); setVisible(false); } }
  }
  if (loading) return <p role="status">Checking your account…</p>;
  return <section className={`account-card${!account ? ' account-auth' : ''}`} aria-busy={busy}>
    {message ? <p role="status">{message}</p> : null}
    {account ? <>
      <p>Signed in as <strong>{account.email}</strong></p>
      <p>Your one-time 15-minute trial is registered. This is the isolated account staging environment.</p>
      {!recovery ? <AccountWorkspace/> : null}
      {recovery ? <form onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget;
        const password = String(new FormData(form).get('password') ?? '');
        void submit('reset-password', { password }).finally(() => form.reset());
      }}>
        <label>New password<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required disabled={busy}/></label>
        <button className="button" disabled={busy}>Update password and sign out</button>
      </form> : null}
      <button className="button secondary" type="button" disabled={busy} onClick={() => void submit('logout')}>Sign out of this browser</button>
    </> : <>
      <div className="account-auth-brand" aria-hidden="true">C</div><p className="account-ui-kicker">CLUERA AI · TEST WORKSPACE</p>
      <h2>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create an account' : 'Reset your password'}</h2>
      <p className="account-auth-description">{mode === 'signup' ? 'One account for your desktop workspace and shared credits.' : mode === 'forgot-password' ? 'We’ll send a recovery link to your verified email.' : 'Welcome back. Continue to your workspace securely.'}</p>
      <form onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
        void submit(mode, { email: String(data.get('email') ?? ''),
          ...(mode !== 'forgot-password' ? { password: String(data.get('password') ?? '') } : {}) }).finally(() => {
            const password = form.elements.namedItem('password'); if (password instanceof HTMLInputElement) password.value = '';
          });
      }}>
        <label>Email<input name="email" type="email" maxLength={254} autoComplete="email" required disabled={busy}/></label>
        {mode !== 'forgot-password' ? <label>Password<span className="account-auth-password"><input key={mode} name="password" type={visible ? 'text' : 'password'} minLength={mode === 'signup' ? 12 : 1} maxLength={128}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required disabled={busy}/><button type="button" disabled={busy} aria-pressed={visible} aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? 'Hide' : 'Show'}</button></span></label> : null}
        {mode === 'signup' ? <p>Use at least 12 characters. Verify your email before signing in.</p> : null}
        <button className="button" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Send verification email' : 'Send reset email'}</button>
      </form>
      <button className="button secondary" type="button" disabled={busy} onClick={() => void submit('google')}>Continue with Google</button>
      <div className="account-actions">{(['login', 'signup', 'forgot-password'] as const).filter(value => value !== mode).map(value =>
        <button type="button" disabled={busy} key={value} onClick={() => { setMode(value); setMessage(''); setVisible(false); }}>
          {value === 'login' ? 'Back to sign in' : value === 'signup' ? 'Create account' : 'Forgot password?'}</button>)}</div>
      <p className="account-auth-safety">Verify your email before desktop sign-in. Provider credentials remain server-side; this is isolated staging, not a production release.</p>
    </>}
  </section>;
}
