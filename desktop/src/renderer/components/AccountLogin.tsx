import {ArrowRight, Eye, EyeOff, ShieldCheck, X} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import type {AccountAuthOptions, AccountView, AccountWebAction} from '../../shared/accounts';
import {SupportDialog} from './SupportDialog';

/** Credentials live only in this form; main still owns all authentication. */
export function AccountLogin({state,onState}:{state:AccountView;onState(state:AccountView):void}):JSX.Element {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [visible,setVisible]=useState(false),[operation,setOperation]=useState('');
  const [supportOpen,setSupportOpen]=useState(false);
  const [google,setGoogle]=useState<AccountAuthOptions['google']>('unavailable');
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
  return <main className="account-login">
    <header className="account-login-bar"><span><b aria-hidden="true">Σ</b>Cluera AI <small>TEST</small></span>
      <button type="button" aria-label="Close Cluera AI" onClick={()=>void window.electronAPI.closeWindow()}><X size={18}/></button></header>
    <div className="account-login-scroll">
      <section className="activation-card account-login-card" aria-labelledby="account-login-title" aria-busy={locked}>
        <span className="account-auth-icon" aria-hidden="true"><ShieldCheck size={26}/></span>
        <p className="eyebrow">YOUR INTERVIEW WORKSPACE</p><h1 id="account-login-title">Welcome back.</h1>
        <p className="activation-copy">Sign in to Cluera AI with your verified email. Your credits stay in sync across devices.</p>
        <form onSubmit={event=>{event.preventDefault();void run('Signing in…',()=>window.accountAPI!.login({email,password}));}}>
          <label className="activation-field"><span>Email address</span><input type="email" required maxLength={254} autoComplete="username" value={email} onChange={event=>setEmail(event.target.value)} disabled={locked} placeholder="you@example.com"/></label>
          <label className="activation-field"><span>Password</span><span className="account-password"><input type={visible?'text':'password'} required maxLength={128} autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} disabled={locked}/>
            <button type="button" disabled={locked} aria-label={visible?'Hide password':'Show password'} aria-pressed={visible} onClick={()=>setVisible(value=>!value)}>{visible?<EyeOff size={17}/>:<Eye size={17}/>}</button></span></label>
          <button className="primary activation-submit" disabled={locked}>{busy?operation:state.state==='checking'?'Checking saved session…':'Sign in'}<ArrowRight size={17}/></button>
        </form>
        <p role="status" className="activation-message">{error||state.message}</p>
        <div className="account-auth-divider"><span>or continue securely</span></div>
        <button className="ghost account-google" disabled={locked||google!=='enabled'} aria-describedby={google!=='enabled'?'account-google-status':undefined} onClick={()=>void run('Waiting for Google…',()=>window.accountAPI!.google())}>Continue with Google</button>
        {google!=='enabled'&&<p id="account-google-status" className="account-auth-note">{google==='disabled'?'Google sign-in is not enabled. Use your email and password.':'Google sign-in is temporarily unavailable. Use your email and password.'}</p>}
        <div className="account-auth-links"><button disabled={locked} onClick={()=>void web('signup')}>Create account</button><button disabled={locked} onClick={()=>void web('reset-password')}>Forgot password?</button></div>
        <div className="account-auth-links"><button className="account-retry" disabled={locked} onClick={()=>void run('Restoring session…',()=>window.accountAPI!.retry())}>Retry saved session</button>
          <button type="button" className="account-retry" onClick={()=>setSupportOpen(true)}>Contact support</button></div>
        <p className="account-auth-note">Account creation, email verification and recovery open in your browser. AI credentials stay on the server.</p>
      </section>
      <p className="account-login-footnote">Isolated Cluera TEST edition · not a production release</p>
    </div>
    {supportOpen&&<SupportDialog onClose={()=>setSupportOpen(false)}/>}
  </main>;
}
