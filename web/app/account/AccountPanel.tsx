'use client';
import { useEffect, useRef, useState } from 'react';
import { AccountWorkspace } from './AccountWorkspace';
import {authFailure,emailNotice,signupNotice,publicLoginSchema,publicSessionSchema,safeGoogleRedirect,type PublicAccount} from '../../lib/accounts/publicAuth';
import {MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH} from '../../lib/accounts/passwordPolicy';
import {resolveCheckoutSelection,selectionFromSearch,clearCheckoutSelection,checkoutSelectionHref,checkoutSelectionName,type CheckoutSelection} from '../../lib/cluera/checkoutJourney';
import './account-ui.css';

type FormMode = 'login' | 'signup' | 'forgot-password' | 'resend-verification';
type Feedback = {tone:'success'|'error'|'info';message:string;detail?:string;maskedEmail?:string};
const uncertainNotice='Connection failed or timed out. Check your account or email before submitting again.';
const verificationAction=(action:string)=>action==='signup'||action==='resend-verification';
function maskedEmail(value:unknown):string {
  if(typeof value!=='string'||value.length>254)return '';
  const parts=value.trim().split('@');
  return parts.length===2&&parts[0]&&parts[1]?`${parts[0][0]}***@${parts[1]}`:'';
}
export function AccountPanel() {
  const [account, setAccount] = useState<PublicAccount | null>(null);
  const [mode, setMode] = useState<FormMode>('login');
  const [recovery, setRecovery] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingAction,setPendingAction]=useState<string|null>(null);
  const [feedback,setFeedback]=useState<Feedback|null>(null);
  const [visible, setVisible] = useState(false);
  const [selection,setSelection]=useState<CheckoutSelection|null>(null);
  const [resendSeconds,setResendSeconds]=useState(0);
  const [verificationReady,setVerificationReady]=useState(false);
  const inFlight = useRef(false),alive = useRef(true);
  const writeController = useRef<AbortController | null>(null),sessionController=useRef<AbortController|null>(null);
  const writeDeadline=useRef<ReturnType<typeof setTimeout>|null>(null);
  const sessionEpoch=useRef(0),writeEpoch=useRef(0),resendUntil=useRef(0);
  const verificationEmail=useRef(''),feedbackElement=useRef<HTMLDivElement|null>(null);
  const busy=pendingAction!==null;
  const emailOnly=mode==='forgot-password'||mode==='resend-verification';
  const verificationCoolingDown=verificationAction(mode)&&resendSeconds>0;
  const cooldownActive=resendSeconds>0;
  function startResendCooldown(){resendUntil.current=Date.now()+60_000;setResendSeconds(60);}
  function chooseMode(value:FormMode){
    if(inFlight.current)return;
    window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}#${value}`);
    setMode(value);setFeedback(null);setVisible(false);setVerificationReady(false);verificationEmail.current='';
  }
  // A bounded presentation timer only: server limits remain authoritative.
  // Reaching zero never sends an email, retries or changes an Auth session.
  useEffect(()=>{
    if(!cooldownActive)return;
    const timer=setInterval(()=>setResendSeconds(Math.max(0,Math.ceil((resendUntil.current-Date.now())/1000))),1000);
    return()=>clearInterval(timer);
  },[cooldownActive]);
  useEffect(()=>{
    if(feedback&&feedback.tone!=='info'){
      feedbackElement.current?.focus({preventScroll:true});
      feedbackElement.current?.scrollIntoView?.({block:'center',inline:'nearest'});
    }
  },[feedback]);
  useEffect(() => {
    alive.current = true;
    try{setSelection(resolveCheckoutSelection(window.location.search,window.sessionStorage));}
    catch{setSelection(selectionFromSearch(window.location.search));}
    const selectMode = () => {
      if (inFlight.current) return;
      setVerificationReady(false);verificationEmail.current='';
      const hash = window.location.hash;
      if (hash === '#signup') setMode('signup');
      else if (hash === '#forgot-password') setMode('forgot-password');
      else if (hash === '#resend-verification') setMode('resend-verification');
      else if (hash === '#login' || !hash) setMode('login');
      setVisible(false);
    };
    selectMode();
    window.addEventListener('hashchange', selectMode);
    const controller = new AbortController(),epoch=++sessionEpoch.current;
    sessionController.current=controller;
    const current=()=>alive.current&&!controller.signal.aborted&&sessionEpoch.current===epoch;
    const deadline=setTimeout(()=>{if(current()){
      controller.abort();setLoading(false);setFeedback({tone:'error',message:'Account service is unavailable.'});
    }},15000);
    fetch('/api/account/session', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (current()) {
        if (response.ok) { const session=publicSessionSchema.parse(data);setAccount(session.account); setRecovery(session.passwordRecovery); }
        else if (response.status !== 401) setFeedback({tone:'error',message:authFailure(response.status)});
      }
    }).catch(() => { if (current()) setFeedback({tone:'error',message:'Account service is unavailable.'}); })
      .finally(() => { clearTimeout(deadline);if(current())setLoading(false);if(sessionController.current===controller)sessionController.current=null; });
    return () => {
      alive.current = false;++sessionEpoch.current;++writeEpoch.current;clearTimeout(deadline);controller.abort();
      if(writeDeadline.current!==null)clearTimeout(writeDeadline.current);
      writeController.current?.abort();window.removeEventListener('hashchange', selectMode);
    };
  }, []);
  async function submit(action: string, values: object = {}) {
    if (inFlight.current||(verificationAction(action)&&resendUntil.current>Date.now())) return;
    // A restoration read may not replace a newer explicit submission's feedback.
    ++sessionEpoch.current;sessionController.current?.abort();sessionController.current=null;
    const epoch=++writeEpoch.current,current=()=>alive.current&&writeEpoch.current===epoch;
    inFlight.current = true;setPendingAction(action);setLoading(false);
    setFeedback({tone:'info',message:verificationAction(action)?'Sending verification email…':'Please wait…'});
    const controller=new AbortController();writeController.current=controller;
    const deadline=setTimeout(()=>{
      controller.abort();if(current()){
        setFeedback({tone:'error',message:uncertainNotice});setPendingAction(null);setVisible(false);
        inFlight.current=false;if(writeController.current===controller)writeController.current=null;
      }
    },15000);
    writeDeadline.current=deadline;
    try {
      const response = await fetch(`/api/account/${action}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values), signal: controller.signal });
      const data = await response.json();
      if (!current() || controller.signal.aborted) return;
      if (!response.ok) {
        if(response.status===429&&verificationAction(action))startResendCooldown();
        setFeedback({tone:'error',message:authFailure(response.status,action,data?.code)});return;
      }
      if(action==='google'){window.location.assign(safeGoogleRedirect(data));return;}
      if(action==='login'){
        const result=publicLoginSchema.parse(data);setAccount(result.account);setRecovery(false);setFeedback(null);
        verificationEmail.current='';setVerificationReady(false);resendUntil.current=0;setResendSeconds(0);return;
      }
      if (action === 'logout' || action === 'reset-password') {
        if(data?.ok!==true||Object.keys(data).some(k=>!['ok','message'].includes(k)))throw new Error('Invalid response.');
        try{clearCheckoutSelection(window.sessionStorage);}catch{/* Auth works without browser storage. */}
        window.history.replaceState(null,'',`${window.location.pathname}#login`);
        setSelection(null);setAccount(null);setRecovery(false);verificationEmail.current='';setVerificationReady(false);resendUntil.current=0;setResendSeconds(0);
        setMode('login');setVisible(false);
        setFeedback(action==='reset-password'?{tone:'success',message:'Password updated. Sign in again.'}:null);return;
      }
      if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||data.message!==emailNotice)throw new Error('Invalid response.');
      const email='email' in values?values.email:undefined,masked=maskedEmail(email);
      if(verificationAction(action)){
        startResendCooldown();verificationEmail.current=typeof email==='string'?email.trim():'';setVerificationReady(Boolean(masked));
      }
      setFeedback({tone:'success',message:action==='signup'?signupNotice:emailNotice,maskedEmail:masked,
        ...(verificationAction(action)?{detail:'For eligible requests only. This does not confirm whether an account exists or guarantee inbox delivery. Open the latest link in this same browser.'}:{})});
    } catch { if (current()&&!controller.signal.aborted) setFeedback({tone:'error',message:uncertainNotice}); }
    finally {
      clearTimeout(deadline);if(writeDeadline.current===deadline)writeDeadline.current=null;
      if(writeController.current===controller)writeController.current=null;
      if(current()){inFlight.current=false;setPendingAction(null);setVisible(false);}
    }
  }
  if (loading) return <p role="status">Checking your account…</p>;
  const feedbackRegion=<div id="account-auth-feedback" ref={feedbackElement} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true"
    className={`account-auth-feedback${feedback?` account-auth-feedback-${feedback.tone}`:''}`}>
    {feedback?<><p>{feedback.message}</p>{feedback.maskedEmail?<p className="account-auth-feedback-address">Submitted email: <strong>{feedback.maskedEmail}</strong></p>:null}
      {feedback.detail?<p className="account-auth-feedback-detail">{feedback.detail}</p>:null}</>:null}
  </div>;
  return <section className={`account-card${!account ? ' account-auth' : ''}`} aria-busy={busy}>
    {selection&&!recovery?<aside className="cluera-plan-handoff" aria-label="Selected Cluera plan">
      <p>Selected plan: <strong>{checkoutSelectionName(selection)}</strong></p>
      <p>Prices and availability are checked again on the server. Sign-in never starts a payment.</p>
      {account?<a className="button secondary" href={checkoutSelectionHref(selection)}>Continue to selected plan</a>:null}
    </aside>:null}
    {account ? <>
      <p>Signed in as <strong>{account.email}</strong></p>
      <p>Your one-time 15-minute trial is registered. This is the isolated account staging environment.</p>
      {!recovery ? <AccountWorkspace/> : null}
      {recovery ? <form aria-describedby="account-auth-feedback" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget;
        const password = String(new FormData(form).get('password') ?? '');
        form.reset();void submit('reset-password', { password });
      }}>
        <label>New password<input name="password" type="password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} autoComplete="new-password" required disabled={busy}/></label>
        <button className="button" type="submit" disabled={busy}>Update password and sign out</button>
      </form> : null}
      {feedbackRegion}
      <button className="button secondary" type="button" disabled={busy} onClick={() => void submit('logout')}>Sign out of this browser</button>
    </> : <>
      <div className="account-auth-brand" aria-hidden="true">C</div><p className="account-ui-kicker">CLUERA AI · TEST WORKSPACE</p>
      <h2>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create an account' : mode==='resend-verification'?'Resend verification':'Reset your password'}</h2>
      <p className="account-auth-description">{mode === 'signup' ? 'One account for your desktop workspace and shared credits.' : mode === 'forgot-password' ? 'We’ll send a recovery link to your verified email.' : mode==='resend-verification'?'Request a new verification link for your pending signup.':'Welcome back. Continue to your workspace securely.'}</p>
      <form aria-describedby="account-auth-feedback" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
        const values={email:String(data.get('email')??''),...(!emailOnly?{password:String(data.get('password')??'')}:{})};
        const password=form.elements.namedItem('password');if(password instanceof HTMLInputElement)password.value='';
        void submit(mode,values);
      }}>
        <label>Email<input name="email" type="email" maxLength={254} autoComplete="email" required disabled={busy}/></label>
        {!emailOnly ? <label>Password<span className="account-auth-password"><input key={mode} name="password" type={visible ? 'text' : 'password'} minLength={mode === 'signup' ? MIN_PASSWORD_LENGTH : 1} maxLength={MAX_PASSWORD_LENGTH}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required disabled={busy}/><button type="button" disabled={busy} aria-pressed={visible} aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? 'Hide' : 'Show'}</button></span></label> : null}
        {mode === 'signup' ? <p>Use at least {MIN_PASSWORD_LENGTH} characters. Verify your email before signing in.</p> : null}
        <button className="button" type="submit" disabled={busy||verificationCoolingDown}>{busy ? verificationAction(pendingAction??'')?'Sending verification email…':'Please wait…'
          : verificationCoolingDown?`Wait at least ${resendSeconds}s before another request`:mode === 'login' ? 'Sign in' : mode === 'signup'||mode==='resend-verification' ? 'Send verification email' : 'Send reset email'}</button>
      </form>
      {feedbackRegion}
      {verificationReady&&verificationAction(mode)?<div className="account-auth-resend">
        <button className="button secondary" type="button" data-resend-verification disabled={busy||resendSeconds>0}
          onClick={()=>void submit('resend-verification',{email:verificationEmail.current})}>
          {resendSeconds>0?`Resend verification email — wait at least ${resendSeconds}s`:'Resend verification email'}
        </button><p>No email is resent automatically. Server sending limits may require a longer wait.</p>
      </div>:null}
      <button className="button secondary" type="button" disabled={busy} onClick={() => void submit('google')}>Continue with Google</button>
      {mode==='resend-verification'?<p>Open the latest verification link in this same browser. This does not reset your password.</p>:null}
      <div className="account-actions">{(['login', 'signup', 'forgot-password','resend-verification'] as const).filter(value => value !== mode).map(value =>
        <button type="button" disabled={busy} key={value} onClick={() => chooseMode(value)}>
          {value === 'login' ? 'Back to sign in' : value === 'signup' ? 'Create account' : value==='resend-verification'?'Resend verification':'Forgot password?'}</button>)}</div>
      <p className="account-auth-safety">Verify your email before desktop sign-in. Provider credentials remain server-side; this is isolated staging, not a production release.</p>
    </>}
  </section>;
}
