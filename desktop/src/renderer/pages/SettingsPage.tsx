import {CheckCircle2, Database, ShieldCheck} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import type {UpdateStatus} from '../../shared/types';
import type {AccountView} from '../../shared/accounts';
import {UpdatesSection} from '../components/UpdatesSection';
import {AccountContextSection} from '../components/AccountContextSection';
import {AccountCreditsSection} from '../components/AccountCreditsSection';
import {useAppStore} from '../stores/appStore';

export function SettingsPage({onUpdateStatus,account}:{onUpdateStatus?(status:UpdateStatus):void;account:AccountView}):JSX.Element {
 const provider=useAppStore(s=>s.providerStatus),settings=useAppStore(s=>s.settings);
 const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
 const running=useRef(false),epoch=useRef(0),timer=useRef<ReturnType<typeof setTimeout>>();
 useEffect(()=>{
  const current=++epoch.current;
  void window.electronAPI.getProviderStatus().then(status=>{
   if(epoch.current===current)useAppStore.getState().setProviderStatus(status);
  }).catch(()=>{if(epoch.current===current)useAppStore.getState().setError('Could not load the approved model catalog.');});
  return()=>{epoch.current++;clearTimeout(timer.current);};
 },[account.userId]);
 const save=async(modelId?:string)=>{
  if(running.current)return;running.current=true;setBusy(true);setSaved(false);
  const current=epoch.current;
  try{
   const draft=useAppStore.getState().settings;if(!draft)throw Error();
   const next=await window.electronAPI.saveSettings({...draft,...(modelId===undefined?{}:{geminiModel:modelId})});
   if(epoch.current!==current)return;
   useAppStore.getState().setSettings(next);setSaved(true);
   const status=await window.electronAPI.getProviderStatus();
   if(epoch.current===current)useAppStore.getState().setProviderStatus(status);
   clearTimeout(timer.current);timer.current=setTimeout(()=>{if(epoch.current===current)setSaved(false);},1600);
  }catch{if(epoch.current===current)useAppStore.getState().setError('Settings could not be saved. Your previous configuration is retained.');}
  finally{running.current=false;if(epoch.current===current)setBusy(false);}
 };
 if(!settings)return <main className="page"><p role="status">Loading Cluera preferences.</p></main>;
 const setSettings=useAppStore.getState().setSettings;
 return <main className="page settings-page">
  <div className="page-heading"><div><p className="eyebrow">Your workspace</p><h1>Settings</h1><p>Account-managed AI. Your history stays on this device.</p></div>
   <button className="primary" disabled={busy} onClick={()=>void save()}>{saved?<CheckCircle2 size={16}/>:null}{busy?'Saving…':saved?'Saved':'Save appearance'}</button></div>
  <UpdatesSection onStatus={onUpdateStatus}/>
  <AccountCreditsSection userId={account.userId}/>
  <AccountSettings account={account}/>
  <section className="settings-section"><h2>Managed AI models</h2><p>Cluera supplies provider access securely. No personal keys or BYOK fallback.</p>
   <label>Approved answer model <select aria-label="Approved answer model" value={settings.geminiModel??provider?.defaultGeminiModel??''} disabled={busy||!provider?.modelOptions?.length} onChange={event=>void save(event.target.value)}>
    {!provider?.modelOptions?.some(model=>model.modelId===settings.geminiModel)&&<option value={settings.geminiModel??''}>Choose an approved model</option>}
    {(provider?.modelOptions??[]).map(model=><option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}
   </select></label><p className="muted">Audio uses the server-approved Flux model. Availability and shared account time are enforced by the server.</p></section>
  <AccountContextSection key={account.userId}/>
  <section className="settings-section"><div className="settings-title"><ShieldCheck size={19}/><div><h2>Appearance</h2><p>Adjust your workspace without changing provider or entitlement policy.</p></div></div>
   <fieldset disabled={busy} className="setting-rows"><legend className="sr-only">Workspace appearance</legend>
    <label><span>Theme<small>Choose your preferred color scheme.</small></span><select aria-label="Theme" value={settings.theme} onChange={event=>setSettings({...settings,theme:event.target.value as typeof settings.theme})}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label>
    <label><span>Window opacity · {Math.round(settings.overlayOpacity*100)}%<small>Applies after Save. Drag the title bar and resize from the edges.</small></span><input aria-label="Window opacity" type="range" min="35" max="100" value={Math.round(settings.overlayOpacity*100)} onChange={event=>setSettings({...settings,overlayOpacity:Number(event.target.value)/100})}/></label>
    {provider?.development?<label><span>Developer diagnostics<small>Development-only latency measurements.</small></span><button type="button" role="switch" aria-checked={settings.debugMode} aria-label="Developer diagnostics" className={settings.debugMode?'switch on':'switch'} onClick={()=>setSettings({...settings,debugMode:!settings.debugMode})}><i/></button></label>:null}
   </fieldset></section>
  <section className="settings-section"><div className="settings-title"><Database size={19}/><div><h2>Local data</h2><p>Sessions, selected context, transcripts and answers use your isolated local SQLite workspace.</p></div></div><div className="database-path"><code>{provider?.databasePath}</code></div>
   <p className="muted">Deleting a session removes its related local documents, chunks, transcript, questions, answers and events. Existing SigmaRound installations and profiles are not migrated automatically.</p></section>
 </main>;
}
function AccountSettings({account}:{account:AccountView}):JSX.Element {
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const running=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const signOut=async(all:boolean)=>{
  if(running.current)return;running.current=true;setBusy(true);setMessage('');
  try{await window.accountAPI!.logout(all);}
  catch{if(mounted.current)setMessage('Sign-out could not be confirmed. Retry when online.');}
  finally{running.current=false;if(mounted.current)setBusy(false);}
 };
 return <section className="settings-section"><h2>Your account</h2><p>{account.email}</p><p className="muted">Your account and cloud usage balance are retained from Account Edition. Cluera does not create a second trial.</p>
  <div className="credential-actions"><button className="ghost" disabled={busy} onClick={()=>void window.accountAPI!.openWeb('dashboard').catch(()=>{if(mounted.current)setMessage('Could not open the account website.');})}>Account dashboard</button>
  <button className="ghost" disabled={busy} onClick={()=>void signOut(false)}>Sign out this device</button><button className="ghost danger" disabled={busy} onClick={()=>void signOut(true)}>Sign out all devices</button></div><p role="status">{message}</p></section>;
}
