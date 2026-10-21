import {useEffect,useState,useRef} from 'react';
import {ArrowUpRight,Clock3,RefreshCw,Wallet} from 'lucide-react';
import {allowancePercent,bucketName,creditDuration,emptyCredits,type CreditsView} from '../../shared/accountCredits';

/** Isolated one-second paint while active. Estimates never authorize work or
 * replace server balances. Main deduplicates all refresh/foreground requests. */
export function AccountCreditsSection({userId,compact=false}:{userId?:string;compact?:boolean}):JSX.Element {
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
  <span>{snapshot?`${creditDuration(snapshot.availableMilliseconds)} available`:'Balance syncing'}</span>
  {view.state==='unavailable'&&<span>Sync unavailable</span>}</section>;
 return <section className="account-credits" aria-label="Credits & Usage">
  <div className="account-credits-heading"><div><p className="eyebrow">CLUERA AI</p><h2><Wallet size={20}/>Credits & Usage</h2></div>
   <div className="account-credits-actions"><button className="ghost" disabled={view.refreshing} onClick={refresh} aria-label="Refresh credits"><RefreshCw size={14}/>{view.refreshing?'Syncing':'Refresh'}</button>
    <button className="primary" onClick={buy}>Buy Credits<ArrowUpRight size={15}/></button></div></div>
  <div className="account-credit-metrics"><div><span>Available balance</span><strong>{snapshot?creditDuration(snapshot.availableMilliseconds):'—'}</strong><small>Shared across your devices</small></div>
   <div><span>Total actual AI usage</span><strong>{snapshot?creditDuration(snapshot.spentMilliseconds):'—'}</strong><small>Settled server time, not dashboard time</small></div>
   <div><span>Pending reservations</span><strong>{snapshot?creditDuration(snapshot.reservedMilliseconds):'—'}</strong><small>Reserved time is not a second charge</small></div></div>
  {snapshot&&<div className="account-allowances">{snapshot.buckets.map(bucket=>{const percent=allowancePercent(bucket);return <article key={bucket.kind}>
   <div><strong>{bucketName[bucket.kind]}</strong><span>{creditDuration(bucket.availableMilliseconds)} available</span></div>
   <progress value={percent??0} max={100} aria-label={`${bucketName[bucket.kind]} consumed`}/>
   <small>{percent===null?'No applicable allowance':`${percent.toFixed(1)}% consumed · ${creditDuration(bucket.spentMilliseconds)} of ${creditDuration(bucket.grantedMilliseconds)}`}</small>
  </article>;})}</div>}
  {snapshot&&<p className="account-plan-state">{snapshot.plans.filter(p=>!['ENDED','REFUNDED'].includes(p.state)).map((plan,index)=><span key={index}>{plan.tier} · {plan.state} · {plan.paymentState}{plan.cancelFuture?' · renewal cancelled':''}{plan.endsAt?` · until ${new Date(plan.endsAt).toLocaleDateString()}`:''}</span>)}
   {!snapshot.plans.some(p=>p.state==='ACTIVE')&&<span>{snapshot.buckets.some(b=>b.kind==='PACK'&&b.availableMilliseconds>0)?'Non-expiring pack access':snapshot.buckets.some(b=>b.kind==='TEST'&&b.availableMilliseconds>0)?'Staging test access':'Trial / available allowances'}</span>}</p>}
  <footer><span>{view.active?`Active AI/session estimate ${creditDuration(elapsed)} · settles after checkpoints`:'No active managed AI usage'}</span>
   <span>Last successful server sync: {last??'not yet synced'}</span></footer>
  <p className="muted">Percentages apply only to the currently eligible bucket, not lifetime usage or old recurring cycles. Purchases update time only after verified server reconciliation.</p>
  {snapshot&&!snapshot.checkoutAvailable&&<p className="account-billing-paused">Checkout is currently unavailable or an existing payment needs verification. Open billing to check its status; do not pay again to refresh your balance.</p>}
  {snapshot?.payments.slice(0,3).map((payment,index)=><p className="muted" key={index}>Recent checkout · {payment.offerCode.replaceAll('_',' ')} · {payment.state==='VERIFIED'?'Server verified':payment.state==='BOUND'?'Payment pending server verification':payment.state==='UNCERTAIN'?'Needs verification — do not retry':payment.state.toLowerCase()}</p>)}
  {snapshot&&snapshot.availableMilliseconds===0&&<p role="status">No unreserved time available. New AI work needs eligible time; existing reservations remain server-controlled.</p>}
  {(error||view.state==='unavailable')&&<p role="status">{error||'Server sync unavailable. Displayed balances are the last successful snapshot, not authorization.'}</p>}
 </section>;
}
