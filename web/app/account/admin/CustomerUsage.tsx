'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {usageDuration} from '../../../lib/usage/display';

export interface CostedRow {provider:string;model:string;calls:number;inputTokens:number;outputTokens:number;thinkingTokens:number;audioMs:number;costUsd:number;costInr:number}
export interface CostedGroup {rows:CostedRow[];totalUsd:number;totalInr:number}
export interface UsageCustomer {userId:string;email:string;state:string;usedMs:number;activeNow:boolean;lastActiveAt:string|null;usage:CostedGroup}
export interface UsageOverview {overall:{customerCount:number;activeNow:number;usedMs:number;usage:CostedGroup};customers:UsageCustomer[];assumptions:Assumptions}
export interface Assumptions {usdToInr:number;deepgramUsdPerMinute:number;gemini:{flash:Rate;flashLite:Rate;pro:Rate};openai:Rate;anthropic:Rate}
interface Rate {inputPerMillion:number;outputPerMillion:number}
export interface UsageDetail {
 customer:{userId:string;email:string;state:string;usedMs:number;activeNow:boolean;activeSince:string|null;sessionCount:number;lastActiveAt:string|null};
 adminReducedMs:number;models:CostedGroup;models30d:CostedGroup;
 sessions:Array<{runId:string;startedAt:string|null;state:string;usedMs:number;usage:CostedGroup}>;assumptions:Assumptions;
}

/** Live usage for the Customers tab. Polls while the tab is open and the browser tab is visible. */
export function useUsageReport(active:boolean,subject:string){
 const [overview,setOverview]=useState<UsageOverview|null>(null),[detail,setDetail]=useState<UsageDetail|null>(null);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false),[updatedAt,setUpdatedAt]=useState('');
 const version=useRef(0);
 const run=useCallback(async(signal:AbortSignal)=>{
  const mine=++version.current;setLoading(true);
  try{
   const read=async(id:string)=>{
    const response=await fetch(`/api/account/admin?usage=1${id?`&subject=${encodeURIComponent(id)}`:''}`,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw new Error(String(response.status));
    return response.json();
   };
   const [all,one]=await Promise.all([read(''),subject?read(subject):Promise.resolve(null)]);
   if(mine!==version.current||signal.aborted)return;
   setOverview(all);setDetail(one);setError('');setUpdatedAt(new Date().toLocaleTimeString());
  }catch{
   if(mine===version.current&&!signal.aborted)setError('Usage could not be loaded just now. It will try again shortly.');
  }finally{if(mine===version.current)setLoading(false);}
 },[subject]);
 useEffect(()=>{
  if(!active)return;
  const controller=new AbortController();
  void run(controller.signal);
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void run(controller.signal);},15000);
  return()=>{controller.abort();clearInterval(timer);};
 },[active,run]);
 const refresh=useCallback(()=>{const controller=new AbortController();void run(controller.signal);},[run]);
 return {overview,detail,error,loading,updatedAt,refresh};
}

const rupees=(value:number)=>`₹${value<1?value.toFixed(2):value<100?value.toFixed(1):Math.round(value).toLocaleString('en-IN')}`;
const dollars=(value:number)=>`$${value<0.01?value.toFixed(4):value.toFixed(2)}`;
export const money=(group:{totalInr:number;totalUsd:number})=>`${rupees(group.totalInr)} (${dollars(group.totalUsd)})`;
const tokens=(value:number)=>value>=1e6?`${(value/1e6).toFixed(2)}M`:value>=1e3?`${(value/1e3).toFixed(1)}k`:String(value);
const audio=(ms:number)=>usageDuration(ms);
const providerName:Record<string,string>={gemini:'Gemini',deepgram:'Deepgram',openai:'ChatGPT',anthropic:'Claude'};
export function usageLine(row:CostedRow){
 return row.provider==='deepgram'
  ?`${audio(row.audioMs)} of speech`
  :`${tokens(row.inputTokens)} in · ${tokens(row.outputTokens+row.thinkingTokens)} out`;
}

function UsageTable({group,empty='No usage recorded yet.'}:{group:CostedGroup;empty?:string}){
 if(!group.rows.length)return <p className="account-admin-empty">{empty}</p>;
 return <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Service</th><th>Model</th><th>Calls</th><th>Used</th><th>Estimated cost</th></tr></thead>
  <tbody>{group.rows.map(row=><tr key={`${row.provider}:${row.model}`}><td>{providerName[row.provider]??row.provider}</td><td>{row.model}</td><td>{row.calls.toLocaleString()}</td><td>{usageLine(row)}</td><td>{money({totalInr:row.costInr,totalUsd:row.costUsd})}</td></tr>)}</tbody>
  <tfoot><tr><td colSpan={4}>Total</td><td>{money(group)}</td></tr></tfoot></table></div>;
}

export function UsageAssumptions({assumptions}:{assumptions:Assumptions}){
 const g=assumptions.gemini;
 return <details className="usage-assumptions"><summary>How the cost is estimated</summary>
  <p>Providers do not bill per customer, so this adds up the tokens and speech time Cluera recorded for each customer and multiplies them by list prices. It is an estimate for your planning, not an invoice, and it never changes what a customer pays.</p>
  <ul>
   <li>Gemini Flash: ${g.flash.inputPerMillion}/M input, ${g.flash.outputPerMillion}/M output (Flash-Lite ${g.flashLite.inputPerMillion}/${g.flashLite.outputPerMillion}, Pro ${g.pro.inputPerMillion}/{g.pro.outputPerMillion}). Thinking tokens count as output.</li>
   <li>Deepgram speech: ${assumptions.deepgramUsdPerMinute} per minute of audio sent.</li>
   <li>ChatGPT ${assumptions.openai.inputPerMillion}/${assumptions.openai.outputPerMillion} and Claude ${assumptions.anthropic.inputPerMillion}/${assumptions.anthropic.outputPerMillion} per million tokens, used once those models are switched on.</li>
   <li>₹ shown at {assumptions.usdToInr} per US dollar. Tell support if a price or the rate changes.</li>
  </ul></details>;
}

export function UsageOverviewPanel({report,error,loading,updatedAt,onRefresh,onSelect,selected,disabled}:{report:UsageOverview|null;error:string;loading:boolean;updatedAt:string;onRefresh:()=>void;onSelect:(id:string)=>void;selected:string;disabled:boolean}){
 return <div className="usage-panel" aria-label="Customer usage">
  <div className="account-admin-section-heading"><div><p className="account-ui-kicker">USAGE</p><h3>Who is using Cluera</h3></div>
   <button type="button" disabled={loading} onClick={onRefresh}>{loading?'Refreshing…':'Refresh now'}</button></div>
  <p className="admin-note" role="status">{error||(updatedAt?`Live · updates every 15 seconds · last update ${updatedAt}`:'Loading usage…')}</p>
  {report?<>
   <div className="admin-stat-grid compact">
    <div className="admin-stat"><strong>{report.overall.activeNow}</strong><span>In a session right now</span></div>
    <div className="admin-stat"><strong>{usageDuration(report.overall.usedMs)}</strong><span>Session time used by all customers</span></div>
    <div className="admin-stat"><strong>{money(report.overall.usage)}</strong><span>Estimated provider cost, all time</span></div>
    <div className="admin-stat"><strong>{report.overall.customerCount}</strong><span>Customers</span></div>
   </div>
   <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Customer</th><th>Status</th><th>Time used</th><th>Estimated cost</th><th>Last session</th></tr></thead>
    <tbody>{report.customers.map(c=><tr key={c.userId} className={selected===c.userId?'selected':''}>
     <td><button type="button" className="usage-link" disabled={disabled} onClick={()=>onSelect(c.userId)}>{c.email}</button></td>
     <td>{c.state!=='ACTIVE'?<span className="tag-off">Blocked</span>:c.activeNow?<span className="tag-live">Live now</span>:<span className="tag-on">Active</span>}</td>
     <td>{usageDuration(c.usedMs)}</td><td>{money(c.usage)}</td><td>{c.lastActiveAt?new Date(c.lastActiveAt).toLocaleString():'Never'}</td></tr>)}</tbody></table></div>
   {report.customers.length>=100?<p className="admin-note">Showing the 100 busiest customers. Search by email to find anyone else.</p>:null}
   <UsageAssumptions assumptions={report.assumptions}/>
  </>:null}
 </div>;
}

export function UsageDetailPanel({detail}:{detail:UsageDetail|null}){
 if(!detail)return <p className="admin-note">Loading this customer’s usage…</p>;
 const c=detail.customer;
 return <div className="usage-panel" aria-label="This customer's usage">
  <h4>Usage</h4>
  <div className="admin-stat-grid compact">
   <div className="admin-stat"><strong>{usageDuration(c.usedMs)}</strong><span>Total session time used</span></div>
   <div className="admin-stat"><strong>{c.sessionCount}</strong><span>Sessions</span></div>
   <div className="admin-stat"><strong>{money(detail.models)}</strong><span>Estimated cost, all time</span></div>
   <div className="admin-stat"><strong>{money(detail.models30d)}</strong><span>Estimated cost, last 30 days</span></div>
  </div>
  <p className="admin-note">{c.activeNow?`In a session right now${c.activeSince?`, started ${new Date(c.activeSince).toLocaleTimeString()}`:''}.`:c.lastActiveAt?`Last session ${new Date(c.lastActiveAt).toLocaleString()}.`:'No sessions yet.'}{detail.adminReducedMs?` Time you removed by hand: ${usageDuration(detail.adminReducedMs)} (not counted as their use).`:''}</p>
  <h4>Where the cost comes from</h4><UsageTable group={detail.models}/>
  <h4>Recent sessions</h4>
  {detail.sessions.length?<div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>Started</th><th>Length</th><th>Used</th><th>Estimated cost</th></tr></thead>
   <tbody>{detail.sessions.map(s=><tr key={s.runId}><td>{s.startedAt?new Date(s.startedAt).toLocaleString():''}{s.state==='ACTIVE'?<span className="tag-live"> Live</span>:null}</td><td>{usageDuration(s.usedMs)}</td>
    <td>{s.usage.rows.map(r=>`${providerName[r.provider]??r.provider}: ${usageLine(r)}`).join(' · ')||'—'}</td><td>{money(s.usage)}</td></tr>)}</tbody></table></div>:<p className="account-admin-empty">No sessions yet.</p>}
  <UsageAssumptions assumptions={detail.assumptions}/>
 </div>;
}
