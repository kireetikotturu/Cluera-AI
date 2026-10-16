'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SOURCE,DESTINATION,TABLES,compare}=require('../scripts/migrations/verify-cluera-business-transfer.cjs');
const now=Date.parse('2026-10-16T01:00:00.000Z');
function fixture(){const snapshots=()=>Object.fromEntries(TABLES.map(name=>[name,{count:0,digest:'a'.repeat(32)}]));
 return {source:{projectRef:SOURCE,capturedAt:'2026-10-16T00:59:00.000Z',snapshots:snapshots()},
  destination:{projectRef:DESTINATION,capturedAt:'2026-10-16T00:59:30.000Z',snapshots:snapshots()}};
}
test('matches exactly the bounded 24-table projection without approving backup, Auth or activation',()=>{
 const value=compare(fixture(),now);assert.equal(value.status,'bounded-business-match');assert.equal(value.tablesCompared,24);
 assert.deepEqual(value.mismatchedTables,[]);assert.equal(value.activationAuthorized,false);assert.equal(value.backupRestorabilityVerified,false);
 assert.equal(value.scope,'historical-24-business-tables-only');
});
for(const table of ['public.customer_trial_grants','public.customer_usage_grants','billing_private.payment_events','public.account_admin_audit']){
 test('detects changed preserved evidence: '+table,()=>{const value=fixture();value.destination.snapshots[table].digest='b'.repeat(32);
  assert.deepEqual(compare(value,now).mismatchedTables,[table]);assert.equal(compare(value,now).status,'blocked');});
}
test('detects duplicate trials, grants and historical rows by count independently of digest',()=>{
 for(const table of TABLES){const value=fixture();value.destination.snapshots[table].count=1;assert.equal(compare(value,now).status,'blocked');}
});
test('rejects missing, extra and unknown evidence tables',()=>{
 for(const change of [v=>delete v.source.snapshots[TABLES[0]],v=>v.destination.snapshots['auth.users']={count:1,digest:'a'.repeat(32)}]){
  const value=fixture();change(value);assert.equal(compare(value,now).code,'INVALID_OR_STALE_EVIDENCE');}
});
test('rejects swapped, reused, foreign or typoed project identities',()=>{
 for(const field of ['source','destination'])for(const ref of [field==='source'?DESTINATION:SOURCE,'foreign',null]){
  const value=fixture();value[field].projectRef=ref;assert.equal(compare(value,now).status,'blocked');}
});
test('rejects stale, future, timezone-free, invalid and reversed snapshots',()=>{
 for(const at of ['2026-10-15T00:59:00.000Z','2026-10-16T01:01:00.000Z','2026-10-16 00:59:00','invalid']){
  const value=fixture();value.source.capturedAt=at;assert.equal(compare(value,now).status,'blocked');}
 const value=fixture();value.destination.capturedAt='2026-10-16T00:58:00.000Z';assert.equal(compare(value,now).code,'INVALID_SNAPSHOT_ORDER');
});
test('rejects raw rows, secret fields, approval booleans and malformed aggregates without echoing input',()=>{
 const secret='synthetic-never-print';
 for(const change of [v=>v.token=secret,v=>v.source.rows=[secret],v=>v.activationAuthorized=true,
  v=>v.source.snapshots[TABLES[0]].password_hash=secret,v=>v.source.snapshots[TABLES[0]].count=-1,
  v=>v.source.snapshots[TABLES[0]].count=Number.MAX_SAFE_INTEGER+1,v=>v.source.snapshots[TABLES[0]].digest=secret]){
  const value=fixture();change(value);const result=compare(value,now);assert.equal(result.status,'blocked');assert(!JSON.stringify(result).includes(secret));}
});
test('rejects array/null/overspecified roots and never exposes an executable import path',()=>{
 for(const value of [null,[],{},'raw-sql',{...fixture(),apply:true}])assert.equal(compare(value,now).status,'blocked');
 assert.equal(compare(fixture(),now).activationAuthorized,false);
});
test('rejects a calendar-invalid timestamp even if JavaScript normalizes it to a fresh date',()=>{
 const value=fixture();value.source.capturedAt='2026-02-30T00:59:00.000Z';
 value.destination.capturedAt='2026-03-02T00:59:30.000Z';
 assert.equal(compare(value,Date.parse('2026-03-02T01:00:00.000Z')).status,'blocked');
});
