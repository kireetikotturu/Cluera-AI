'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assess,run,TARGET,URL}=require('../scripts/check-cluera-operations.cjs');
const now=Date.parse('2026-10-19T09:40:00.000Z'),at=offset=>new Date(now-offset).toISOString();
const base=()=>({version:1,observedAt:at(0),owner:'cluera',epoch:1,merchantBound:true,lastAdmissionAt:at(30000),
pendingCount:0,oldestPendingAt:null,legacyPendingCount:0,oldestLegacyPendingAt:null,expiredLeaseCount:0,
quarantineCount:0,legacyQuarantineCount:0,uncertainCount:0,oldestUncertainAt:null,expiredUnsettledCount:0,
countLimit:1000,processingEvidence:'NONCE_ADMISSION_ONLY'});
const env={CLUERA_OPERATIONS_READ_ENABLED:'true',NEXT_PUBLIC_SUPABASE_URL:TARGET,SUPABASE_SERVICE_ROLE_KEY:'synthetic-private-key-'.repeat(3)};
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('fresh empty admitted state is observation only, never completed billing or production readiness',()=>{
 const r=assess(base(),now);assert.equal(r.status,'OBSERVED');assert.deepEqual(r.alerts,[]);
 assert.equal(r.creditEffect,'NOT_INFERRED');assert.equal(r.productionReady,false);assert.equal(r.financialMutations,0);
 assert.equal(r.snapshot.processingEvidence,'NONCE_ADMISSION_ONLY');assert.equal(Object.isFrozen(r),true);
});
test('each persisted failure condition produces a fixed category without automatic recovery',()=>{
 const cases=[
 [{owner:'account'},'PROCESSING_OWNER_UNAVAILABLE'],[{merchantBound:false},'PROCESSING_OWNER_UNAVAILABLE'],
 [{lastAdmissionAt:null},'WORKER_ADMISSION_STALE'],[{lastAdmissionAt:at(300001)},'WORKER_ADMISSION_STALE'],
 [{pendingCount:1,oldestPendingAt:at(300001)},'CLUERA_RECEIPT_BACKLOG'],
 [{legacyPendingCount:1,oldestLegacyPendingAt:at(300001)},'RETAINED_RECEIPT_BACKLOG'],
 [{expiredLeaseCount:1,pendingCount:1,oldestPendingAt:at(1000)},'EXPIRED_RECEIPT_LEASE'],[{quarantineCount:1},'QUARANTINED_RECEIPT'],
 [{legacyQuarantineCount:1},'QUARANTINED_RECEIPT'],[{uncertainCount:1,oldestUncertainAt:at(300001)},'UNCERTAIN_CHECKOUT'],
 [{expiredUnsettledCount:1},'EXPIRED_USAGE_RESERVATION'],[{quarantineCount:1001},'COUNT_LIMIT_REACHED']];
 for(const [patch,alert] of cases){const r=assess({...base(),...patch},now);assert.equal(r.status,'ATTENTION');assert.ok(r.alerts.includes(alert));}
 assert.deepEqual(assess({...base(),pendingCount:1,oldestPendingAt:at(300000)},now).alerts,[]);
});
test('unknown fields, raw payloads, stale or invalid dates/counts and internally inconsistent snapshots fail closed',()=>{
 const bad=[null,[],{...base(),raw:'secret'}, {...base(),pendingCount:'0'}, {...base(),pendingCount:-1},
 {...base(),pendingCount:1002},{...base(),expiredLeaseCount:2003},{...base(),pendingCount:1},
 {...base(),oldestUncertainAt:at(100)}, {...base(),lastAdmissionAt:at(-6000)},
 {...base(),observedAt:at(60001)},{...base(),observedAt:'invalid'}, {...base(),owner:null},
 {...base(),merchantBound:'true'},{...base(),epoch:NaN},{...base(),processingEvidence:'SUCCESS'},
 {...base(),countLimit:999},{...base(),expiredLeaseCount:1},{...base(),observedAt:'2026-02-31T09:40:00Z'}];
 for(const value of bad)assert.throws(()=>assess(value,now),/^Error: OPERATIONS_UNAVAILABLE$/);
});
test('disabled/wrong-project/missing or malformed private credentials never make a request',async()=>{
 let calls=0;const request=async()=>{calls++;return response(base());};
 for(const patch of [{CLUERA_OPERATIONS_READ_ENABLED:'false'},{NEXT_PUBLIC_SUPABASE_URL:'https://foreign.invalid'},
 {SUPABASE_SERVICE_ROLE_KEY:undefined},{SUPABASE_SERVICE_ROLE_KEY:'bad\n'},{SUPABASE_SERVICE_ROLE_KEY:'x'.repeat(4097)}])
 await assert.rejects(run({...env,...patch},request,()=>now),/^Error: OPERATIONS_UNAVAILABLE$/);
 assert.equal(calls,0);
});
test('one fixed-target SELECT RPC with no cookies/redirects, never a worker/provider/financial endpoint',async()=>{
 const calls=[];const r=await run(env,async(url,init)=>{calls.push([url,init]);return response(base());},()=>now);
 assert.equal(r.status,'OBSERVED');assert.equal(calls.length,1);const [url,init]=calls[0];
 assert.equal(url,URL);assert.equal(init.method,'POST');assert.equal(init.body,'{}');assert.equal(init.cache,'no-store');
 assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);
 assert.equal(init.signal.aborted,true);assert.ok(!JSON.stringify(r).includes(env.SUPABASE_SERVICE_ROLE_KEY));
});
test('total request/body deadlines terminate hung dependencies without retry or waiting for cancellation',{timeout:15000},async()=>{
 let requests=0;
 const hungRequest=run(env,async()=>{requests++;return new Promise(()=>{});},()=>now);
 const hungBody=run(env,async()=>{requests++;return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});},()=>now);
 const results=await Promise.allSettled([hungRequest,hungBody]);
 assert.equal(requests,2);for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.message,'OPERATIONS_UNAVAILABLE');}
});
test('upstream errors, redirects, private payloads, oversized bodies and numeric string values are discarded',async()=>{
 for(const fixture of [()=>new Response('private upstream key',{status:503}),()=>new Response('{}',{status:302,headers:{location:'https://foreign.invalid'}}),
 ()=>new Response('x'.repeat(4097),{headers:{'content-type':'application/json'}}),
 ()=>new Response('{}',{headers:{'content-type':'text/html'}}),()=>response({...base(),private:'raw'}),
 ()=>response({...base(),uncertainCount:'0'}),()=>{throw Error(env.SUPABASE_SERVICE_ROLE_KEY);}]){
 await assert.rejects(run(env,async()=>fixture(),()=>now),/^Error: OPERATIONS_UNAVAILABLE$/);
 }
});
