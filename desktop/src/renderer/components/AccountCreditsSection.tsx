import {useEffect,useState,useRef} from 'react';
import {ArrowUpRight,Clock3,RefreshCw,Wallet} from 'lucide-react';
import {allowancePercent,bucketName,creditDuration,emptyCredits,type CreditsView} from '../../shared/accountCredits';
import {UnlimitedBadge,unlimitedNote,unlimitedUntil} from './UnlimitedMark';
const sourceName={TRIAL:'Free trial',RECURRING:'Monthly plan',PACK:'Time packs',TEST:'Bonus time',MANUAL:'Added by Cluera'} as const;

/** Isolated one-second paint while active. Estimates never authorize work or
 * replace server balances. Main deduplicates all refresh/foreground requests. */
export function AccountCreditsSection({userId,compact=false,small=false,settings=false}:{userId?:string;compact?:boolean;small?:boolean;settings?:boolean}):JSX.Element {
 const [view,setView]=useState<CreditsView>(emptyCredits),[elapsed,setElapsed]=useState(0),[error,setError]=useState('');
 const ownerEpoch=useRef(0);
 useEffect(()=>{
  const epoch=++ownerEpoch.current;let alive=true;const api=window.accountAPI?.credits;
  setView(emptyCredits());setError('');setElapsed(0);
  if(!api)return;
  const accept=(next:CreditsView)=>{if(alive&&ownerEpoch.current===epoch&&(!next.snapshot||next.snapshot.userId===userId))setView(next);};
  const unsubscribe=api.onChange(accept);
  const refresh=()=>{void api.refresh().then(accept).catch(()=>{if(alive)setError('Balance sync unavailable. Retry when online.');});};
  refresh();
  return()=>{alive=false;++ownerEpoch.current;unsubscribe();};
 },[userId]);
 useEffect(()=>{
  setElapsed(view.activeMilliseconds);
  if(!view.active)return;
  const start=performance.now(),timer=setInterval(()=>setElapsed(view.activeMilliseconds+performance.now()-start),1000);
  return()=>clearInterval(timer);
 },[view.active,view.activeMilliseconds]);
 const snapshot=view.snapshot,last=view.lastSync?new Date(view.lastSync).toLocaleTimeString():undefined;
 const refresh=()=>{const epoch=ownerEpoch.current;setError('');void window.accountAPI?.credits.refresh().then(next=>{if(ownerEpoch.current===epoch&&(!next.snapshot||next.snapshot.userId===userId))setView(next);}).catch(()=>{if(ownerEpoch.current===epoch)setError('Balance sync unavailable. Retry when online.');});};
 const buy=()=>{const epoch=ownerEpoch.current;void window.accountAPI?.openWeb('credits').catch(()=>{if(ownerEpoch.current===epoch)setError('Could not open the secure Account website.');});};
 if(compact)return <section className="account-usage-strip" aria-label="Live account usage"><Clock3 size={13}/>
  <span>{view.active?`Active AI estimate ${creditDuration(elapsed)}`:'AI usage idle'}</span>
  <span>{snapshot?.unlimited?<UnlimitedBadge/>:snapshot?`${creditDuration(snapshot.availableMilliseconds)} available`:'Balance syncing'}</span>
  {view.state==='unavailable'&&<span>Sync unavailable</span>}</section>;
 if(settings)return <div className="st-time-wrap" aria-label="Time and usage">
  <dl className="st-time"><div className="st-time-main"><dt>Time left</dt><dd>{snapshot?.unlimited?<UnlimitedBadge large/>:snapshot?creditDuration(snapshot.availableMilliseconds):'—'}</dd></div>
   <div><dt>Used</dt><dd>{snapshot?creditDuration(snapshot.spentMilliseconds):'—'}</dd></div>
   {snapshot&&snapshot.reservedMilliseconds>0&&<div><dt>In use now</dt><dd>{creditDuration(snapshot.reservedMilliseconds)}</dd></div>}</dl>
  {snapshot?.unlimited&&<p className="unlimited-note">{unlimitedNote(snapshot.unlimited)}</p>}
  {snapshot&&snapshot.buckets.some(bucket=>bucket.availableMilliseconds>0)&&<p className="st-sources" aria-label="Where your time comes from">{snapshot.buckets.filter(bucket=>bucket.availableMilliseconds>0).map(bucket=><span key={bucket.kind}>{sourceName[bucket.kind]} · {creditDuration(bucket.availableMilliseconds)}</span>)}</p>}
  <div className="st-time-actions"><button type="button" className="st-btn primary" onClick={buy}>Buy time<ArrowUpRight size={14}/></button>
   <button type="button" className="st-btn" disabled={view.refreshing} onClick={refresh} aria-label="Refresh time"><RefreshCw size={14}/>{view.refreshing?'Syncing…':'Refresh'}</button></div>
  {(error||view.state==='unavailable')&&<p className="st-hint" role="status">{error||'Could not sync just now. Showing your last known balance.'}</p>}
 </div>;
 if(small)return <section className="account-credits-small" aria-label="Time and usage">
  <div className="acs-main"><span className="acs-icon"><Wallet size={16}/></span>
   <div><small>Time left</small><strong>{snapshot?.unlimited?<UnlimitedBadge/>:snapshot?creditDuration(snapshot.availableMilliseconds):'—'}</strong></div>
   <div><small>Used</small><strong>{snapshot?creditDuration(snapshot.spentMilliseconds):'—'}</strong></div>
   {snapshot&&snapshot.reservedMilliseconds>0&&<div><small>In use now</small><strong>{creditDuration(snapshot.reservedMilliseconds)}</strong></div>}
   <span className="acs-actions"><button className="ghost" disabled={view.refreshing} onClick={refresh} aria-label="Refresh credits"><RefreshCw size={13}/>{view.refreshing?'Syncing':'Refresh'}</button>
    <button className="primary" onClick={buy}>Buy time<ArrowUpRight size={13}/></button></span></div>
  {snapshot?.unlimited&&<p className="unlimited-note">{unlimitedNote(snapshot.unlimited)}</p>}
  {snapshot&&snapshot.buckets.length>0&&<details className="acs-details"><summary>Details</summary>
   {snapshot.buckets.map(bucket=>{const percent=allowancePercent(bucket);return <div className="acs-bucket" key={bucket.kind}>
    <span>{bucketName[bucket.kind]}</span><progress value={percent??0} max={100} aria-label={`${bucketName[bucket.kind]} used`}/><em>{creditDuration(bucket.availableMilliseconds)} left</em></div>;})}
  </details>}
  {(error||view.state==='unavailable')&&<p className="acs-note" role="status">{error||'Could not sync just now. Showing the last known balance.'}</p>}
 </section>;
 return <section className="account-credits" aria-label="Credits & Usage">
  <div className="account-credits-heading"><div><p className="eyebrow">CLUERA AI</p><h2><Wallet size={20}/>Credits & Usage</h2></div>
   <div className="account-credits-actions"><button className="ghost" disabled={view.refreshing} onClick={refresh} aria-label="Refresh credits"><RefreshCw size={14}/>{view.refreshing?'Syncing':'Refresh'}</button>
    <button className="primary" onClick={buy}>Buy Credits<ArrowUpRight size={15}/></button></div></div>
  <div className="account-credit-metrics"><div><span>Available balance</span><strong>{snapshot?.unlimited?<UnlimitedBadge large/>:snapshot?creditDuration(snapshot.availableMilliseconds):'—'}</strong><small>{snapshot?.unlimited?unlimitedUntil(snapshot.unlimited.endsAt):'Shared across your devices'}</small></div>
   <div><span>Total actual AI usage</span><strong>{snapshot?creditDuration(snapshot.spentMilliseconds):'—'}</strong><small>Settled server time, not dashboard time</small></div>
   <div><span>Pending reservations</span><strong>{snapshot?creditDuration(snapshot.reservedMilliseconds):'—'}</strong><small>Reserved time is not a second charge</small></div></div>
  {snapshot&&<div className="account-allowances">{snapshot.buckets.map(bucket=>{const percent=allowancePercent(bucket);return <article key={bucket.kind}>
   <div><strong>{bucketName[bucket.kind]}</strong><span>{creditDuration(bucket.availableMilliseconds)} available</span></div>
   <progress value={percent??0} max={100} aria-label={`${bucketName[bucket.kind]} consumed`}/>
   <small>{percent===null?'No applicable allowance':`${percent.toFixed(1)}% consumed · ${creditDuration(bucket.spentMilliseconds)} of ${creditDuration(bucket.grantedMilliseconds)}`}</small>
  </article>;})}</div>}
  {snapshot&&<p className="account-plan-state">{snapshot.plans.filter(p=>!['ENDED','REFUNDED'].includes(p.state)).map((plan,index)=><span key={index}>{plan.tier} · {plan.state} · {plan.paymentState}{plan.cancelFuture?' · renewal cancelled':''}{plan.endsAt?` · until ${new Date(plan.endsAt).toLocaleDateString()}`:''}</span>)}
   {!snapshot.plans.some(p=>p.state==='ACTIVE')&&<span>{snapshot.unlimited?'Unlimited access from Cluera':snapshot.buckets.some(b=>b.kind==='PACK'&&b.availableMilliseconds>0)?'Non-expiring pack access':snapshot.buckets.some(b=>b.kind==='TEST'&&b.availableMilliseconds>0)?'Staging test access':'Trial / available allowances'}</span>}</p>}
  <footer><span>{view.active?`Active AI/session estimate ${creditDuration(elapsed)} · settles after checkpoints`:'No active managed AI usage'}</span>
   <span>Last successful server sync: {last??'not yet synced'}</span></footer>
  <p className="muted">Percentages apply only to the currently eligible bucket, not lifetime usage or old recurring cycles. Purchases update time only after verified server reconciliation.</p>
  {snapshot&&!snapshot.checkoutAvailable&&<p className="account-billing-paused">Checkout is currently unavailable or an existing payment needs verification. Open billing to check its status; do not pay again to refresh your balance.</p>}
  {snapshot?.payments.slice(0,3).map((payment,index)=><p className="muted" key={index}>Recent checkout · {payment.offerCode.replaceAll('_',' ')} · {payment.state==='VERIFIED'?'Server verified':payment.state==='BOUND'?'Payment pending server verification':payment.state==='UNCERTAIN'?'Needs verification — do not retry':payment.state.toLowerCase()}</p>)}
  {snapshot&&snapshot.availableMilliseconds===0&&<p role="status">No unreserved time available. New AI work needs eligible time; existing reservations remain server-controlled.</p>}
  {(error||view.state==='unavailable')&&<p role="status">{error||'Server sync unavailable. Displayed balances are the last successful snapshot, not authorization.'}</p>}
 </section>;
}
