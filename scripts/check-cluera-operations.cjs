'use strict';
// Fixed-target private SELECT RPC only. Never dispatches, wakes, reconciles,
// creates a receipt/payment/grant or calls a provider/notification destination.
const TARGET='https://yhnqlfcgrmckhyjdxegg.supabase.co';
const URL=TARGET+'/rest/v1/rpc/cluera_operations_health';
const fields=['version','observedAt','owner','epoch','merchantBound','lastAdmissionAt','pendingCount','oldestPendingAt','legacyPendingCount','oldestLegacyPendingAt','expiredLeaseCount','quarantineCount','legacyQuarantineCount','uncertainCount','oldestUncertainAt','expiredUnsettledCount','countLimit','processingEvidence'];
const counts=['pendingCount','legacyPendingCount','expiredLeaseCount','quarantineCount','legacyQuarantineCount','uncertainCount','expiredUnsettledCount'];
const dates=['lastAdmissionAt','oldestPendingAt','oldestLegacyPendingAt','oldestUncertainAt'];
function timestamp(v){return typeof v==='string'&&v.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString().slice(0,19)===v.slice(0,19);}
function assess(value,now=Date.now()){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))
 ||value.version!==1||value.countLimit!==1000||value.processingEvidence!=='NONCE_ADMISSION_ONLY'
 ||!timestamp(value.observedAt)||!['cluera','account',null].includes(value.owner)
 ||value.epoch!==null&&(!Number.isSafeInteger(value.epoch)||value.epoch<=0)
 ||typeof value.merchantBound!=='boolean'||!Number.isFinite(now)
 ||counts.some(k=>!Number.isSafeInteger(value[k])||value[k]<0||value[k]>(k==='expiredLeaseCount'?2002:1001))
 ||value.expiredLeaseCount>value.pendingCount+value.legacyPendingCount
 ||dates.some(k=>value[k]!==null&&(!timestamp(value[k])||Date.parse(value[k])>Date.parse(value.observedAt)+5000))
 ||Math.abs(Date.parse(value.observedAt)-now)>60000)throw Error('OPERATIONS_UNAVAILABLE');
 for(const [count,date] of [['pendingCount','oldestPendingAt'],['legacyPendingCount','oldestLegacyPendingAt'],['uncertainCount','oldestUncertainAt']])
  if((value[count]===0)!==(value[date]===null))throw Error('OPERATIONS_UNAVAILABLE');
 if((value.owner===null)!==(value.epoch===null)||value.owner===null&&value.merchantBound)throw Error('OPERATIONS_UNAVAILABLE');
 const alerts=[];
 const age=k=>value[k]===null?Infinity:Math.max(0,Date.parse(value.observedAt)-Date.parse(value[k]));
 if(value.owner!=='cluera'||!value.merchantBound)alerts.push('PROCESSING_OWNER_UNAVAILABLE');
 if(age('lastAdmissionAt')>5*60000)alerts.push('WORKER_ADMISSION_STALE');
 if(value.pendingCount&&age('oldestPendingAt')>5*60000)alerts.push('CLUERA_RECEIPT_BACKLOG');
 if(value.legacyPendingCount&&age('oldestLegacyPendingAt')>5*60000)alerts.push('RETAINED_RECEIPT_BACKLOG');
 if(value.expiredLeaseCount)alerts.push('EXPIRED_RECEIPT_LEASE');
 if(value.quarantineCount||value.legacyQuarantineCount)alerts.push('QUARANTINED_RECEIPT');
 if(value.uncertainCount&&age('oldestUncertainAt')>5*60000)alerts.push('UNCERTAIN_CHECKOUT');
 if(value.expiredUnsettledCount)alerts.push('EXPIRED_USAGE_RESERVATION');
 if(counts.some(k=>value[k]>1000))alerts.push('COUNT_LIMIT_REACHED');
 return Object.freeze({scope:'CLUERA_PRIVATE_OPERATIONS_SELECT_ONLY',status:alerts.length?'ATTENTION':'OBSERVED',observedAt:value.observedAt,
  alerts:Object.freeze(alerts),snapshot:Object.freeze({...value}),financialMutations:0,creditEffect:'NOT_INFERRED',productionReady:false});
}
async function run(env=process.env,request=fetch,now=Date.now,mode='test'){
 if(!['test','live'].includes(mode))throw Error('OPERATIONS_UNAVAILABLE');
 const url=mode==='test'?URL:TARGET+'/rest/v1/rpc/cluera_live_billing_operations_health';
 const key=env.SUPABASE_SERVICE_ROLE_KEY;
 if(env[mode==='test'?'CLUERA_OPERATIONS_READ_ENABLED':'CLUERA_LIVE_OPERATIONS_READ_ENABLED']!=='true'||env.NEXT_PUBLIC_SUPABASE_URL!==TARGET
 ||typeof key!=='string'||key.length<32||key.length>4096||/[\x00-\x20\x7f]/.test(key))throw Error('OPERATIONS_UNAVAILABLE');
 const controller=new AbortController();let timer,reader;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('OPERATIONS_UNAVAILABLE'));},6000);});
 try{
  const response=await Promise.race([request(url,{method:'POST',body:'{}',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},
   cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal}),expired]);
  if(response.status!==200||response.redirected||response.url&&response.url!==url
  ||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||!response.body)throw Error('OPERATIONS_UNAVAILABLE');
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(declared)||Number(declared)>4096))throw Error('OPERATIONS_UNAVAILABLE');
  reader=response.body.getReader();const chunks=[];let size=0;
  for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;size+=part.value.byteLength;if(size>4096)throw Error('OPERATIONS_UNAVAILABLE');chunks.push(part.value);}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  return mode==='test'?assess(value,now()):require('./check-cluera-live-operations.cjs').assess(value,now());
 }catch{throw Error('OPERATIONS_UNAVAILABLE');}
 finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{}}
}
module.exports={assess,run,TARGET,URL};
if(require.main===module){
 if(process.argv.length!==2){console.log('{"scope":"CLUERA_PRIVATE_OPERATIONS_SELECT_ONLY","status":"UNAVAILABLE","financialMutations":0,"productionReady":false}');process.exitCode=2;}
 else run().then(r=>{console.log(JSON.stringify(r));if(r.alerts.length)process.exitCode=1;}).catch(()=>{
 console.log('{"scope":"CLUERA_PRIVATE_OPERATIONS_SELECT_ONLY","status":"UNAVAILABLE","financialMutations":0,"productionReady":false}');process.exitCode=2;});
}
