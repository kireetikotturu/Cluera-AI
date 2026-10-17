'use strict';
// Protected complete-source operator diagnostic: GET proof only, no artifact.
const {auditMerchantPinEvidence,merchantPinEvidenceLine}=require('./audit-cluera-test-readiness.cjs');
if(require.main===module){
 const args=process.argv.slice(2),options=args.length===1&&/^[a-f0-9]{40}$/.test(args[0])?{expectedSourceSha:args[0]}:{};
 auditMerchantPinEvidence(process.env,fetch,options).then(value=>{console.log(merchantPinEvidenceLine(value));})
  .catch(()=>{console.log(merchantPinEvidenceLine(null));}).finally(()=>{process.exitCode=2;});
}
