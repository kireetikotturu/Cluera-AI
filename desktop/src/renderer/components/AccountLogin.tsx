import {ArrowRight, Eye, EyeOff, X} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import type {AccountAuthOptions, AccountView, AccountWebAction} from '../../shared/accounts';
import {SupportDialog} from './SupportDialog';
import clueraLogo from '../assets/cluera-ai.svg';

/** Google's "G", in its standard colours. */
function GoogleLogo():JSX.Element {
  return <svg className="google-g" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>;
}

/** Credentials live only in this form; main still owns all authentication. */
export function AccountLogin({state,onState}:{state:AccountView;onState(state:AccountView):void}):JSX.Element {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [visible,setVisible]=useState(false),[operation,setOperation]=useState('');
  const [supportOpen,setSupportOpen]=useState(false);
  const [google,setGoogle]=useState<AccountAuthOptions['google']|'checking'>('checking');
  const working=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let current=true;
    void (async()=>{
      try { const options=await window.accountAPI!.authOptions(); if(current)setGoogle(options.google==='enabled'?'enabled':options.google==='disabled'?'disabled':'unavailable'); }
      catch { if(current)setGoogle('unavailable'); }
    })();
    return()=>{current=false;};
  },[]);
  const run=async(label:string,action:()=>Promise<AccountView>)=>{
    if(working.current||state.state==='checking')return;
    working.current=true;setBusy(true);setOperation(label);setError('');
    try{const result=await action();if(mounted.current)onState(result);}
    catch{if(mounted.current)setError('Account request could not be completed. Check your connection.');}
    finally{working.current=false;if(mounted.current){setBusy(false);setPassword('');setVisible(false);setOperation('');}}
  };
  const web=async(action:AccountWebAction)=>{
    if(working.current)return;
    try{await window.accountAPI!.openWeb(action);}
    catch{if(mounted.current)setError('Could not open the account website.');}
  };
  const locked=busy||state.state==='checking';
  const waitingForGoogle=busy&&operation==='Waiting for Google…';
  const googleNote=google==='disabled'?'Google sign-in is not enabled. Use your email and password.'
    :google==='unavailable'?'Google sign-in is temporarily unavailable. Use your email and password.':'';
  return <main className="account-login">
    <header className="account-login-bar"><span><img className="account-login-logo" src={clueraLogo} alt=""/>Cluera AI</span>
      <button type="button" aria-label="Close Cluera AI" onClick={()=>void window.electronAPI.closeWindow()}><X size={18}/></button></header>
    <div className="account-login-scroll">
      <section className="account-login-card" aria-labelledby="account-login-title" aria-busy={locked}>
        <img className="signin-logo" src={clueraLogo} alt=""/>
        <h1 id="account-login-title">Welcome back</h1>
        <p className="signin-sub">Sign in to your Cluera AI account.</p>
        <button type="button" className="account-google" disabled={locked||google!=='enabled'} aria-describedby={googleNote?'account-google-status':undefined} onClick={()=>void run('Waiting for Google…',()=>window.accountAPI!.google())}><GoogleLogo/>{waitingForGoogle?'Waiting for Google…':'Continue with Google'}</button>
        {googleNote&&<p id="account-google-status" className="account-auth-note">{googleNote}</p>}
        <div className="account-auth-divider"><span>or use your email</span></div>
        <form onSubmit={event=>{event.preventDefault();void run('Signing in…',()=>window.accountAPI!.login({email,password}));}}>
          <label className="signin-field"><span>Email address</span><input type="email" required maxLength={254} autoComplete="username" value={email} onChange={event=>setEmail(event.target.value)} disabled={locked} placeholder="you@example.com"/></label>
          <label className="signin-field"><span>Password</span><span className="account-password"><input type={visible?'text':'password'} required maxLength={128} autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} disabled={locked}/>
            <button type="button" disabled={locked} aria-label={visible?'Hide password':'Show password'} aria-pressed={visible} onClick={()=>setVisible(value=>!value)}>{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button></span></label>
          <button className="signin-submit" disabled={locked}>{busy&&!waitingForGoogle?operation:state.state==='checking'?'Checking saved session…':'Sign in'}<ArrowRight size={16}/></button>
        </form>
        <p role="status" className="signin-message">{error||state.message}</p>
        <div className="account-auth-links"><button disabled={locked} onClick={()=>void web('signup')}>Create account</button><button disabled={locked} onClick={()=>void web('reset-password')}>Forgot password?</button></div>
        <div className="signin-footer"><button type="button" className="account-retry" disabled={locked} onClick={()=>void run('Restoring session…',()=>window.accountAPI!.retry())}>Retry saved session</button>
          <span aria-hidden="true">·</span><button type="button" className="account-retry" onClick={()=>setSupportOpen(true)}>Contact support</button></div>
        <p className="account-auth-note">Sign-up and password reset open in your browser.</p>
      </section>
    </div>
    {supportOpen&&<SupportDialog onClose={()=>setSupportOpen(false)}/>}
  </main>;
}
