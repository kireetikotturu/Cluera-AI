'use client';
import { useEffect, useRef, useState } from 'react';
import { AccountWorkspace } from './AccountWorkspace';
import {authFailure,emailNotice,publicLoginSchema,publicSessionSchema,safeGoogleRedirect,type PublicAccount} from '../../lib/accounts/publicAuth';
import './account-ui.css';

type FormMode = 'login' | 'signup' | 'forgot-password';
export function AccountPanel() {
  const [account, setAccount] = useState<PublicAccount | null>(null);
  const [mode, setMode] = useState<FormMode>('login');
  const [recovery, setRecovery] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const writeController = useRef<AbortController | null>(null);
  function chooseMode(value:FormMode){
    window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}#${value}`);
    setMode(value);setMessage('');setVisible(false);
  }
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
    const deadline=setTimeout(()=>{controller.abort();if(alive.current){setLoading(false);setMessage('Account service is unavailable.');}},15000);
    fetch('/api/account/session', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!controller.signal.aborted) {
        if (response.ok) { const session=publicSessionSchema.parse(data);setAccount(session.account); setRecovery(session.passwordRecovery); }
        else if (response.status !== 401) setMessage(authFailure(response.status));
      }
    }).catch(() => { if (!controller.signal.aborted) setMessage('Account service is unavailable.'); })
      .finally(() => { clearTimeout(deadline);if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; clearTimeout(deadline);controller.abort();writeController.current?.abort();window.removeEventListener('hashchange', selectMode); };
  }, []);
  async function submit(action: string, values: object = {}) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const controller=new AbortController();writeController.current=controller;
    const deadline=setTimeout(()=>controller.abort(),15000);
    try {
      const response = await fetch(`/api/account/${action}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values), signal: controller.signal });
      const data = await response.json();
      if (!alive.current || controller.signal.aborted) return;
      if (!response.ok) { setMessage(authFailure(response.status)); return; }
      if(action==='google'){window.location.assign(safeGoogleRedirect(data));return;}
      if(action==='login'){const result=publicLoginSchema.parse(data);setAccount(result.account);setRecovery(false);return;}
      if (action === 'logout' || action === 'reset-password') {
        if(data?.ok!==true||Object.keys(data).some(k=>!['ok','message'].includes(k)))throw new Error('Invalid response.');
        setAccount(null);setRecovery(false);chooseMode('login');
        setMessage(action==='reset-password'?'Password updated. Sign in again.':'');return;
      }
      if(Object.keys(data).length!==1||data.message!==emailNotice)throw new Error('Invalid response.');
      setMessage(emailNotice);
    } catch { if (alive.current) setMessage('Connection failed or timed out. Check your account or email before submitting again.'); }
    finally { clearTimeout(deadline);if(writeController.current===controller)writeController.current=null;inFlight.current = false; if (alive.current) { setBusy(false); setVisible(false); } }
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
        form.reset();void submit('reset-password', { password });
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
        const values={email:String(data.get('email')??''),...(mode!=='forgot-password'?{password:String(data.get('password')??'')}:{})};
        const password=form.elements.namedItem('password');if(password instanceof HTMLInputElement)password.value='';
        void submit(mode,values);
      }}>
        <label>Email<input name="email" type="email" maxLength={254} autoComplete="email" required disabled={busy}/></label>
        {mode !== 'forgot-password' ? <label>Password<span className="account-auth-password"><input key={mode} name="password" type={visible ? 'text' : 'password'} minLength={mode === 'signup' ? 12 : 1} maxLength={128}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required disabled={busy}/><button type="button" disabled={busy} aria-pressed={visible} aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? 'Hide' : 'Show'}</button></span></label> : null}
        {mode === 'signup' ? <p>Use at least 12 characters. Verify your email before signing in.</p> : null}
        <button className="button" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Send verification email' : 'Send reset email'}</button>
      </form>
      <button className="button secondary" type="button" disabled={busy} onClick={() => void submit('google')}>Continue with Google</button>
      <div className="account-actions">{(['login', 'signup', 'forgot-password'] as const).filter(value => value !== mode).map(value =>
        <button type="button" disabled={busy} key={value} onClick={() => chooseMode(value)}>
          {value === 'login' ? 'Back to sign in' : value === 'signup' ? 'Create account' : 'Forgot password?'}</button>)}</div>
      <p className="account-auth-safety">Verify your email before desktop sign-in. Provider credentials remain server-side; this is isolated staging, not a production release.</p>
    </>}
  </section>;
}
