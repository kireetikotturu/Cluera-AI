'use client';
import {useEffect,useRef,useState} from 'react';
import {usageDuration} from '../../../lib/usage/display';
import {ProviderStatus} from './ProviderStatus';
import {ModelPolicyEditor,type ModelPolicy} from './ModelPolicyEditor';
import {AccountReleases} from './AccountReleases';
import {adminReadError} from '../../../lib/accounts/adminReadErrors';
import '../account-ui.css';
type Factor={id:string;status:string};
interface State {needsMfa?:boolean;factors?:Factor[];testEntitlementsEnabled?:boolean;
 users?:Array<{userId:string;email:string;emailVerified?:boolean;state:string;createdAt?:string}>;grants?:Array<{id:string;kind:string;state:string;grantedMilliseconds:number;spentMilliseconds:number;reservedMilliseconds?:number;testGrant:boolean;adminAdjustment?:boolean}>;
 balances?:Partial<Record<'TRIAL'|'RECURRING'|'PACK',number>>;trial?:{registered:boolean;remainingMilliseconds:number}|null;
 plans?:Array<{tier:string;state:string;paymentState:string;endsAt:string|null;cancelFuture:boolean;remainingMilliseconds:number|null;graceUntil:string|null}>;
 sessions?:Array<{id:string;startedAt:string;state:string}>;billing?:Array<{id:string;offerCode:string;state:string;createdAt:string;transactionId:string|null}>;
 catalog?:Array<{code:string;name:string;enabled:boolean;priority:number;priceId:string;amount:string;currency:string;seconds:number;interval:string|null}>;
 audit?:Array<{id:string;action:string;reason:string;createdAt:string}>;
 models?:ModelPolicy[];
}
export function AccountAdmin(){
 const [state,setState]=useState<State|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[subject,setSubject]=useState('');
 const [enrollment,setEnrollment]=useState<{id:string;qr:string;secret:string}|null>(null),[factorId,setFactorId]=useState('');
 const [pendingMutation,setPendingMutation]=useState<object|null>(null);
 const [loading,setLoading]=useState(false);
 const [query,setQuery]=useState('');
 const [auditQuery,setAuditQuery]=useState(''),[observedAt,setObservedAt]=useState('');
 const running=useRef(false),alive=useRef(true),reading=useRef<AbortController|null>(null),readVersion=useRef(0);
 const pendingOperation=useRef<object|null>(null);
 const pendingUncertain=useRef(false);
 async function load(id=subject,search=query,cursor?:{createdAt:string;userId:string}){
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
  if(running.current||reading.current||(pendingOperation.current&&pendingOperation.current!==body))return;
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
     if(alive.current){setPendingMutation(null);setMessage('Change was rejected without being applied. Refresh account details or correct the input before trying again.');}
     return;
    }
    throw new Error();
   }
   if('operationId' in body&&data?.code!=='APPLIED')throw new Error();
   if(!alive.current)return;
   if('operationId' in body){pendingOperation.current=null;pendingUncertain.current=false;setPendingMutation(null);}
   if(data.enrollment){setEnrollment(data.enrollment);setFactorId(data.enrollment.id);}
   else{setEnrollment(null);await load();}
  }catch{if('operationId' in body)pendingUncertain.current=true;if(alive.current)setMessage('Action failed or requires MFA. Refresh to verify its state; do not repeat a financial operation blindly.');}
  finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const mutate=(kind:string,input:object,reason:string,id:string|null=subject||null)=>{
  if(pendingOperation.current||running.current||reading.current)return;
  const body={action:kind,operationId:crypto.randomUUID(),subjectId:id,reason,input};
  pendingOperation.current=body;pendingUncertain.current=false;setPendingMutation(body);void action(body);
 };
 const factors=state?.factors??[];
 // SVG is rendered as an image data URL, never executable inline HTML.
 const qr=enrollment?.qr.startsWith('<svg')?`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrollment.qr)}`:enrollment?.qr.startsWith('data:image/svg+xml')?enrollment.qr:undefined;
 const locked=busy||loading||Boolean(pendingMutation);
 const select=(id:string)=>{if(!running.current&&!pendingOperation.current)void load(id);};
 return <section className="account-card account-admin-shell" aria-busy={busy||loading}>
 <div className="account-admin-top"><a href="/account">← Your account</a><span>Private Admin · MFA required</span></div>
 <p role="status" className="account-admin-status">{loading?'Loading verified account details…':message|| (observedAt?`Last verified read ${observedAt}. Refresh is explicit; this page does not poll.`:'Preparing secure administration…')}</p>
 {!state&&!loading?<button disabled={busy||Boolean(pendingMutation)} onClick={()=>select('')}>Refresh account administration</button>:null}
 {pendingMutation?<p>An audited change is pending confirmation. Other mutations are locked. <button disabled={busy} onClick={()=>void action(pendingMutation)}>Verify/retry the same operation</button> This reuses the same operation ID, not a new allowance request.</p>:null}
 {state?.needsMfa?<div className="account-admin-mfa"><p className="account-ui-kicker">SECURE ACCESS</p><h2>Authenticator verification</h2><p>Complete your existing authenticator challenge to access Account controls.</p>
  {enrollment?<><img src={qr} alt="Authenticator setup QR code" width={240} height={240}/><details><summary>Enter setup key manually</summary><code>{enrollment.secret}</code></details></>:null}
  {factors.length?<label>Authenticator<select value={factorId} onChange={event=>setFactorId(event.target.value)}><option value="">Choose authenticator</option>{factors.map((factor,i)=><option key={factor.id} value={factor.id}>Authenticator {i+1} · {factor.status}</option>)}</select></label>:!enrollment?<button className="button" disabled={busy} onClick={()=>void action({action:'MFA_ENROLL'})}>Enroll authenticator</button>:null}
  {(factorId||enrollment)?<form onSubmit={event=>{event.preventDefault();const form=event.currentTarget;void action({action:'MFA_VERIFY',factorId:enrollment?.id??factorId,code:String(new FormData(form).get('code')??'')});form.reset();}}><label>Six-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy}/></label><button className="button" disabled={busy}>Verify</button></form>:null}
  {(enrollment||factors.find(f=>f.id===factorId)?.status==='unverified')?<button disabled={busy} onClick={()=>void action({action:'MFA_CANCEL',factorId:enrollment?.id??factorId})}>Cancel unfinished setup</button>:null}
  <p>Setup keys exist only in this page’s memory. Refresh never creates another factor; cancel unfinished setup explicitly before enrolling again.</p>
 </div>:state?<>
  <nav className="account-admin-nav" aria-label="Admin sections"><a href="#account-admin-users">Users</a><a href="#account-admin-catalog">Catalog</a><a href="#account-admin-models">Models</a><a href="#account-admin-providers">Providers</a><a href="#account-admin-releases">Releases</a><a href="#account-admin-audit">Audit</a></nav>
  <section id="account-admin-users" className="account-admin-section"><div className="account-admin-section-heading"><div><p className="account-ui-kicker">CUSTOMER DIRECTORY</p><h2>Users</h2></div><button disabled={busy||Boolean(pendingMutation)} onClick={()=>select('')}>All recent accounts</button></div>
  <form onSubmit={event=>{event.preventDefault();if(!running.current&&!pendingOperation.current)void load('',query);}}><label>Exact email or account UUID<input value={query} onChange={event=>setQuery(event.target.value)} maxLength={254} disabled={locked}/></label><button disabled={locked}>Search accounts</button></form>
  <ul className="account-admin-users">{state.users?.map(user=><li key={user.userId}><button disabled={busy||Boolean(pendingMutation)} onClick={()=>select(user.userId)}>{user.email}</button><span>{user.state} · {user.emailVerified?'Email verified':'Verification unavailable'}</span></li>)}</ul>
  {!state.users?.length?<p className="account-admin-empty">No matching accounts in this result. Search an exact email or account ID, or return to recent accounts.</p>:null}
  {!subject&&state.users?.length===50&&state.users[49].createdAt?<button disabled={locked} onClick={()=>void load('',query,{createdAt:state.users![49].createdAt!,userId:state.users![49].userId})}>Next accounts</button>:null}
  <fieldset disabled={locked} style={{border:0,padding:0,margin:0}}>
  {subject?<div className="account-admin-detail"><h3>Account details</h3><p>Account: {subject}</p>
   <p>Trial {usageDuration(state.trial?.remainingMilliseconds??state.balances?.TRIAL??0)} · Recurring {usageDuration(state.balances?.RECURRING??0)} · Packs / manual credits {usageDuration(state.balances?.PACK??0)}</p>
   <p>{state.trial?.registered?'Lifetime trial already registered; it cannot be granted again.':'No registered trial reported.'} Available balances exclude reservations and are server snapshots.</p>
   <h4>Plans / entitlement</h4>{state.plans?.length?state.plans.map((plan,i)=><p key={i}>{plan.tier} · {plan.state} · {plan.paymentState}{plan.endsAt?` · ends ${new Date(plan.endsAt).toLocaleString()}`:''}{plan.cancelFuture?' · cancellation scheduled':''}{plan.graceUntil?` · grace until ${new Date(plan.graceUntil).toLocaleString()}`:''}{plan.remainingMilliseconds?` · preserved access ${usageDuration(plan.remainingMilliseconds)}`:''}</p>):<p>No recurring subscription recorded. Trial, test and manual allowances are not purchases.</p>}
   <h4>Recent usage</h4>{state.sessions?.map(run=><p key={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.state}</p>)}
   <h4>Checkout history (read only)</h4>{state.billing?.map(item=><p key={item.id}>{item.offerCode} · {item.state} · {new Date(item.createdAt).toLocaleString()}</p>)}
   <h3>Account controls</h3><form key={subject} onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);const kind=String(values.get('action'));mutate(kind,['GRANT_TEST','ADD_MINUTES'].includes(kind)?{minutes:Number(values.get('minutes'))}:{},String(values.get('reason')));}}>
   <label>Action<select name="action" disabled={busy}><option value="SUSPEND">Suspend</option><option value="REACTIVATE">Reactivate</option><option value="ADD_MINUTES">Add manual no-expiry minutes (not a purchase)</option>{state.testEntitlementsEnabled?<option value="GRANT_TEST">Grant staging test minutes (7 days)</option>:null}</select></label>
   <label>Minutes (for grants only)<input name="minutes" type="number" min={1} max={6000} defaultValue={60} disabled={busy}/></label>
   <label>Required audit reason<textarea name="reason" required minLength={10} maxLength={500} disabled={busy}/></label><button className="button" disabled={busy}>Apply audited action</button>
  </form><h3>Allowances (latest 100)</h3><p>Remove only unused, unreserved pack/recurring minutes. The once-ever trial grant is immutable; suspend access instead. Every adjustment requires a reason.</p>{state.grants?.map(grant=><div key={grant.id}><p>{grant.kind} · {grant.state} · granted {usageDuration(grant.grantedMilliseconds)} · used {usageDuration(grant.spentMilliseconds)} · reserved {usageDuration(grant.reservedMilliseconds??0)} {grant.testGrant?'· STAGING TEST':''}{grant.adminAdjustment?' · MANUAL ADJUSTMENT (not paid)':''}</p>
   {grant.kind!=='TRIAL'&&['ACTIVE','PAUSED'].includes(grant.state)?<form onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);mutate('REMOVE_MINUTES',{grantId:grant.id,minutes:Number(v.get('minutes'))},String(v.get('reason')));}}><label>Unused minutes to remove<input name="minutes" type="number" required min={1} max={60000}/></label><label>Adjustment reason<input name="reason" required minLength={10} maxLength={500}/></label><button>Remove unused minutes</button></form>:null}
   {grant.testGrant&&grant.state==='ACTIVE'?<form onSubmit={event=>{event.preventDefault();mutate('REVOKE_TEST',{grantId:grant.id},String(new FormData(event.currentTarget).get('reason')));}}><label>Revocation reason<input name="reason" minLength={10} maxLength={500} required disabled={busy}/></label><button disabled={busy}>Revoke unused test access</button></form>:null}</div>)}</div>:null}
  </fieldset></section>
  <section id="account-admin-catalog" className="account-admin-section"><fieldset disabled={locked} style={{border:0,padding:0,margin:0,minWidth:0}}>
  <p className="account-ui-kicker">APPROVED OFFER POLICIES</p><h2>Plan catalog</h2><p>These controls change display, order and catalog eligibility only. The selected Test gateway, tester restriction and checkout switches still apply. Prices, provider mappings and purchased allowances remain locked; recurring checkout is unavailable.</p>
  {state.catalog?.map(offer=><form key={`${offer.code}:${offer.name}:${offer.enabled}:${offer.priority}`} onSubmit={event=>{event.preventDefault();const v=new FormData(event.currentTarget);mutate('CATALOG',{code:offer.code,name:String(v.get('name')),enabled:v.get('enabled')==='on',priority:Number(v.get('priority'))},String(v.get('reason')),null);}}>
   <p>{offer.code} · {offer.currency} {Number(offer.amount)/100} · {usageDuration(offer.seconds*1000)} {offer.interval?`per ${offer.interval}`:'no expiry'} · {offer.priceId}</p>
   <label>Display name<input name="name" defaultValue={offer.name} required minLength={2} maxLength={80}/></label><label><input type="checkbox" name="enabled" defaultChecked={offer.enabled}/> Available</label><label>Priority<input name="priority" type="number" defaultValue={offer.priority} min={0} max={1000} required/></label><label>Audit reason<input name="reason" required minLength={10} maxLength={500}/></label><button>Save catalog policy</button></form>)}
  </fieldset></section>
  <section id="account-admin-models" className="account-admin-section"><ModelPolicyEditor models={state.models??[]} disabled={locked} onSave={(policy,reason)=>mutate('MODEL',policy,reason,null)}/></section>
  <section id="account-admin-providers" className="account-admin-section"><ProviderStatus/></section>
  <section id="account-admin-releases" className="account-admin-section"><AccountReleases/></section>
  <section id="account-admin-audit" className="account-admin-section"><p className="account-ui-kicker">READ-ONLY HISTORY</p><h2>Immutable account audit</h2><label>Filter displayed audit entries<input type="search" value={auditQuery} onChange={event=>setAuditQuery(event.target.value)} placeholder="Action or reason" maxLength={100}/></label><ul className="account-admin-audit">{state.audit?.filter(entry=>`${entry.action} ${entry.reason}`.toLowerCase().includes(auditQuery.toLowerCase())).map(entry=><li key={entry.id}><time>{new Date(entry.createdAt).toLocaleString()}</time><strong>{entry.action}</strong><span>{entry.reason}</span></li>)}</ul>
  {!state.audit?.some(entry=>`${entry.action} ${entry.reason}`.toLowerCase().includes(auditQuery.toLowerCase()))?<p className="account-admin-empty">No matching entries in the current audit snapshot.</p>:null}</section>
  <p className="account-admin-safety">No payment initiation, checkout retry or manual paid grant is available here. Test/manual adjustments are explicitly labelled, not purchases. Production and License Edition releases remain separate.</p>
 </>:null}</section>;
}
