'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {usageDuration} from '../../../lib/usage/display';
import type {ModelPolicy} from './ModelPolicyEditor';
import {AiModels} from './AiModels';
import {AiQuickSetup} from './AiQuickSetup';
import {SessionDefaults} from './SessionDefaults';
import {AccountReleases} from './AccountReleases';
import {PaymentReadiness} from './PaymentReadiness';
import {AdminPlans} from './AdminPlans';
import {FinancialReports} from './FinancialReports';
import {useUsageReport,UsageOverviewPanel,UsageDetailPanel} from './CustomerUsage';
import {AiCosts} from './AiCosts';
import {AdminData} from './AdminData';
import {adminReadError} from '../../../lib/accounts/adminReadErrors';
import {useAdminAccessRecheck} from '../AdminRoleNavigation';
import {InfinityIcon,UnlimitedBadge,unlimitedUntil,type UnlimitedAccess} from '../Unlimited';
import '../account-ui.css';
import './admin-navigation.css';
type Factor={id:string;status:string};
interface State {needsMfa?:boolean;factors?:Factor[];testEntitlementsEnabled?:boolean;
 adminUserId?:string;
 users?:Array<{userId:string;email:string;emailVerified?:boolean;state:string;createdAt?:string;unlimited?:UnlimitedAccess}>;grants?:Array<{id:string;kind:string;state:string;grantedMilliseconds:number;spentMilliseconds:number;reservedMilliseconds?:number;testGrant:boolean;adminAdjustment?:boolean;counted?:boolean}>;
 balances?:Partial<Record<'TRIAL'|'RECURRING'|'PACK',number>>;trial?:{registered:boolean;remainingMilliseconds:number}|null;
 plans?:Array<{tier:string;state:string;paymentState:string;endsAt:string|null;cancelFuture:boolean;remainingMilliseconds:number|null;graceUntil:string|null}>;
 sessions?:Array<{id:string;startedAt:string;state:string}>;billing?:Array<{id:string;offerCode:string;state:string;createdAt:string;transactionId:string|null}>;
 catalog?:Array<{code:string;name:string;enabled:boolean;priority:number;priceId:string;amount:string;currency:string;seconds:number;interval:string|null}>;
 audit?:Array<{id:string;action:string;reason:string;createdAt:string}>;
 models?:ModelPolicy[];
}
type Tab='overview'|'plans'|'ai'|'costs'|'customers'|'data'|'payments'|'updates'|'history';
export function AccountAdmin({liveBillingAdmin=false}:{liveBillingAdmin?:boolean}){
 const recheckAccess=useAdminAccessRecheck();
 const [state,setState]=useState<State|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[subject,setSubject]=useState('');
 const [enrollment,setEnrollment]=useState<{id:string;qr:string;secret:string}|null>(null),[factorId,setFactorId]=useState('');
 const [pendingMutation,setPendingMutation]=useState<object|null>(null);
 const [loading,setLoading]=useState(false);
 const [query,setQuery]=useState('');
 const [auditQuery,setAuditQuery]=useState(''),[observedAt,setObservedAt]=useState('');
 const [tab,setTab]=useState<Tab>('overview');
 const usage=useUsageReport(tab==='customers'&&Boolean(state)&&!state?.needsMfa,subject);
 const running=useRef(false),alive=useRef(true),reading=useRef<AbortController|null>(null),readVersion=useRef(0);
 const pendingOperation=useRef<object|null>(null);
 const pendingUncertain=useRef(false);
 const releaseLock=useRef(false),[releaseLocked,setReleaseLocked]=useState(false);
 const releaseLockChanged=useCallback((value:boolean)=>{releaseLock.current=value;if(alive.current)setReleaseLocked(value);},[]);
 async function load(id=subject,search=query,cursor?:{createdAt:string;userId:string}){
  if(releaseLock.current)return;
  reading.current?.abort();
  const controller=new AbortController(),version=++readVersion.current;
  reading.current=controller;setLoading(true);setMessage('');
  let failureStatus=503;
  try{
   const params=new URLSearchParams();if(id)params.set('subject',id);else if(search)params.set('query',search);
   if(cursor){params.set('before',cursor.createdAt);params.set('beforeId',cursor.userId);}
   const response=await fetch(`/api/account/admin${params.size?`?${params}`:''}`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
   if(!response.ok){failureStatus=response.status;throw new Error();}
   const data=await response.json();
   if(alive.current&&version===readVersion.current&&!controller.signal.aborted){setState(data);setSubject(data.needsMfa?'':id);setObservedAt(new Date().toLocaleTimeString());}
  }catch{
   if(alive.current&&version===readVersion.current&&!controller.signal.aborted){
    setState(null);setSubject('');setMessage(adminReadError(failureStatus));
   }
  }finally{
   if(version===readVersion.current){reading.current=null;if(alive.current)setLoading(false);}
  }
 }
 useEffect(()=>{alive.current=true;void load('');return()=>{alive.current=false;++readVersion.current;reading.current?.abort();reading.current=null;};},[]);
 async function action(body:object){
  if(releaseLock.current||running.current||reading.current||(pendingOperation.current&&pendingOperation.current!==body))return;
  running.current=true;setBusy(true);setMessage('');
  try{
   const response=await fetch('/api/account/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   const data=await response.json();
   if(!response.ok){
    // Only the FIRST, definitely rejected attempt can be safely edited. Once a
    // response was lost, a later auth/rate/validation rejection says nothing
    // about that original transaction, so retain its exact operation UUID.
    const rejectedBeforeWrite=[400,401,403,413,429].includes(response.status);
    const rejectedByTransaction=response.status===409&&['INVALID','INSUFFICIENT_UNUSED','NOT_FOUND','FORBIDDEN','CAPACITY'].includes(data?.code);
    if('operationId' in body&&!pendingUncertain.current&&(rejectedBeforeWrite||rejectedByTransaction)){
     pendingOperation.current=null;pendingUncertain.current=false;
     if(alive.current){setPendingMutation(null);setMessage('That change was not accepted. Check the values and try again.');}
     return;
    }
    throw new Error();
   }
   if('operationId' in body&&data?.code!=='APPLIED')throw new Error();
   if(!alive.current)return;
   if('operationId' in body){pendingOperation.current=null;pendingUncertain.current=false;setPendingMutation(null);}
   if('action' in body&&body.action==='MFA_VERIFY'){
    if(data?.ok!==true||Object.keys(data).length!==1)throw new Error();
    // Refresh the role fence immediately. A later focus must not be the first
    // assurance check after new privileged controls have become actionable.
    recheckAccess();
   }
   if(data.enrollment){setEnrollment(data.enrollment);setFactorId(data.enrollment.id);}
   else{setEnrollment(null);await load();usage.refresh();}
  }catch{if('operationId' in body)pendingUncertain.current=true;if(alive.current)setMessage('That change did not go through. Check the page, then try again.');}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const mutate=(kind:string,input:object,reason:string,id:string|null=subject||null)=>{
  if(releaseLock.current||pendingOperation.current||running.current||reading.current)return;
  const body={action:kind,operationId:crypto.randomUUID(),subjectId:id,reason,input};
  pendingOperation.current=body;pendingUncertain.current=false;setPendingMutation(body);void action(body);
 };
 const factors=state?.factors??[];
 // SVG is rendered as an image data URL, never executable inline HTML.
 const qr=enrollment?.qr.startsWith('<svg')?`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrollment.qr)}`:enrollment?.qr.startsWith('data:image/svg+xml')?enrollment.qr:undefined;
 const parentLocked=busy||loading||Boolean(pendingMutation),locked=parentLocked||releaseLocked;
 const select=(id:string)=>{if(!releaseLock.current&&!running.current&&!pendingOperation.current)void load(id);};
 // Jump links must also open a closed "Advanced" area that holds their target. No data is read or changed.
 const revealTarget=(event:React.MouseEvent)=>{
  const link=(event.target as HTMLElement).closest('a[href^="#"]');if(!link)return;
  for(let node=document.getElementById(link.getAttribute('href')!.slice(1))?.parentElement;node;node=node.parentElement)if(node instanceof HTMLDetailsElement)node.open=true;
 };
 return <section className="account-card account-admin-shell" aria-busy={busy||loading}>
 <div className="account-admin-top"><a href="/account">← Your account</a><span>Admin · protected by your authenticator</span></div>
 <p role="status" className="account-admin-status">{loading?'Loading verified account details…':message|| (observedAt?`Up to date as of ${observedAt}.`:'Getting things ready…')}</p>
 {!state&&!loading?<button disabled={busy||Boolean(pendingMutation)} onClick={()=>select('')}>Refresh account administration</button>:null}
 {pendingMutation?<p className="account-admin-lock-summary">Saving your change… <button disabled={busy} onClick={()=>void action(pendingMutation)}>Try again</button></p>:null}
 {state?.needsMfa?<div className="account-admin-mfa"><p className="account-ui-kicker">SECURE ACCESS</p><h2>Authenticator verification</h2><p>Complete your existing authenticator challenge to access Account controls.</p>
  {enrollment?<><img src={qr} alt="Authenticator setup QR code" width={240} height={240}/><details><summary>Enter setup key manually</summary><code>{enrollment.secret}</code></details></>:null}
  {factors.length?<label>Authenticator<select value={factorId} onChange={event=>setFactorId(event.target.value)}><option value="">Choose authenticator</option>{factors.map((factor,i)=><option key={factor.id} value={factor.id}>Authenticator {i+1} · {factor.status}</option>)}</select></label>:!enrollment?<button className="button" disabled={busy} onClick={()=>void action({action:'MFA_ENROLL'})}>Enroll authenticator</button>:null}
  {(factorId||enrollment)?<form onSubmit={event=>{event.preventDefault();const form=event.currentTarget;void action({action:'MFA_VERIFY',factorId:enrollment?.id??factorId,code:String(new FormData(form).get('code')??'')});form.reset();}}><label>Six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy}/></label><button className="button" disabled={busy}>Verify</button></form>:null}
  {(enrollment||factors.find(f=>f.id===factorId)?.status==='unverified')?<button disabled={busy} onClick={()=>void action({action:'MFA_CANCEL',factorId:enrollment?.id??factorId})}>Cancel unfinished setup</button>:null}
  <p>Setup keys exist only in this page’s memory. Refresh never creates another factor; cancel unfinished setup explicitly before enrolling again.</p>
 </div>:state?<>
  <nav className="admin-tabs" role="tablist" aria-label="Admin sections">{([['overview','Overview'],['plans','Plans & pricing'],['ai','AI models & keys'],['costs','AI costs'],['customers','Customers'],['data','Data'],['payments','Payments'],['updates','App updates'],['history','History']] as [Tab,string][]).map(([id,name])=>
   <button key={id} type="button" role="tab" aria-selected={tab===id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{name}</button>)}</nav>
  {releaseLocked&&!pendingMutation?<p role="status" className="account-admin-lock-summary">An app update change is waiting for confirmation. Finish it in App updates first.</p>:null}

  <div hidden={tab!=='overview'}><section className="account-admin-section admin-overview" aria-labelledby="admin-overview-heading">
   <p className="account-ui-kicker">OVERVIEW</p><h2 id="admin-overview-heading">Welcome back</h2>
   <div className="admin-stat-grid">
    <button type="button" className="admin-stat" onClick={()=>setTab('plans')}><strong>Plans &amp; pricing</strong><span>Add, edit, turn on/off or remove the time packs customers buy.</span></button>
    <button type="button" className="admin-stat" onClick={()=>setTab('ai')}><strong>{state.models?.filter(m=>m.enabled).length??0} AI models on</strong><span>Gemini, ChatGPT, Claude and Deepgram models and keys.</span></button>
    <button type="button" className="admin-stat" onClick={()=>setTab('costs')}><strong>AI costs</strong><span>What the AI costs you: by model, customer and session.</span></button>
    <button type="button" className="admin-stat" onClick={()=>setTab('customers')}><strong>{state.users?.length??0} recent customers</strong><span>Add or remove time, give unlimited access, block accounts.</span></button>
    <button type="button" className="admin-stat" onClick={()=>setTab('data')}><strong>Data</strong><span>Résumés customers used in sessions.</span></button>
    <button type="button" className="admin-stat" onClick={()=>setTab('payments')}><strong>Payments</strong><span>See recent purchases and unfinished checkouts.</span></button>
   </div>
   <div id="account-admin-start-payments"><PaymentReadiness disabled={locked}/></div>
  </section></div>

  <div hidden={tab!=='plans'}><section id="account-admin-billing" className="account-admin-section" aria-label="Plans and pricing">
   {liveBillingAdmin?<AdminPlans disabled={locked}/>:<div className="ai-provider-console"><p className="account-ui-kicker">PLANS</p><h2>Plans customers can buy</h2><p>Plans appear here once real payments are switched on.</p></div>}
  </section></div>

  <div hidden={tab!=='ai'}>
   <section id="account-admin-models" className="account-admin-section" aria-label="AI models"><AiModels models={state.models??[]} disabled={locked}
    onSave={(policy,reason)=>mutate('MODEL',policy,reason,null)} onDelete={(modelId,reason)=>mutate('MODEL_DELETE',{modelId},reason,null)}/></section>
   <section id="account-admin-session-defaults" className="account-admin-section" aria-label="Session defaults"><SessionDefaults models={state.models??[]} disabled={locked} refreshKey={state}
    onSave={(values,reason)=>mutate('SESSION_DEFAULTS',values,reason,null)}/></section>
   <section id="admin-ai-keys" className="account-admin-section" aria-label="AI keys"><AiQuickSetup disabled={locked} models={state.models} active={tab==='ai'} onApplied={()=>void load()}/></section>
  </div>

  <div hidden={tab!=='costs'}><AiCosts active={tab==='costs'} onOpenCustomer={id=>{setTab('customers');select(id);}}/></div>

  <div hidden={tab!=='customers'}><section id="account-admin-users" className="account-admin-section" aria-labelledby="account-admin-users-heading"><div className="account-admin-section-heading"><div><p className="account-ui-kicker">CUSTOMERS</p><h2 id="account-admin-users-heading">Customers</h2></div><button disabled={busy||Boolean(pendingMutation)||releaseLocked} onClick={()=>select('')}>Show recent</button></div>
  <UsageOverviewPanel report={usage.overview} error={usage.error} loading={usage.loading} updatedAt={usage.updatedAt} onRefresh={usage.refresh} onSelect={select} selected={subject} disabled={locked}/>
  <form className="admin-search" onSubmit={event=>{event.preventDefault();if(!running.current&&!pendingOperation.current)void load('',query);}}><label>Email or account ID<input value={query} onChange={event=>setQuery(event.target.value)} maxLength={254} disabled={locked} placeholder="name@example.com"/></label><button className="button" disabled={locked}>Search</button></form>
  <ul className="account-admin-users">{state.users?.map(user=><li key={user.userId} className={subject===user.userId?'selected':''}><button disabled={busy||Boolean(pendingMutation)||releaseLocked} onClick={()=>select(user.userId)}>{user.email}</button><span className={user.state==='ACTIVE'?'tag-on':'tag-off'}>{user.state==='ACTIVE'?'Active':'Blocked'}</span>{user.unlimited?<UnlimitedBadge/>:null}{user.emailVerified?<span>Verified</span>:null}</li>)}</ul>
  {!state.users?.length?<p className="account-admin-empty">No customers found. Try their exact email address.</p>:null}
  {!subject&&state.users?.length===50&&state.users[49].createdAt?<button disabled={locked} onClick={()=>void load('',query,{createdAt:state.users![49].createdAt!,userId:state.users![49].userId})}>Next page</button>:null}
  <fieldset disabled={locked} style={{border:0,padding:0,margin:0}}>
  {subject?<div className="account-admin-detail"><h3>{state.users?.find(u=>u.userId===subject)?.email??'Customer'}</h3><p className="admin-note">Account ID: {subject}</p>
   <div className="admin-stat-grid compact">
    {(()=>{const access=state.users?.find(u=>u.userId===subject)?.unlimited;return access?<div className="admin-stat"><strong><UnlimitedBadge large/></strong><span>{unlimitedUntil(access.endsAt)}</span></div>:null;})()}
    <div className="admin-stat"><strong>{usageDuration(state.trial?.remainingMilliseconds??state.balances?.TRIAL??0)}</strong><span>Free trial left</span></div>
    <div className="admin-stat"><strong>{usageDuration(state.balances?.PACK??0)}</strong><span>Purchased / added time</span></div>
    <div className="admin-stat"><strong>{usageDuration(state.balances?.RECURRING??0)}</strong><span>Monthly plan time</span></div>
   </div>
   <UsageDetailPanel detail={usage.detail}/>
   {state.plans?.length?<><h4>Monthly plans</h4>{state.plans.map((plan,i)=><p key={i}>{plan.tier} · {plan.state}{plan.endsAt?` · ends ${new Date(plan.endsAt).toLocaleDateString()}`:''}{plan.cancelFuture?' · cancelling':''}</p>)}</>:null}
   {state.billing?.length?<><h4>Purchases</h4>{state.billing.map(item=><p key={item.id}>{item.offerCode} · {item.state} · {new Date(item.createdAt).toLocaleString()}</p>)}</>:null}
   <h4>Change this account</h4>
   {(()=>{const account=state.users?.find(u=>u.userId===subject),blocked=(account?.state??'ACTIVE')!=='ACTIVE',access=account?.unlimited;return <>
   <form key={`time-${subject}`} className="admin-model-form" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);const kind=String(values.get('action'));mutate(kind,{minutes:Number(values.get('minutes'))},String(values.get('reason')));}}>
    <label>Time<select name="action" disabled={busy}><option value="ADD_MINUTES">Add minutes (never expire)</option><option value="REDUCE_MINUTES">Reduce time (take minutes away)</option>{state.testEntitlementsEnabled?<option value="GRANT_TEST">Add test minutes (7 days)</option>:null}</select></label>
    <label>Minutes<input name="minutes" type="number" min={1} max={60000} defaultValue={60} disabled={busy}/></label>
    <label>Reason (saved in history)<input name="reason" required minLength={10} maxLength={500} disabled={busy} placeholder="e.g. Goodwill for a failed session"/></label><button className="button" disabled={busy}>Apply</button>
    <p className="admin-note">Reducing takes from bought or added time that is still unused, largest first. The free 15-minute trial cannot be reduced; block the account instead.</p>
   </form>
   <form key={`unlimited-${subject}`} className="admin-model-form admin-unlimited-form" onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);
     if(access&&!window.confirm('Replace the current unlimited access with this new one?'))return;
     mutate('GRANT_UNLIMITED',{duration:String(values.get('duration'))},String(values.get('reason')));}}>
    <h3><InfinityIcon electric size={26}/> Unlimited access</h3>
    {access?<p className="admin-note"><UnlimitedBadge/> now · {unlimitedUntil(access.endsAt)}</p>:null}
    <label>Unlimited for<select name="duration" defaultValue="MONTH" disabled={busy}><option value="DAY">1 day (24 hours)</option><option value="WEEK">1 week</option><option value="MONTH">1 month</option><option value="QUARTER">3 months</option><option value="YEAR">1 year</option><option value="FOREVER">Forever (no end date)</option></select></label>
    <label>Reason (saved in history)<input name="reason" required minLength={10} maxLength={500} disabled={busy} placeholder="e.g. Partner account"/></label>
    <button className="button" disabled={busy}>{access?'Replace unlimited access':'Give unlimited access'}</button>
    <p className="admin-note">Only Admin can give this; it is never sold. While it runs there is no time limit, and their bought and added time stays saved for afterwards.</p>
   </form>
   {access?<form key={`unlimited-off-${subject}`} className="admin-model-form" onSubmit={event=>{event.preventDefault();const reason=String(new FormData(event.currentTarget).get('reason'));
     if(!window.confirm('Remove unlimited access now? A running session moves to their other time, or ends if there is none.'))return;
     mutate('REVOKE_UNLIMITED',{},reason);}}>
    <label>Remove unlimited access<input name="reason" required minLength={10} maxLength={500} disabled={busy} placeholder="Why are you removing it?"/></label>
    <button className="button danger" disabled={busy}>Remove unlimited access</button>
   </form>:null}
   {subject===state.adminUserId?<p className="admin-note">This is your own Admin account, so it cannot be blocked.</p>
   :<form key={`access-${subject}`} className="admin-model-form" onSubmit={event=>{event.preventDefault();const reason=String(new FormData(event.currentTarget).get('reason'));
     if(!blocked&&!window.confirm('Block this account? Any running session ends now and they cannot sign in or start sessions until you unblock them.'))return;
     mutate(blocked?'REACTIVATE':'SUSPEND',{},reason);}}>
    <label>{blocked?'Unblock this account':'Block (ban) this account'}<input name="reason" required minLength={10} maxLength={500} disabled={busy} placeholder={blocked?'Why are you unblocking them?':'Why are you blocking them?'}/></label>
    <button className={blocked?'button':'button danger'} disabled={busy}>{blocked?'Unblock account':'Block account'}</button>
    <p className="admin-note">{blocked?'This account is blocked: it cannot sign in or use Cluera.':'Blocking ends any running session on every device within seconds and stops sign-in and new sessions. Their time and history stay as they are.'}</p>
   </form>}</>;})()}
  {state.grants?.some(grant=>!['TRIAL','UNLIMITED'].includes(grant.kind)&&['ACTIVE','PAUSED'].includes(grant.state))?<h4>Remove unused time</h4>:null}{state.grants?.map(grant=>!['TRIAL','UNLIMITED'].includes(grant.kind)&&['ACTIVE','PAUSED'].includes(grant.state)?<div key={grant.id} className="admin-grant"><p>{grant.adminAdjustment?'Added by Admin':grant.testGrant?'Test minutes':grant.kind==='PACK'?'Purchased pack':'Monthly plan'}{grant.counted===false?' (test payment: does not count with live payments)':''} · {usageDuration(grant.grantedMilliseconds-grant.spentMilliseconds-(grant.reservedMilliseconds??0))} unused of {usageDuration(grant.grantedMilliseconds)}</p>
   <form onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);mutate('REMOVE_MINUTES',{grantId:grant.id,minutes:Number(v.get('minutes'))},String(v.get('reason')));}}><label>Minutes<input name="minutes" type="number" required min={1} max={60000}/></label><label>Reason<input name="reason" required minLength={10} maxLength={500}/></label><button>Remove</button></form>
   {grant.testGrant&&grant.state==='ACTIVE'?<form onSubmit={event=>{event.preventDefault();mutate('REVOKE_TEST',{grantId:grant.id},String(new FormData(event.currentTarget).get('reason')));}}><label>Reason<input name="reason" minLength={10} maxLength={500} required disabled={busy}/></label><button disabled={busy}>Remove test minutes</button></form>:null}</div>:null)}</div>:null}
  </fieldset></section></div>

  <div hidden={tab!=='data'}><AdminData active={tab==='data'} disabled={locked}/></div>

  <div hidden={tab!=='payments'}><section className="account-admin-section" aria-label="Payments">
   {liveBillingAdmin?<FinancialReports key="live-report" mode="live" disabled={locked}/>:<p className="account-admin-empty">Payments appear here once real payments are switched on.</p>}
  </section></div>

  <div hidden={tab!=='updates'}><section id="account-admin-releases" className="account-admin-section" aria-label="App updates"><AccountReleases disabled={parentLocked} canAct={()=>!running.current&&!reading.current&&!pendingOperation.current} onMutationLockChange={releaseLockChanged}/></section></div>

  <div hidden={tab!=='history'}><section id="account-admin-audit" className="account-admin-section" aria-labelledby="account-admin-audit-heading"><p className="account-ui-kicker">HISTORY</p><h2 id="account-admin-audit-heading">Every Admin change</h2><label>Search<input type="search" value={auditQuery} onChange={event=>setAuditQuery(event.target.value)} placeholder="Model, plan, customer…" maxLength={100}/></label><ul className="account-admin-audit">{state.audit?.filter(entry=>`${entry.action} ${entry.reason}`.toLowerCase().includes(auditQuery.toLowerCase())).map(entry=><li key={entry.id}><time>{new Date(entry.createdAt).toLocaleString()}</time><strong>{entry.action}</strong><span>{entry.reason}</span></li>)}</ul>
  {!state.audit?.some(entry=>`${entry.action} ${entry.reason}`.toLowerCase().includes(auditQuery.toLowerCase()))?<p className="account-admin-empty">No matching changes.</p>:null}</section></div>
 </>:null}
 <p className="account-admin-help">Need help? <a href="mailto:clueraaisupport@gmail.com">Contact Cluera support</a>. Never share passwords, API keys or authenticator codes.</p>
 </section>;
}
