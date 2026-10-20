'use client';
import { useCallback,useEffect, useRef, useState } from 'react';
import { AccountWorkspace } from './AccountWorkspace';
import {AccountAuthHelp} from './AccountAuthHelp';
import {AccountPasswordSecurity,type PasswordSecurityState} from './AccountPasswordSecurity';
import {notifyAccountSessionChanged,ACCOUNT_SESSION_STORAGE_KEY} from './AdminRoleNavigation';
import {selectedPlanReturn,replaceAccountLocation} from '../../lib/accounts/browserNavigation';
import {authFailure,emailNotice,signupNotice,resendNotice,publicLoginSchema,publicSessionSchema,safeGoogleRedirect,type PublicAccount} from '../../lib/accounts/publicAuth';
import {MIN_PASSWORD_LENGTH,MAX_PASSWORD_LENGTH} from '../../lib/accounts/passwordPolicy';
import {resolveCheckoutSelection,selectionFromSearch,clearCheckoutSelection,checkoutSelectionHref,checkoutSelectionName,type CheckoutSelection} from '../../lib/cluera/checkoutJourney';
import './account-ui.css';

type FormMode = 'login' | 'signup' | 'forgot-password' | 'resend-verification';
type Feedback = {tone:'success'|'error'|'info';message:string;detail?:string;maskedEmail?:string};
const uncertainNotice='Connection failed or timed out. Check your account or email before submitting again.';
const verificationAction=(action:string)=>action==='signup'||action==='resend-verification';
const emailAction=(action:string)=>verificationAction(action)||action==='forgot-password';
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
  const [checkingSession,setCheckingSession]=useState(false);
  const [pendingAction,setPendingAction]=useState<string|null>(null);
  const [feedback,setFeedback]=useState<Feedback|null>(null);
  const [visible, setVisible] = useState(false);
  const [selection,setSelection]=useState<CheckoutSelection|null>(null);
  const [resendSeconds,setResendSeconds]=useState(0);
  const [verificationReady,setVerificationReady]=useState(false);
  const [emailDraft,setEmailDraft]=useState('');
  const [google,setGoogle]=useState<'enabled'|'disabled'|'unavailable'>('unavailable');
  const [reauthSeconds,setReauthSeconds]=useState(0);
  const [passwordSecurity,setPasswordSecurity]=useState<PasswordSecurityState|null>(null),[securityRefresh,setSecurityRefresh]=useState(0);
  const inFlight = useRef(false),alive = useRef(true);
  const writeController = useRef<AbortController | null>(null),sessionController=useRef<AbortController|null>(null);
  const writeDeadline=useRef<ReturnType<typeof setTimeout>|null>(null);
  const sessionEpoch=useRef(0),writeEpoch=useRef(0),resendUntil=useRef(0);
  const verificationEmail=useRef(''),feedbackElement=useRef<HTMLDivElement|null>(null);
  const selected=useRef<CheckoutSelection|null>(null),currentAccount=useRef<PublicAccount|null>(null);
  const securityState=useRef<PasswordSecurityState|null>(null),restartRecovery=useRef(false);
  const reauthUntil=useRef(0),lastSessionCheck=useRef(0),returned=useRef(false);
  const callbackFeedback=useRef<Feedback|null>(null);
  const restoreSession=useRef<(expectedAccountId?:string,writeCurrent?:()=>boolean,explicit?:boolean)=>Promise<boolean>>(async()=>false);
  const baseBusy=pendingAction!==null||checkingSession;
  const currentSecurity=passwordSecurity?.accountId===account?.userId&&passwordSecurity?.passwordRecovery===recovery?passwordSecurity:null;
  const passwordReady=currentSecurity?.status==='ready';
  const recoveryExpired=currentSecurity?.status==='expired';
  const busy=baseBusy||currentSecurity?.status==='checking';
  const securityChanged=useCallback((state:PasswordSecurityState)=>{if(currentAccount.current?.userId===state.accountId){securityState.current=state;setPasswordSecurity(state);}},[]);
  const securityVerified=useCallback(()=>{setFeedback({tone:'success',message:'Authenticator verified. Choose your new password.'});notifyAccountSessionChanged();},[]);
  const emailOnly=mode==='forgot-password'||mode==='resend-verification';
  const emailPending=verificationReady&&emailAction(mode);
  const emailCoolingDown=emailAction(mode)&&resendSeconds>0;
  const cooldownActive=resendSeconds>0;
  function startResendCooldown(){resendUntil.current=Date.now()+60_000;setResendSeconds(60);}
  function clearSessionView(){currentAccount.current=null;securityState.current=null;setPasswordSecurity(null);setAccount(null);setRecovery(false);setVisible(false);}
  function refreshPasswordSecurity(){
    const value=securityState.current;if(value){const next={...value,status:'checking' as const};securityState.current=next;setPasswordSecurity(next);}setSecurityRefresh(value=>value+1);
  }
  function completeSignOut(message:Feedback|null){
    try{clearCheckoutSelection(window.sessionStorage);}catch{/* Storage is optional. */}
    window.history.replaceState(null,'',`${window.location.pathname}#login`);
    selected.current=null;setSelection(null);clearSessionView();verificationEmail.current='';
    setVerificationReady(false);setEmailDraft('');resendUntil.current=0;setResendSeconds(0);setReauthSeconds(0);
    reauthUntil.current=0;setMode('login');setFeedback(message);notifyAccountSessionChanged();
  }
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
    if(reauthSeconds<=0)return;
    const timer=setInterval(()=>setReauthSeconds(Math.max(0,Math.ceil((reauthUntil.current-Date.now())/1000))),1000);
    return()=>clearInterval(timer);
  },[reauthSeconds>0]);
  useEffect(()=>{
    if(feedback&&feedback.tone!=='info'){
      feedbackElement.current?.focus({preventScroll:true});
      feedbackElement.current?.scrollIntoView?.({block:'center',inline:'nearest'});
    }
  },[feedback]);
  useEffect(() => {
    alive.current = true;
    try{selected.current=resolveCheckoutSelection(window.location.search,window.sessionStorage);}
    catch{selected.current=selectionFromSearch(window.location.search);}
    setSelection(selected.current);
    const selectMode = () => {
      if (inFlight.current) return;
      setVerificationReady(false);verificationEmail.current='';
      const hash = window.location.hash;
      if (hash === '#signup') setMode('signup');
      else if (hash === '#forgot-password') setMode('forgot-password');
      else if (hash === '#resend-verification') setMode('resend-verification');
      else if (hash === '#login' || !hash) setMode('login');
      setVisible(false);setFeedback(null);
    };
    selectMode();
    const handoffQuery=new URLSearchParams(window.location.search),handoffErrors=handoffQuery.getAll('authError');
    if(handoffErrors.length){
      const code=handoffErrors.length===1?handoffErrors[0]:'';
      callbackFeedback.current={tone:'error',message:code==='cancelled'?'Google sign-in was cancelled. You can use email sign-in or deliberately try Google again.':code==='link_invalid'?'This sign-in or recovery link is invalid, expired or already used. Request a new link explicitly.':'Sign-in was not completed. Try the sign-in form or request a new link explicitly.'};
      setFeedback(callbackFeedback.current);returned.current=true;
      handoffQuery.delete('authError');const remaining=handoffQuery.toString();
      window.history.replaceState(null,'',`${window.location.pathname}${remaining?`?${remaining}`:''}${window.location.hash}`);
    }
    window.addEventListener('hashchange', selectMode);
    const readSession=async(expectedAccountId?:string,writeCurrent:()=>boolean=()=>true,explicit=false):Promise<boolean>=>{
      if(!alive.current||sessionController.current||(!expectedAccountId&&inFlight.current))return false;
      const controller=new AbortController(),epoch=++sessionEpoch.current;
      sessionController.current=controller;lastSessionCheck.current=Date.now();
      setCheckingSession(true);if(explicit)setFeedback({tone:'info',message:'Checking your current sign-in status…'});
      const current=()=>alive.current&&!controller.signal.aborted&&sessionEpoch.current===epoch&&writeCurrent();
      const deadline=setTimeout(()=>{if(current()){
        controller.abort();setLoading(false);setCheckingSession(false);setFeedback({tone:'error',message:'Account service is unavailable.'});
        if(expectedAccountId)clearSessionView();
        if(sessionController.current===controller)sessionController.current=null;
      }},15000);
      try{
        const response=await fetch('/api/account/session',{cache:'no-store',signal:controller.signal});
        const data=await response.json();if(!current())return false;
        if(!response.ok){
          if(response.status===401||response.status===403){const hadAccount=Boolean(currentAccount.current);clearSessionView();
            if(expectedAccountId)setFeedback({tone:'error',message:'Sign-in could not be confirmed. Please sign in again.'});
            else if(hadAccount)setFeedback({tone:'error',message:'Your session ended. Sign in again.'});
            else if(explicit)setFeedback({tone:'info',message:'You are signed out. Sign in, or open the latest verification or password-reset link in this browser.'});}
          else setFeedback({tone:'error',message:authFailure(response.status)});
          return false;
        }
        const session=publicSessionSchema.parse(data);
        if(expectedAccountId&&session.account.userId!==expectedAccountId){
          clearSessionView();setFeedback({tone:'error',message:'The signed-in account changed. Check the account before continuing.'});return false;
        }
        const changed=currentAccount.current?.userId!==session.account.userId;
        currentAccount.current=session.account;setAccount(session.account);setRecovery(session.passwordRecovery);
        if(changed||expectedAccountId){setFeedback(expectedAccountId?null:callbackFeedback.current);callbackFeedback.current=null;setReauthSeconds(0);reauthUntil.current=0;}
        if(explicit){callbackFeedback.current=null;const security=securityState.current;
          setFeedback({tone:session.passwordRecovery&&security?.status!=='ready'?'info':'success',message:session.passwordRecovery
            ?security?.status==='expired'?'The recovery window has expired. Sign out and restart recovery explicitly.'
              :security?.status==='ready'?'Password-recovery session verified. Choose a new password below.':'The recovery session still requires password-security verification below.'
            :'Your current sign-in is verified.'});}
        const destination=selectedPlanReturn(selected.current,session.account.userId,session.passwordRecovery);
        const sensitiveHandoff=['#forgot-password','#reset-password'].includes(window.location.hash);
        if(destination&&!returned.current&&!sensitiveHandoff){
          returned.current=true;try{clearCheckoutSelection(window.sessionStorage);}catch{/* Storage is optional. */}
          selected.current=null;setSelection(null);
          window.history.replaceState(null,'',window.location.pathname);
          replaceAccountLocation(destination);
        }
        return true;
      }catch{
        if(current()){if(expectedAccountId)clearSessionView();setFeedback({tone:'error',message:'Account service is unavailable.'});}
        return false;
      }finally{
        clearTimeout(deadline);if(current())setLoading(false);
        if(sessionController.current===controller){sessionController.current=null;if(alive.current)setCheckingSession(false);}
      }
    };
    restoreSession.current=readSession;void readSession();
    const optionsController=new AbortController(),optionsDeadline=setTimeout(()=>optionsController.abort(),10000);
    fetch('/api/account/auth-options',{cache:'no-store',signal:optionsController.signal}).then(async response=>{
      const data=await response.json();
      if(!alive.current||optionsController.signal.aborted)return;
      if(!response.ok||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||!['enabled','disabled','unavailable'].includes(data.google))throw new Error('Invalid options.');
      setGoogle(data.google);
    }).catch(()=>{if(alive.current&&!optionsController.signal.aborted)setGoogle('unavailable');}).finally(()=>clearTimeout(optionsDeadline));
    const checkOnReturn=()=>{
      if(document.visibilityState==='hidden'||inFlight.current||securityState.current?.status==='checking'||sessionController.current||Date.now()-lastSessionCheck.current<5000)return;
      void readSession();
    };
    const invalidate=(event:StorageEvent)=>{
      if(event.key!==ACCOUNT_SESSION_STORAGE_KEY)return;
      ++writeEpoch.current;writeController.current?.abort();writeController.current=null;
      if(writeDeadline.current!==null)clearTimeout(writeDeadline.current);
      writeDeadline.current=null;inFlight.current=false;setPendingAction(null);
      ++sessionEpoch.current;sessionController.current?.abort();sessionController.current=null;
      clearSessionView();setFeedback(null);setLoading(true);void readSession();
    };
    window.addEventListener('storage',invalidate);window.addEventListener('focus',checkOnReturn);
    window.addEventListener('pageshow',checkOnReturn);document.addEventListener('visibilitychange',checkOnReturn);
    return () => {
      alive.current = false;++sessionEpoch.current;++writeEpoch.current;sessionController.current?.abort();sessionController.current=null;
      optionsController.abort();clearTimeout(optionsDeadline);
      if(writeDeadline.current!==null)clearTimeout(writeDeadline.current);
      writeController.current?.abort();window.removeEventListener('hashchange', selectMode);
      window.removeEventListener('storage',invalidate);window.removeEventListener('focus',checkOnReturn);
      window.removeEventListener('pageshow',checkOnReturn);document.removeEventListener('visibilitychange',checkOnReturn);
    };
  }, []);
  async function submit(action: string, values: object = {}) {
    if(inFlight.current||securityState.current?.status==='checking'&&securityState.current.accountId===currentAccount.current?.userId||(emailAction(action)&&resendUntil.current>Date.now())
      ||(action==='google'&&google!=='enabled')||(action==='reauthenticate'&&reauthUntil.current>Date.now()))return;
    if('expectedAccountId' in values&&values.expectedAccountId!==currentAccount.current?.userId)return;
    if(['reset-password','change-password','reauthenticate'].includes(action)&&
      (securityState.current?.accountId!==currentAccount.current?.userId||securityState.current?.status!=='ready')){
      setFeedback({tone:'error',message:'Check password security and verify any required authenticator before submitting.'});return;
    }
    callbackFeedback.current=null;if(action==='login')returned.current=false;
    const failureNotice=['change-password','reset-password'].includes(action)?'Password update could not be confirmed. Do not repeat it automatically. Check sign-in with the new password or use the explicit recovery flow.':uncertainNotice;
    // A restoration read may not replace a newer explicit submission's feedback.
    ++sessionEpoch.current;sessionController.current?.abort();sessionController.current=null;
    setCheckingSession(false);
    const epoch=++writeEpoch.current,current=()=>alive.current&&writeEpoch.current===epoch;
    inFlight.current = true;setPendingAction(action);setLoading(false);
    setFeedback({tone:'info',message:verificationAction(action)?'Sending verification email…':'Please wait…'});
    const controller=new AbortController();writeController.current=controller;
    const deadline=setTimeout(()=>{
      controller.abort();if(current()){
        ++sessionEpoch.current;sessionController.current?.abort();sessionController.current=null;setCheckingSession(false);
        if(emailAction(action))startResendCooldown();
        setFeedback({tone:'error',message:failureNotice});setPendingAction(null);setVisible(false);
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
        if(response.status===429&&emailAction(action))startResendCooldown();
        if(action==='signup'&&response.status===409&&data?.code==='ACCOUNT_EXISTS'
          ||action==='login'&&response.status===403&&data?.code==='EMAIL_NOT_VERIFIED'){
          const next=action==='signup'?'login':'resend-verification';
          setMode(next);setVerificationReady(false);verificationEmail.current='';
          window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}#${next}`);
        }
        setFeedback({tone:'error',message:authFailure(response.status,action,data?.code)});
        if(['reset-password','change-password','reauthenticate'].includes(action)&&
          (data?.code==='MFA_REQUIRED'||response.status===401||data?.code==='RECOVERY_SESSION_REQUIRED'))refreshPasswordSecurity();
        return;
      }
      if(action==='google'){window.location.assign(safeGoogleRedirect(data));return;}
      if(action==='login'){
        const result=publicLoginSchema.parse(data);clearSessionView();
        const restored=await restoreSession.current(result.account.userId,()=>current()&&!controller.signal.aborted);
        if(current()&&restored){notifyAccountSessionChanged();verificationEmail.current='';setVerificationReady(false);resendUntil.current=0;setResendSeconds(0);}
        return;
      }
      if(action==='reauthenticate'){
        if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==2||data.ok!==true||data.message!==emailNotice)throw new Error('Invalid response.');
        reauthUntil.current=Date.now()+60000;setReauthSeconds(60);
        setFeedback({tone:'success',message:'Reauthentication email requested. Enter the latest code only if a password update requires it. No email is resent automatically.'});return;
      }
      if(action==='change-password'||action==='reset-password'){
        if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==3||data.ok!==true||typeof data.message!=='string'||typeof data.sessionsRevoked!=='boolean'
          ||Object.keys(data).some(key=>!['ok','message','sessionsRevoked'].includes(key)))throw new Error('Invalid response.');
        completeSignOut(data.sessionsRevoked?{tone:'success',message:'Password updated. Sign in again.'}
          :{tone:'error',message:'Your password was changed and this browser was signed out. Sign-out on other devices could not be confirmed. Do not repeat the password update; sign in with the new password and contact support.'});return;
      }
      if (action === 'logout') {
        if(data?.ok!==true||Object.keys(data).some(k=>!['ok','message'].includes(k)))throw new Error('Invalid response.');
        const restarting=restartRecovery.current;restartRecovery.current=false;
        completeSignOut(restarting?{tone:'info',message:'Request a new password-reset email explicitly, then open its latest link in this browser.'}:null);
        if(restarting){setMode('forgot-password');window.history.replaceState(null,'',`${window.location.pathname}#forgot-password`);}return;
      }
      if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||data.message!==emailNotice)throw new Error('Invalid response.');
      const email='email' in values?values.email:undefined,masked=maskedEmail(email);
      if(emailAction(action))startResendCooldown();
      if(emailAction(action)){
        verificationEmail.current=typeof email==='string'?email.trim():'';setVerificationReady(Boolean(masked));
      }
      setFeedback({tone:'success',message:action==='signup'?signupNotice:action==='resend-verification'?resendNotice
        :'If an account uses this email, you’ll receive a password-reset link.',maskedEmail:masked,
        detail:'Check your inbox and spam folder. Open the latest link in this browser.'});
    } catch { if (current()&&!controller.signal.aborted){if(emailAction(action))startResendCooldown();setFeedback({tone:'error',message:failureNotice});} }
    finally {
      if(action==='logout')restartRecovery.current=false;
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
  const passwordSecurityPanel=account?<AccountPasswordSecurity key={`password-security:${account.userId}:${recovery}`}accountId={account.userId}passwordRecovery={recovery}
    refresh={securityRefresh}disabled={baseBusy}onChange={securityChanged}onVerified={securityVerified}
    onRestartRecovery={()=>{if(!busy&&!inFlight.current){restartRecovery.current=true;void submit('logout',{expectedAccountId:account.userId});}}}/>:null;
  return <section className={`account-card${!account ? ' account-auth' : ''}`} aria-busy={busy}>
    {selection&&!recovery?<aside className="cluera-plan-handoff" aria-label="Selected Cluera plan">
      <p>Selected plan: <strong>{checkoutSelectionName(selection)}</strong></p>
      <p>Prices and availability are checked again on the server. Sign-in never starts a payment.</p>
      {account?<a className="button secondary" href={checkoutSelectionHref(selection)}>Continue to selected plan</a>:null}
    </aside>:null}
    {account ? <>
      <p>Signed in as <strong>{account.email}</strong></p>
      {!recovery ? <><h2>Your workspace</h2><AccountWorkspace key={`workspace:${account.userId}`}/>
        <details key={`security:${account.userId}`} className="account-security"><summary>Account security · Change password</summary>
          <p>After changing your password, sign in again with the new one.</p>
          {passwordSecurityPanel}
          <form aria-label="Change password" aria-describedby="account-auth-feedback" onSubmit={event=>{
            event.preventDefault();const form=event.currentTarget,data=new FormData(form);
            const currentPassword=String(data.get('currentPassword')??''),nonce=String(data.get('nonce')??'');
            const values={expectedAccountId:account.userId,password:String(data.get('password')??''),...(currentPassword?{currentPassword}:{}),...(nonce?{nonce}:{})};
            form.reset();void submit('change-password',values);
          }}>
            <label>Current password (when required)<input name="currentPassword" type="password" maxLength={MAX_PASSWORD_LENGTH} autoComplete="current-password" disabled={busy}/></label>
            <label>New password<input name="password" type="password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} autoComplete="new-password" required disabled={busy}/></label>
            <p>Use {MIN_PASSWORD_LENGTH}–{MAX_PASSWORD_LENGTH} characters. Strong passphrases are welcome.</p>
            <label>Reauthentication code (only if requested)<input name="nonce" type="text" inputMode="numeric" pattern="[0-9]{6,12}" minLength={6} maxLength={12} autoComplete="one-time-code" disabled={busy}/></label>
            <button className="button" type="submit" disabled={busy||!passwordReady}>{pendingAction==='change-password'?'Updating password…':'Change password and sign out'}</button>
          </form>
          <button className="button secondary" type="button" disabled={busy||!passwordReady||reauthSeconds>0}
            onClick={()=>void submit('reauthenticate',{expectedAccountId:account.userId})}>
            {reauthSeconds>0?`Request another code in ${reauthSeconds}s`:'Email a reauthentication code'}
          </button>
        </details></> : null}
      {recovery ? <>{passwordSecurityPanel}{recoveryExpired?<div><h2>Password recovery expired</h2><p>Request a new reset link to continue.</p></div>:<form key={account.userId} aria-describedby="account-auth-feedback" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget;
        const password = String(new FormData(form).get('password') ?? '');
        form.reset();void submit('reset-password', { password,expectedAccountId:account.userId });
      }}>
        <h2>Choose a new password</h2><p>{passwordReady?'Use at least 8 characters. You’ll sign in again after updating.':'Complete the security check above to continue.'}</p>
        <label>New password<input name="password" type="password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} autoComplete="new-password" required disabled={busy}/></label>
        <button className="button" type="submit" disabled={busy||!passwordReady}>Update password and sign out</button>
      </form>}</> : null}
      {feedbackRegion}
      <button className="button secondary" type="button" disabled={busy} onClick={() => void submit('logout',{expectedAccountId:account.userId})}>Sign out of this browser</button>
    </> : <>
      <div className="account-auth-heading"><div className="account-auth-brand" aria-hidden="true">C</div><span className="account-ui-kicker">CLUERA AI</span><span className="account-test-badge">Test workspace</span></div>
      <h2>{emailPending?'Check your email':mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create an account' : mode==='resend-verification'?'Verify your email':'Reset your password'}</h2>
      {!emailPending?<p className="account-auth-description">{mode === 'signup' ? 'One account for Cluera on the web and desktop.' : mode === 'forgot-password' ? 'Enter your email and we’ll help you reset your password.' : mode==='resend-verification'?'Send a new verification link to finish creating your account.':'Welcome back to Cluera.'}</p>:null}
      {!emailPending&&!emailOnly&&google==='enabled'?<><button className="button secondary" type="button" disabled={busy} onClick={() => void submit('google')}>Continue with Google</button><div className="account-auth-divider"><span>or continue with email</span></div></>:null}
      {!emailPending?<form key={mode} aria-describedby="account-auth-feedback" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
        const values={email:String(data.get('email')??''),...(!emailOnly?{password:String(data.get('password')??'')}:{})};
        setEmailDraft(values.email);
        const password=form.elements.namedItem('password');if(password instanceof HTMLInputElement)password.value='';
        void submit(mode,values);
      }}>
        <label>Email<input name="email" type="email" maxLength={254} autoComplete="email" defaultValue={emailDraft} onChange={event=>setEmailDraft(event.target.value)} required disabled={busy}/></label>
        {!emailOnly ? <label>Password<span className="account-auth-password"><input key={mode} aria-label="Password" name="password" type={visible ? 'text' : 'password'} minLength={mode === 'signup' ? MIN_PASSWORD_LENGTH : 1} maxLength={MAX_PASSWORD_LENGTH}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required disabled={busy}/><button type="button" disabled={busy} aria-pressed={visible} aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(value => !value)}>{visible ? 'Hide' : 'Show'}</button></span></label> : null}
        {mode === 'signup' ? <p className="account-auth-hint">Use at least {MIN_PASSWORD_LENGTH} characters.</p> : null}
        <button className="button" type="submit" disabled={busy||emailCoolingDown}>{busy ? verificationAction(pendingAction??'')?'Sending verification email…':'Please wait…'
          : emailCoolingDown?`Try again in ${resendSeconds}s`:mode === 'login' ? 'Sign in' : mode === 'signup'?'Create account':mode==='resend-verification' ? 'Send verification email' : 'Send reset link'}</button>
      </form>:null}
      {feedbackRegion}
      {emailPending?<div className="account-auth-resend">
        <button className="button secondary" type="button" data-resend-verification={verificationAction(mode)||undefined} disabled={busy||resendSeconds>0}
          onClick={()=>void submit(mode==='forgot-password'?'forgot-password':'resend-verification',{email:verificationEmail.current})}>
          {resendSeconds>0?`Resend link in ${resendSeconds}s`:'Resend link'}
        </button><button className="account-text-button" type="button" disabled={busy} onClick={()=>chooseMode(mode)}>Use a different email</button>
      </div>:null}
      <div className="account-actions">{mode==='login'?<><button type="button" disabled={busy} onClick={()=>chooseMode('signup')}>Create account</button><button type="button" disabled={busy} onClick={()=>chooseMode('forgot-password')}>Forgot password?</button></>
        :<button type="button" disabled={busy} onClick={()=>chooseMode('login')}>Back to sign in</button>}</div>
    </>}
    <AccountAuthHelp signedIn={Boolean(account)} recovery={recovery} busy={busy} checking={checkingSession}
      onCheckStatus={()=>void restoreSession.current(undefined,()=>true,true)} onVerifyEmail={()=>chooseMode('resend-verification')}/>
  </section>;
}
