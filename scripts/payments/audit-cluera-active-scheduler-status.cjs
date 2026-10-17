'use strict';
// Protected complete-source metadata diagnostic only; never website promotion.
const {auditActiveStatus}=require('./audit-cluera-scheduler-status.cjs');
if(require.main===module){
 const args=process.argv.slice(2),options=args.length===2&&/^[a-f0-9]{40}$/.test(args[0])&&['false','true'].includes(args[1])
  ?{expectedSourceSha:args[0],expectedRelayEnabled:args[1]==='true'}:{};
 auditActiveStatus(process.env,fetch,options).then(value=>{console.log('CLUERA_ACTIVE_SCHEDULER_STATUS '+JSON.stringify(value));process.exitCode=1;})
  .catch(()=>{console.log('CLUERA_ACTIVE_SCHEDULER_STATUS '+JSON.stringify({mode:'ACTIVE_METADATA_ONLY',stopped:'UNAVAILABLE',activationAuthorized:false,
   processingEnabled:false,diagnosticProcessingInvoked:false,expectedRelayEnabled:null,observedRelayEnabled:null,requests:0,dispatchRequests:0,wakeRequests:0,databaseRequests:0,
   providerRequests:0,mutations:0,fullTreeAttested:false,externalDeploymentVerificationRequired:true}));process.exitCode=1;});
}
