'use strict';
// Offline, bounded preservation comparison ONLY. No database client or import path.
const SOURCE='dwqltsqumiwsxtkzdoaa',DESTINATION='yhnqlfcgrmckhyjdxegg';
const TABLES=Object.freeze([
 'public.account_releases','public.customer_accounts','public.account_admin_audit',
 'public.customer_usage_runs','public.customer_billing_jobs','public.customer_trial_grants',
 'public.customer_usage_grants','public.paddle_sandbox_events','public.account_admin_profiles',
 'public.account_catalog_policy','public.customer_usage_windows','billing_private.payment_events',
 'public.customer_billing_outbox','public.customer_pack_purchases','billing_private.payment_intents',
 'public.customer_recurring_terms','public.customer_checkout_intents','public.customer_pack_applications',
 'public.customer_usage_settlements','billing_private.payment_diagnostics','billing_private.payment_applications',
 'public.customer_recurring_applications','billing_private.checkout_recovery_audit','public.customer_recurring_subscriptions',
].sort());
const result=(status,code,extra={})=>({status,code,scope:'historical-24-business-tables-only',
 activationAuthorized:false,backupRestorabilityVerified:false,...extra});
function exact(value,keys){
 return value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Object.keys(value).sort().join('\n')===[...keys].sort().join('\n');
}
function snapshot(value,expected,now){
 if(!exact(value,['projectRef','capturedAt','snapshots'])||value.projectRef!==expected
  ||typeof value.capturedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value.capturedAt)
  ||!exact(value.snapshots,TABLES))throw Error('shape');
 const at=Date.parse(value.capturedAt);
 if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,19)!==value.capturedAt.slice(0,19)
  ||at>now+5000||now-at>15*60*1000)throw Error('time');
 for(const table of TABLES){const entry=value.snapshots[table];
  if(!exact(entry,['count','digest'])||!Number.isSafeInteger(entry.count)||entry.count<0
   ||typeof entry.digest!=='string'||!/^[a-f0-9]{32}$/.test(entry.digest))throw Error('row');
 }
 return at;
}
function compare(input,now=Date.now()){
 try{
  if(!Number.isFinite(now)||!exact(input,['source','destination']))return result('blocked','INVALID_INPUT');
  const from=snapshot(input.source,SOURCE,now),to=snapshot(input.destination,DESTINATION,now);
  if(to<from)return result('blocked','INVALID_SNAPSHOT_ORDER');
  const mismatches=TABLES.filter(table=>{
   const a=input.source.snapshots[table],b=input.destination.snapshots[table];
   return a.count!==b.count||a.digest!==b.digest;
  });
  return result(mismatches.length?'blocked':'bounded-business-match',mismatches.length?'BUSINESS_MISMATCH':'BOUNDED_MATCH_ONLY',
   {tablesCompared:TABLES.length,mismatchedTables:mismatches});
 }catch{return result('blocked','INVALID_OR_STALE_EVIDENCE');}
}
module.exports={SOURCE,DESTINATION,TABLES,compare};
if(require.main===module)(async()=>{
 let input;try{const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw Error('bound');chunks.push(chunk);}
  input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }catch{console.log(JSON.stringify(result('blocked','INVALID_INPUT')));process.exitCode=2;return;}
 console.log(JSON.stringify(compare(input)));
 // Even a matching bounded projection cannot approve restore, new Auth or cutover.
 process.exitCode=2;
})().catch(()=>{console.error('Transfer inspection unavailable.');process.exitCode=2;});
