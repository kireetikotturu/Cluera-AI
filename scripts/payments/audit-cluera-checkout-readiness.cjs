'use strict';
// Protected complete-source GET proof only; no Checkout, Auth, DB or payment.
const {auditCheckoutPrepared,auditCheckout}=require('./audit-cluera-test-readiness.cjs');
if(require.main===module){const [phase,expectedSourceSha,expectedWebhookId,expectedOwnerUuid,...extra]=process.argv.slice(2);
 const options=extra.length?{}:{expectedSourceSha,expectedWebhookId,expectedOwnerUuid};
 const audit=phase==='prepared'?auditCheckoutPrepared:phase==='enabled'?auditCheckout:null;
 (audit?audit(process.env,fetch,options):Promise.reject(Error('CONFIGURATION'))).then(report=>{
  console.log('CLUERA_CHECKOUT_READINESS '+JSON.stringify(report));process.exitCode=2;
 }).catch(()=>{console.log('CLUERA_CHECKOUT_READINESS {"stopped":"UNAVAILABLE","mutations":0,"activationAuthorized":false}');process.exitCode=2;});
}
