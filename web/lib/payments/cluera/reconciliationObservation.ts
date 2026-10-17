const outcomes=new Set(['EMPTY','PENDING','VERIFIED','REFUNDED','STATUS','APPLIED','NO_GRANT','DUPLICATE','UNAVAILABLE','UNKNOWN']);
type Observation=Readonly<{component:'cluera-billing-reconciliation';outcome:string;elapsedMs:number|null;creditEffect:'NOT_INFERRED'}>;
/** Redacted process observation only: not an audit row, an alert or evidence of
 * a new grant. VERIFIED can describe idempotent/replayed reconciliation. */
export function beginClueraReconciliationObservation(clock:()=>number=()=>performance.now(),
 sink:(entry:Observation)=>void=entry=>console.info('[cluera-billing] reconciliation',entry)){
 const now=():number|null=>{try{const value=clock();return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;}catch{return null;}};
 const started=now();let finished=false;
 return (result:unknown):void=>{
  if(finished)return;finished=true;
  const ended=now(),elapsedMs=started!==null&&ended!==null&&ended>=started?Math.min(120000,Math.floor(ended-started)):null;
  const entry:Observation=Object.freeze({component:'cluera-billing-reconciliation',
   outcome:typeof result==='string'&&outcomes.has(result)?result:'UNKNOWN',elapsedMs,creditEffect:'NOT_INFERRED'});
  // Never log the supplied value, exception, provider body, merchant or IDs.
  try{void Promise.resolve(sink(entry)).catch(()=>{});}catch{/* Observation failure must not alter financial processing. */}
 };
}
