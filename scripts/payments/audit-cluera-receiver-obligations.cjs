'use strict';
// Protected complete-source receiver-phase GET inventory. No writes or events.
const {auditReceiverInventory,serializeReport}=require('./audit-cluera-test-obligations.cjs');
if(require.main===module){const args=process.argv.slice(2),options=args.length===2?{expectedSourceSha:args[0],expectedWebhookId:args[1]}:{};
 auditReceiverInventory(process.env,fetch,options).then(report=>{
  for(const line of serializeReport(report))console.log(line);process.exitCode=2;
 }).catch(()=>{
  console.log('CLUERA_TEST_OBLIGATIONS_COMPLETE {"stopped":"UNAVAILABLE","completeInventory":false,"needsReview":true,"mutations":0}');process.exitCode=2;
 });
}
module.exports={auditReceiverInventory,serializeReport};
