'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {AiCostReport,AiDayCost,AiModelCost,AiPrice} from '../../../lib/accounts/aiCost';
import {usageDuration} from '../../../lib/usage/display';
import './ai-costs.css';

export type CostPeriod='today'|'7d'|'30d'|'all';
const PERIODS:Array<[CostPeriod,string]>=[['today','Today'],['7d','7 days'],['30d','30 days'],['all','All time']];
const PROVIDERS:Record<string,string>={gemini:'Gemini',openai:'ChatGPT',anthropic:'Claude',deepgram:'Deepgram'};
const DEVICES:Record<string,string>={windows:'Windows app',web:'Phone'};

/** The first moment of the period in the Admin's own time zone; null for all time. */
export function periodStart(period:CostPeriod,now=new Date()):Date|null{
 if(period==='all')return null;
 const start=new Date(now.getFullYear(),now.getMonth(),now.getDate());
 if(period!=='today')start.setDate(start.getDate()-(period==='7d'?6:29));
 return start;
}
export const rupees=(value:number)=>value<=0?'₹0':`₹${value<0.1?value.toFixed(3):value<10?value.toFixed(2):value<100?value.toFixed(1):Math.round(value).toLocaleString('en-IN')}`;
const dollars=(value:number)=>value<=0?'$0':`$${value<0.01?value.toFixed(4):value<1000?value.toFixed(2):Math.round(value).toLocaleString('en-US')}`;
export const compact=(value:number)=>value>=1e6?`${(value/1e6).toFixed(2)}M`:value>=1e4?`${Math.round(value/1e3)}k`:value>=1e3?`${(value/1e3).toFixed(1)}k`:String(Math.round(value));
const audioMinutes=(milliseconds:number)=>{const minutes=milliseconds/60_000;return `${minutes>=10?Math.round(minutes).toLocaleString('en-IN'):minutes.toFixed(1)} min`;};
const count=(value:number,word:string,many=`${word}s`)=>`${value.toLocaleString('en-IN')} ${value===1?word:many}`;
const when=(iso:string)=>new Date(iso).toLocaleString(undefined,{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
const ended=(start:string,end:string)=>new Date(start).toDateString()===new Date(end).toDateString()?new Date(end).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):when(end);

/** The average cost of one unit of a model's work, so any amount of use can be estimated. */
export function typicalCost(row:AiModelCost,rate:number):string{
 if(row.unpriced&&!row.costUsd)return '—';
 if(row.provider==='deepgram')return row.audioMs>0?`${rupees(row.costUsd*rate/(row.audioMs/60_000))} per audio minute`:'—';
 return row.answers>0?`${rupees(row.costUsd*rate/row.answers)} per answer`:'—';
}
export function usedText(row:AiModelCost):string{
 if(row.provider==='deepgram')return `${audioMinutes(row.audioMs)} of audio · ${count(row.requests,'stream')}`;
 const cached=row.cachedTokens?` (${compact(row.cachedTokens)} cached)`:'';
 const other=row.otherRequests?` · ${row.otherRequests} stopped or failed`:'';
 return `${count(row.answers,'answer')} · ${compact(row.inputTokens)} tokens in${cached} · ${compact(row.outputTokens)} out${other}`;
}
/** One entry per calendar day, quiet days included, ending today (at most the latest 62). */
export function fillDays(days:AiDayCost[],from:Date|null,now=new Date()):AiDayCost[]{
 if(!days.length&&!from)return [];
 const key=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 const first=from??new Date(`${days[0].day}T00:00:00`),byDay=new Map(days.map(day=>[day.day,day])),filled:AiDayCost[]=[];
 for(const date=new Date(first.getFullYear(),first.getMonth(),first.getDate());date<=now&&filled.length<4_000;date.setDate(date.getDate()+1))
  filled.push(byDay.get(key(date))??{day:key(date),costUsd:0,answers:0,audioMs:0});
 return filled.slice(-62);
}
const ceiling=(value:number)=>{if(value<=0)return 1;const power=10**Math.floor(Math.log10(value)),n=value/power;return (n<=1?1:n<=2?2:n<=5?5:10)*power;};
const dayLabel=(day:string)=>new Date(`${day}T00:00:00`).toLocaleDateString(undefined,{day:'numeric',month:'short'});

function DailyColumns({days,rate}:{days:AiDayCost[];rate:number}){
 const [active,setActive]=useState<number|null>(null);
 const values=days.map(day=>day.costUsd*rate),top=ceiling(Math.max(0,...values)),peak=values.indexOf(Math.max(...values));
 const shown=active!==null&&active<days.length?days[active]:null;
 return <figure className="ai-chart" aria-label="Cost per day">
  <div className="ai-chart-plot">
   <div className="ai-chart-grid" aria-hidden="true">{[1,0.5,0].map(step=><span key={step} style={{bottom:`${step*100}%`}}><em>{rupees(top*step)}</em></span>)}</div>
   <ol className="ai-chart-columns">{days.map((day,index)=><li key={day.day}>
    <button type="button" aria-label={`${dayLabel(day.day)}: ${rupees(values[index])}, ${count(day.answers,'answer')}, ${audioMinutes(day.audioMs)} of audio`}
     onPointerEnter={()=>setActive(index)} onPointerLeave={()=>setActive(null)} onFocus={()=>setActive(index)} onBlur={()=>setActive(null)}>
     {index===peak&&values[index]>0&&active===null?<em>{rupees(values[index])}</em>:null}
     <span style={{height:`${values[index]>0?Math.max(2,values[index]/top*100):0}%`}}/>
    </button></li>)}</ol>
   {shown&&active!==null?<div className="ai-chart-tip" style={{left:`clamp(110px, ${(active+0.5)/days.length*100}%, calc(100% - 110px))`}}>
    <strong>{rupees(values[active])}</strong><span>{dayLabel(shown.day)} · {count(shown.answers,'answer')} · {audioMinutes(shown.audioMs)} audio</span></div>:null}
  </div>
  <div className="ai-chart-axis" aria-hidden="true"><span>{days.length?dayLabel(days[0].day):''}</span>{days.length>2?<span>{dayLabel(days[Math.floor((days.length-1)/2)].day)}</span>:null}<span>{days.length>1?dayLabel(days[days.length-1].day):''}</span></div>
 </figure>;
}

const listPrice=(value:number|null)=>value===null?'—':`$${value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})}`;
function PriceRow({price}:{price:AiPrice}){
 const usd=listPrice;
 const upcoming=price.from>new Date().toISOString().slice(0,10);
 return <tr><td><strong>{price.model}</strong><small>{PROVIDERS[price.provider]??price.provider}</small></td>
  <td className="num">{usd(price.input)}</td><td className="num">{usd(price.cached)}</td><td className="num">{usd(price.output)}</td>
  <td className="num">{usd(price.audioMinute)}</td>
  <td className="wrap">{upcoming?<strong className="ai-upcoming">From {dayLabel(price.from)} {price.from.slice(0,4)}</strong>:'Now'}
   {price.longAbove?<small>Prompts over {compact(price.longAbove)} tokens: {usd(price.longInput)} in, {usd(price.longOutput)} out</small>:null}
   {price.note?<small>{price.note}</small>:null}</td></tr>;
}

/** Everything on the page for one report. Pure display, so it can be checked on its own. */
export function AiCostsView({report,period,onOpenCustomer}:{report:AiCostReport;period:CostPeriod;onOpenCustomer?:(userId:string)=>void}){
 const t=report.totals,rate=report.usdToInr,total=t.costUsd*rate;
 const perHour=t.sessionMs>=60_000?t.sessionCostUsd*rate/(t.sessionMs/3_600_000):null;
 const chartDays=fillDays(report.days,periodStart(period));
 return <>
  {t.unpriced>0?<p className="ai-warning" role="alert">⚠ {count(t.unpriced,'request')} used a model with no price yet, so {t.unpriced===1?'its':'their'} cost is not in these totals. Tell support the model name to add its price.</p>:null}
  <div className="ai-tiles">
   <div className="ai-tile ai-tile-hero"><span>Total AI cost</span><strong>{rupees(total)}</strong><small>{dollars(t.costUsd)}{t.estimated?` · includes ${count(t.estimated,'stopped reply','stopped replies')} estimated`:''}</small></div>
   <div className="ai-tile"><span>Cost per hour of sessions</span><strong>{perHour===null?'—':rupees(perHour)}</strong><small>{t.sessionMs?`From ${usageDuration(t.sessionMs)} of session time`:'No session time yet'}</small></div>
   <div className="ai-tile"><span>Sessions</span><strong>{t.sessions.toLocaleString('en-IN')}</strong><small>{t.liveNow?<><span className="ai-live">{t.liveNow} live now</span> · </>:null}{count(t.customers,'customer')}</small></div>
   <div className="ai-tile"><span>AI work done</span><strong>{count(t.answers,'answer')}</strong><small>{audioMinutes(t.audioMs)} of audio transcribed{t.otherRequests?` · ${t.otherRequests} stopped or failed`:''}</small></div>
  </div>
  {perHour!==null&&t.sessionMs>=300_000&&perHour>0?<p className="ai-estimate">At this rate, <b>10 hours</b> of customer sessions cost about <b>{rupees(perHour*10)}</b>, and <b>100 hours</b> about <b>{rupees(perHour*100)}</b>.</p>:null}

  <h3>Cost by model</h3>
  {report.models.length?<div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Model</th><th>What it did</th><th className="num">Cost</th><th>Share</th><th>Typical cost</th></tr></thead>
   <tbody>{report.models.map(row=>{const share=t.costUsd>0?Math.round(row.costUsd/t.costUsd*100):0;return <tr key={`${row.provider}:${row.model}`}>
    <td><strong>{row.model}</strong><small>{PROVIDERS[row.provider]??row.provider}{row.requestedAs.length?` · asked as ${row.requestedAs.join(', ')}`:''}</small></td>
    <td className="wrap">{usedText(row)}{row.estimated?<small>{count(row.estimated,'stopped reply','stopped replies')} estimated</small>:null}</td>
    <td className="num">{row.unpriced&&!row.costUsd?<span className="ai-noprice">No price yet</span>:<><strong>{rupees(row.costUsd*rate)}</strong><small>{dollars(row.costUsd)}</small></>}{row.unpriced&&row.costUsd?<small>{row.unpriced} without a price</small>:null}</td>
    <td><div className="ai-share" aria-hidden="true"><span style={{width:row.costUsd>0?`max(2px, ${share}%)`:0}}/></div><small>{row.costUsd>0&&share===0?'<1':share}% of cost</small></td>
    <td>{typicalCost(row,rate)}</td></tr>;})}</tbody></table></div>:<p className="account-admin-empty">No AI requests in this period.</p>}

  {period!=='today'&&chartDays.length>1&&report.days.length?<><h3>Cost per day</h3><DailyColumns days={chartDays} rate={rate}/></>:null}

  <h3>Customers</h3>
  {report.customers.length?<div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Customer</th><th className="num">Sessions</th><th className="num">Session time</th><th className="num">Answers</th><th className="num">Audio</th><th className="num">Cost</th><th className="num">Per hour</th></tr></thead>
   <tbody>{report.customers.map(c=><tr key={c.userId}>
    <td><button type="button" className="usage-link" onClick={()=>onOpenCustomer?.(c.userId)}>{c.email||'Customer'}</button>{c.running?<> <span className="tag-live">Live now</span></>:null}</td>
    <td className="num">{c.sessions}</td><td className="num">{usageDuration(c.sessionMs)}</td><td className="num">{c.answers.toLocaleString('en-IN')}</td><td className="num">{audioMinutes(c.audioMs)}</td>
    <td className="num"><strong>{rupees(c.costUsd*rate)}</strong>{c.unpriced?<small>{c.unpriced} without a price</small>:null}</td>
    <td className="num">{c.sessionMs>=60_000?rupees(c.sessionCostUsd*rate/(c.sessionMs/3_600_000)):'—'}</td></tr>)}</tbody></table></div>:<p className="account-admin-empty">No customers used AI in this period.</p>}

  <h3>Sessions</h3>
  {report.sessions.length?<><div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Started</th><th>Ended</th><th className="num">Time used</th><th>Device</th><th>Customer</th><th>Models used</th><th className="num">Cost</th></tr></thead>
   <tbody>{report.sessions.map(s=><tr key={`${s.userId}:${s.device}:${s.startedAt}`}>
    <td>{s.startedAt?when(s.startedAt):'—'}</td>
    <td>{s.running?<span className="tag-live">● Running</span>:s.endedAt&&s.startedAt?ended(s.startedAt,s.endedAt):'—'}</td>
    <td className="num">{usageDuration(s.sessionMs)}</td><td>{DEVICES[s.device]??s.device}</td><td>{s.email||'Customer'}</td>
    <td className="wrap">{s.models.join(', ')||'—'}<small>{count(s.answers,'answer')} · {audioMinutes(s.audioMs)} audio</small></td>
    <td className="num"><strong>{rupees(s.costUsd*rate)}</strong>{s.unpriced?<small>{s.unpriced} without a price</small>:null}</td></tr>)}</tbody></table></div>
   {t.sessions>report.sessions.length?<p className="admin-note">Showing the latest {report.sessions.length} of {t.sessions} sessions. Totals above include all of them.</p>:null}</>
   :<p className="account-admin-empty">No sessions in this period.</p>}

  <details className="ai-method"><summary>How the cost is calculated, and the prices used</summary>
   <p>For every request, the provider’s own reply says how many tokens (and cached tokens) it used, or how many seconds of audio it received. Cluera multiplies that by the provider’s published price for that day. Deepgram is billed on audio sent, and your microphone and the interviewer’s sound are two streams. When someone stops a reply, the provider may send no final count, so it is estimated (about 4 characters = 1 token) and marked above. Your provider invoices are the final word: compare them below. ₹ is shown at {rate} per US dollar.</p>
   <p>{report.trackingSince?`Counting since ${when(report.trackingSince)}. Earlier requests are not included.`:'Nothing counted yet: costs appear after the first AI request from this version.'} Sessions that reconnect within 5 minutes are shown as one.</p>
   <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Model</th><th className="num">Input / 1M tokens</th><th className="num">Cached input / 1M</th><th className="num">Output / 1M</th><th className="num">Audio / minute</th><th>Applies</th></tr></thead>
    <tbody>{report.prices.map(price=><PriceRow key={`${price.provider}:${price.model}:${price.from}`} price={price}/>)}</tbody></table></div>
   <h4>Check against each provider’s bill</h4>
   <p>Days here are in UTC, as the provider dashboards show them: <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer">Google AI Studio</a> · <a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">OpenAI usage</a> · <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer">Claude Console</a> · <a href="https://console.deepgram.com" target="_blank" rel="noopener noreferrer">Deepgram Console</a>. Their totals can arrive hours later.</p>
   {report.providerDays.length?<div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Day (UTC)</th><th>Provider</th><th className="num">Requests</th><th className="num">Input tokens</th><th className="num">Cached</th><th className="num">Output tokens</th><th className="num">Audio</th><th className="num">Cost</th></tr></thead>
    <tbody>{report.providerDays.map(d=><tr key={`${d.day}:${d.provider}`}><td>{d.day}</td><td>{PROVIDERS[d.provider]??d.provider}</td><td className="num">{d.requests}</td><td className="num">{d.provider==='deepgram'?'—':d.inputTokens.toLocaleString('en-US')}</td><td className="num">{d.provider==='deepgram'?'—':d.cachedTokens.toLocaleString('en-US')}</td><td className="num">{d.provider==='deepgram'?'—':d.outputTokens.toLocaleString('en-US')}</td><td className="num">{d.provider==='deepgram'?audioMinutes(d.audioMs):'—'}</td><td className="num">{dollars(d.costUsd)}</td></tr>)}</tbody></table></div>:<p className="account-admin-empty">No requests in the last 14 days of this period.</p>}
  </details>
 </>;
}

/** Reads the report while the tab is open: when the period changes, every minute, and on Refresh. */
function useAiCosts(active:boolean,period:CostPeriod){
 const [state,setState]=useState<{report:AiCostReport;period:CostPeriod}|null>(null);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false),[updatedAt,setUpdatedAt]=useState('');
 const version=useRef(0);
 const run=useCallback(async(signal:AbortSignal)=>{
  const mine=++version.current;setLoading(true);
  try{
   const params=new URLSearchParams({costs:'1'}),from=periodStart(period),zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
   if(from)params.set('from',from.toISOString());
   if(zone)params.set('tz',zone);
   const response=await fetch(`/api/account/admin?${params}`,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
   if(!response.ok)throw new Error(String(response.status));
   const report=await response.json();
   if(mine!==version.current||signal.aborted)return;
   // A response of an unexpected shape must never take the whole Admin page down.
   if(!report?.totals||!Array.isArray(report.models)||!Array.isArray(report.sessions)||!Array.isArray(report.customers))throw new Error('shape');
   setState({report,period});setError('');setUpdatedAt(new Date().toLocaleTimeString());
  }catch{if(mine===version.current&&!signal.aborted)setError('AI costs could not be loaded just now. It will try again in a minute.');}
  finally{if(mine===version.current)setLoading(false);}
 },[period]);
 useEffect(()=>{
  if(!active)return;
  const controller=new AbortController();void run(controller.signal);
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void run(controller.signal);},60_000);
  return()=>{controller.abort();clearInterval(timer);};
 },[active,run]);
 return {state,error,loading,updatedAt,refresh:()=>{void run(new AbortController().signal);}};
}

export function AiCosts({active,onOpenCustomer}:{active:boolean;onOpenCustomer?:(userId:string)=>void}){
 const [period,setPeriod]=useState<CostPeriod>('7d');
 const {state,error,loading,updatedAt,refresh}=useAiCosts(active,period);
 return <section className="account-admin-section ai-costs" aria-labelledby="ai-costs-heading">
  <div><p className="account-ui-kicker">AI COSTS</p><h2 id="ai-costs-heading">What the AI costs you</h2>
   <p>Counted from the usage Gemini, ChatGPT, Claude and Deepgram report for every request, at their published prices. Nothing here limits any customer.</p></div>
  <div className="ai-costs-controls">
   <div className="ai-period" role="group" aria-label="Period">{PERIODS.map(([id,label])=><button key={id} type="button" aria-pressed={period===id} onClick={()=>setPeriod(id)}>{label}</button>)}</div>
   <span className="ai-costs-updated" role="status">{error||(updatedAt?`Updates every minute · last update ${updatedAt}`:'Loading AI costs…')}</span>
   <button type="button" disabled={loading} onClick={refresh}>{loading?'Refreshing…':'Refresh'}</button>
  </div>
  {state?<div className={loading&&state.period!==period?'ai-costs-body is-loading':'ai-costs-body'}><AiCostsView report={state.report} period={state.period} onOpenCustomer={onOpenCustomer}/></div>:null}
 </section>;
}
