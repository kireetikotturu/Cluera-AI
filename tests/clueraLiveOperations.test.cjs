'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assess,run}=require('../scripts/check-cluera-live-operations.cjs');
const {TARGET}=require('../scripts/check-cluera-operations.cjs');
const now=Date.parse('2026-10-21T08:00:00Z'),at=n=>new Date(now-n).toISOString();
const fixture=()=>({version:1,observedAt:at(0),mode:'live',activeBank:'test',intakeEnabled:false,checkoutEnabled:false,nativeEnabled:false,
 owner:'account',epoch:1,merchantBound:false,lastAdmissionAt:null,pendingCount:0,oldestPendingAt:null,legacyPendingCount:0,oldestLegacyPendingAt:null,
 expiredLeaseCount:0,quarantineCount:0,legacyQuarantineCount:0,uncertainCount:0,oldestUncertainAt:null,expiredUnsettledCount:0,
 cancellationCount:0,oldestCancellationAt:null,commandCount:0,oldestCommandAt:null,uncertainCommandCount:0,countLimit:1000,processingEvidence:'NONCE_ADMISSION_ONLY'});
test('disabled empty Live installation is identified without claiming payment processing',()=>{
 const r=assess(fixture(),now);assert.equal(r.status,'DISABLED');assert.deepEqual(r.alerts,[]);assert.equal(r.productionReady,false);
 assert.equal(r.creditEffect,'NOT_INFERRED');assert.equal(r.financialMutations,0);
});
test('Live intake requires fresh admission; pending and uncertain commands alert independently',()=>{
 const r=assess({...fixture(),intakeEnabled:true,cancellationCount:1,oldestCancellationAt:at(300001),commandCount:1,oldestCommandAt:at(300001),uncertainCommandCount:1},now);
 for(const alert of ['PROCESSING_OWNER_UNAVAILABLE','WORKER_ADMISSION_STALE','CANCELLATION_PENDING','NATIVE_COMMAND_PENDING','COMMAND_REVIEW_REQUIRED'])assert.ok(r.alerts.includes(alert));
 assert.ok(assess({...fixture(),activeBank:'live'},now).alerts.includes('LIVE_INTAKE_DISABLED'));
 assert.ok(assess({...fixture(),quarantineCount:1},now).alerts.includes('QUARANTINED_RECEIPT'));
});
test('mode confusion, raw payloads and malformed snapshots fail closed',()=>{
 for(const patch of [{mode:'test'},{raw:'private'},{activeBank:'foreign'},{intakeEnabled:'true'},{commandCount:1},{oldestCommandAt:at(1)},
 {uncertainCommandCount:1},{legacyPendingCount:1,oldestLegacyPendingAt:at(1)},{checkoutEnabled:true},{commandCount:1002},{oldestCommandAt:'invalid',commandCount:1}])
 assert.throws(()=>assess({...fixture(),...patch},now),/OPERATIONS_UNAVAILABLE/);
});
test('only the explicit Live read flag permits the fixed service-only RPC',async()=>{
 const env={CLUERA_LIVE_OPERATIONS_READ_ENABLED:'true',NEXT_PUBLIC_SUPABASE_URL:TARGET,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-private-'.repeat(3)};
 let calls=0;const request=async(url,init)=>{calls++;assert.equal(url,TARGET+'/rest/v1/rpc/cluera_live_billing_operations_health');assert.equal(init.body,'{}');assert.equal(init.redirect,'error');return Response.json(fixture());};
 await assert.rejects(run({...env,CLUERA_LIVE_OPERATIONS_READ_ENABLED:undefined,CLUERA_OPERATIONS_READ_ENABLED:'true'},request,()=>now));assert.equal(calls,0);
 assert.equal((await run(env,request,()=>now)).status,'DISABLED');assert.equal(calls,1);
});
