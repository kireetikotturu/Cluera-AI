'use strict';
const {auditReceiver}=require('./audit-cluera-test-readiness.cjs');
const failure=()=>({component:'cluera-test-receiver-get-only',stopped:'UNAVAILABLE',mutations:0,activationAuthorized:false,
 financialClearance:'NOT_GRANTED',signerMatch:'UNVERIFIED',signedDelivery:'UNVERIFIED'});
async function main(){
 const args=process.argv.slice(2),options=args.length===2?{expectedSourceSha:args[0],expectedWebhookId:args[1]}:{};
 let report;try{report=await auditReceiver(process.env,fetch,options);}catch{report=failure();}
 const line='CLUERA_TEST_RECEIVER '+JSON.stringify(report);
 console.log(Buffer.byteLength(line)<=1900&&!/[\r\n]/.test(line)?line:'CLUERA_TEST_RECEIVER '+JSON.stringify(failure()));
 process.exitCode=2;
}
if(require.main===module)void main().catch(()=>{console.log('CLUERA_TEST_RECEIVER '+JSON.stringify(failure()));process.exitCode=2;});
