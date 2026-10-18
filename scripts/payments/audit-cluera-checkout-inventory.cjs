'use strict';
// Protected fixed-phase Test GET inventory only. No event, payment or write.
const {auditCheckoutPreparedInventory,auditCheckoutInventory,serializeReport}=require('./audit-cluera-test-obligations.cjs');
if(require.main===module){const [phase,expectedSourceSha,expectedWebhookId,expectedOwnerUuid,...extra]=process.argv.slice(2);
 const options=extra.length?{}:{expectedSourceSha,expectedWebhookId,expectedOwnerUuid};
 const audit=phase==='prepared'?auditCheckoutPreparedInventory:phase==='enabled'?auditCheckoutInventory:null;
 (audit?audit(process.env,fetch,options):Promise.reject(Error('CONFIGURATION'))).then(report=>{
  for(const line of serializeReport(report))console.log(line);process.exitCode=2;
 }).catch(()=>{console.log('CLUERA_TEST_OBLIGATIONS_COMPLETE {"stopped":"UNAVAILABLE","completeInventory":false,"needsReview":true,"mutations":0}');process.exitCode=2;});
}
