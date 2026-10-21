'use strict';
const base=require('./check-cluera-operations.cjs');
const extra=['mode','activeBank','intakeEnabled','checkoutEnabled','nativeEnabled','cancellationCount','oldestCancellationAt','commandCount','oldestCommandAt','uncertainCommandCount'];
function assess(value,now=Date.now()){
 if(!value||typeof value!=='object'||value.mode!=='live'||!['test','live'].includes(value.activeBank)
 ||['intakeEnabled','checkoutEnabled','nativeEnabled'].some(k=>typeof value[k]!=='boolean')
 ||value.checkoutEnabled&&!value.intakeEnabled||value.legacyPendingCount!==0||value.legacyQuarantineCount!==0||value.oldestLegacyPendingAt!==null
 ||['cancellationCount','commandCount','uncertainCommandCount'].some(k=>!Number.isSafeInteger(value[k])||value[k]<0||value[k]>(k==='uncertainCommandCount'?2002:1001))
 ||value.uncertainCommandCount>value.cancellationCount+value.commandCount)throw Error('OPERATIONS_UNAVAILABLE');
 const core=Object.fromEntries(Object.entries(value).filter(([k])=>!extra.includes(k)));
 const report=base.assess(core,now);
 for(const [count,date] of [['cancellationCount','oldestCancellationAt'],['commandCount','oldestCommandAt']]){
  // Reuse the strict bounded timestamp and count/date validation.
  base.assess({...core,uncertainCount:value[count],oldestUncertainAt:value[date]},now);
 }
 const disabled=!value.intakeEnabled&&!value.checkoutEnabled&&value.activeBank==='test';
 const alerts=report.alerts.filter(a=>!disabled||!['PROCESSING_OWNER_UNAVAILABLE','WORKER_ADMISSION_STALE'].includes(a));
 if(value.activeBank==='live'&&!value.intakeEnabled)alerts.push('LIVE_INTAKE_DISABLED');
 if(value.checkoutEnabled&&value.activeBank!=='live')alerts.push('CHECKOUT_BANK_MISMATCH');
 if(value.uncertainCommandCount)alerts.push('COMMAND_REVIEW_REQUIRED');
 for(const [count,date,alert] of [['cancellationCount','oldestCancellationAt','CANCELLATION_PENDING'],['commandCount','oldestCommandAt','NATIVE_COMMAND_PENDING']])
  if(value[count]&&Date.parse(value.observedAt)-Date.parse(value[date])>300000)alerts.push(alert);
 if(value.cancellationCount>1000||value.commandCount>1000)alerts.push('COMMAND_COUNT_LIMIT_REACHED');
 return Object.freeze({...report,scope:'CLUERA_LIVE_PRIVATE_OPERATIONS_SELECT_ONLY',status:alerts.length?'ATTENTION':disabled?'DISABLED':'OBSERVED',alerts:Object.freeze(alerts),snapshot:Object.freeze({...value})});
}
const run=(env=process.env,request=fetch,now=Date.now)=>base.run(env,request,now,'live');
module.exports={assess,run};
if(require.main===module){
 const fail=()=>{console.log('{"scope":"CLUERA_LIVE_PRIVATE_OPERATIONS_SELECT_ONLY","status":"UNAVAILABLE","financialMutations":0,"productionReady":false}');process.exitCode=2;};
 if(process.argv.length!==2)fail();else run().then(r=>{console.log(JSON.stringify(r));if(r.alerts.length)process.exitCode=1;}).catch(fail);
}
