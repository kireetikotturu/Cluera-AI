'use strict';
// Protected full-source diagnostic only. NO payment/settings/DB/event writes.
// Provider contracts: official razorpay/razorpay-node lib/types/{orders,payments,
// refunds,subscriptions}.d.ts and lib/resources/{refunds,subscriptions}.js.
const {audit:readiness}=require('./audit-cluera-test-readiness.cjs');
const COLLECTIONS=Object.freeze({
 orders:{entity:'order',prefix:'order_',statuses:['created','attempted','paid']},
 payments:{entity:'payment',prefix:'pay_',statuses:['created','authorized','captured','refunded','failed']},
 refunds:{entity:'refund',prefix:'rfnd_',statuses:['pending','processed','failed']},
 subscriptions:{entity:'subscription',prefix:'sub_',statuses:['created','authenticated','active','pending','halted','cancelled','completed','expired','paused']},
});
const ENV=Object.freeze(['VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA',
 'SIGMAROUND_ACCOUNTS_ENABLED','SIGMAROUND_ACCOUNT_ORIGIN','NEXT_PUBLIC_SUPABASE_URL','SIGMAROUND_RAZORPAY_TEST_PROJECT_REF',
 'RAZORPAY_ENVIRONMENT','SIGMAROUND_PAYMENT_PROVIDER','SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','CLUERA_BILLING_V2_ENABLED',
 'CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED',
 'SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','RAZORPAY_TEST_KEY_ID','RAZORPAY_TEST_KEY_SECRET','RAZORPAY_TEST_WEBHOOK_SECRET','RAZORPAY_TEST_ACCOUNT_ID']);
const WARNINGS=Object.freeze(['NONEMPTY_HISTORY','UNKNOWN_STATUS','INVALID_RECORD','INVALID_AMOUNT','NON_INR_CURRENCY','UNKNOWN_CURRENCY',
 'INCONSISTENT_ORDER','INCONSISTENT_REFUND','INCONSISTENT_CAPTURE','INCONSISTENT_CYCLES','AMOUNT_OVERFLOW','DUPLICATE_ID',
 'COLLECTION_SHAPE','PAGE_CAP','HTTP_AUTH','HTTP_RATE_LIMIT','HTTP_UNAVAILABLE','REDIRECT','CONTENT_TYPE','BODY_BOUND',
 'MALFORMED_BODY','DEADLINE','NETWORK','MISSING_ORDER_REFERENCE','MISSING_PAYMENT_REFERENCE','CROSS_CURRENCY',
 'ORDER_PAYMENT_TOTAL_REVIEW','REFUND_TOTAL_REVIEW','SUBSCRIPTION_AMOUNT_UNAVAILABLE']);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const id=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix)&&/^[A-Za-z0-9]{1,64}$/.test(value.slice(prefix.length));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function environment(input){
 if(!object(input))throw Error('CONFIGURATION');const env=Object.create(null);
 for(const key of ENV){const d=Object.getOwnPropertyDescriptor(input,key);
  if(d&&(!Object.hasOwn(d,'value')||typeof d.value!=='string'))throw Error('CONFIGURATION');if(d)env[key]=d.value;}
 return Object.freeze(env);
}
function collection(name){return {complete:false,pages:0,records:0,invalidRecords:0,duplicateIds:0,
 statuses:Object.fromEntries([...COLLECTIONS[name].statuses,'unknown'].map(status=>[status,0])),
 currency:name==='subscriptions'?null:{INR:0,other:0,unknown:0},
 amounts:name==='subscriptions'?null:{unit:'minor-units',currency:'INR',knownAmount:0,
  ...(name==='orders'?{knownPaid:0}:name==='payments'?{knownRefunded:0}:{}),complete:true},warnings:[]};}
function base(){return {component:'cluera-test-obligations-get-only',scope:'CONFIGURED_TEST_MERCHANT_ONLY',mutations:0,requests:0,
 financialRequests:0,completeInventory:false,needsReview:true,atomicSnapshot:false,
 limitation:'BOUNDED_NON_ATOMIC_TEST_COLLECTIONS_NOT_FINANCIAL_CLEARANCE',financialClearance:'NOT_GRANTED',obligationsUnresolved:true,
 liveReviewed:false,paddleReviewed:false,warnings:[],
 databaseCompared:false,signedDeliveryVerified:false,activationAuthorized:false,fullTreeAttested:false,externalDeploymentVerificationRequired:true,
 limits:{count:100,maxPagesPerCollection:10,maxFinancialRequests:40,bodyBytes:262144,requestDeadlineMs:10000,totalDeadlineMs:500000},
 merchant:{configurationAccepted:false,testAuthentication:false,listingComplete:false,verified:false,newDestinationState:'UNVERIFIED'},
 collections:Object.fromEntries(Object.keys(COLLECTIONS).map(name=>[name,collection(name)]))};}
/** Never return provider fields, IDs, request headers, exceptions or dynamic keys. */
async function audit(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 const report=base(),warning=(target,code)=>{if(!WARNINGS.includes(code))code='NETWORK';if(!target.warnings.includes(code))target.warnings.push(code);};
 const finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});
 let env,lastClock=-Infinity,deadline;
 const now=()=>{const value=monotonic();if(!Number.isFinite(value)||value<lastClock)throw Error('DEADLINE');lastClock=value;return value;};
 try{env=environment(input);if(typeof request!=='function'||typeof monotonic!=='function')throw Error('CONFIGURATION');deadline=now()+500000;}
 catch{return finish('CONFIGURATION');}
 // Shared auditor loads the ACTUAL application guard and requires all five
 // payment flags literally false, pause=true, exact clean DB/origin and Test keys.
 // It performs ONLY webhook GETs: no financial read precedes merchant proof.
 let proof;try{proof=await readiness(env,request,options,now);}catch{return finish('MERCHANT_REVIEW_REQUIRED');}
 report.requests=Number.isSafeInteger(proof.requests)?proof.requests:0;
 report.merchant={configurationAccepted:proof.configurationAccepted===true&&proof.actualPaymentGuardLoaded===true,
  testAuthentication:proof.testAuthentication===true,listingComplete:proof.listing?.complete===true,verified:proof.merchantVerified===true,
  newDestinationState:['MISSING','AMBIGUOUS','MATCHED_TEST_MERCHANT','IDENTITY_REVIEW','DIRECT_UNAVAILABLE','DIRECT_IDENTITY_REVIEW'].includes(proof.destinations?.clueraV2?.state)
   ?proof.destinations.clueraV2.state:'UNVERIFIED'};
 if(proof.stopped!=='READ_ONLY_REVIEW_COMPLETE'||!report.merchant.configurationAccepted||!report.merchant.testAuthentication
  ||!report.merchant.listingComplete||!report.merchant.verified)return finish(proof.stopped==='CONFIGURATION'?'CONFIGURATION':'MERCHANT_REVIEW_REQUIRED');
 const headers={Authorization:'Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'),Accept:'application/json'};
 const maps=Object.fromEntries(Object.keys(COLLECTIONS).map(name=>[name,new Map()]));
 async function get(name,page){
  if(!Object.hasOwn(COLLECTIONS,name)||!Number.isInteger(page)||page<0||page>=10)throw Error('COLLECTION_SHAPE');
  const started=now(),remaining=Math.min(10000,deadline-started);if(remaining<=0)throw Error('DEADLINE');
  const requestDeadline=started+remaining;
  const inTime=()=>{if(now()>requestDeadline)throw Error('DEADLINE');};
  const url='https://api.razorpay.com/v1/'+name+'?count=100&skip='+page*100;
  const controller=new AbortController();let reader,timer;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DEADLINE'));void reader?.cancel().catch(()=>{});},remaining);});
  try{
   report.requests++;report.financialRequests++;
   const response=await Promise.race([request(url,{method:'GET',headers,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal}),expired]);inTime();
   if(response.redirected||response.status>=300&&response.status<400||response.url&&response.url!==url)throw Error('REDIRECT');
   if(response.status!==200)throw Error([401,403].includes(response.status)?'HTTP_AUTH':response.status===429?'HTTP_RATE_LIMIT':'HTTP_UNAVAILABLE');
   if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error('CONTENT_TYPE');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))throw Error('BODY_BOUND');
   if(!response.body)throw Error('MALFORMED_BODY');reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);inTime();if(part.done)break;
    if(!(part.value instanceof Uint8Array))throw Error('MALFORMED_BODY');bytes+=part.value.byteLength;if(bytes>262144)throw Error('BODY_BOUND');chunks.push(part.value);}
   let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Error('MALFORMED_BODY');}
   inTime();return value;
  }finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* No unbounded cancellation wait. */}}
 }
 function add(total,key,value,target){if(total[key]===null)return;if(!Number.isSafeInteger(total[key]+value)){
  total[key]=null;total.complete=false;warning(target,'AMOUNT_OVERFLOW');}else total[key]+=value;}
 function money(row,target){
  if(row.currency==='INR')target.currency.INR++;
  else if(typeof row.currency==='string'&&/^[A-Z]{3}$/.test(row.currency)){target.currency.other++;warning(target,'NON_INR_CURRENCY');}
  else{target.currency.unknown++;warning(target,'UNKNOWN_CURRENCY');}
  const valid=integer(row.amount)&&row.amount>0;
  if(!valid){target.amounts.complete=false;warning(target,'INVALID_AMOUNT');}
  if(row.currency!=='INR')target.amounts.complete=false;
  if(valid&&row.currency==='INR')add(target.amounts,'knownAmount',row.amount,target);return valid;
 }
 function record(name,row,target){
  const spec=COLLECTIONS[name];
  if(!object(row)||!id(row.id,spec.prefix)||row.entity!==spec.entity){target.invalidRecords++;warning(target,'INVALID_RECORD');return;}
  if(maps[name].has(row.id)){target.duplicateIds++;warning(target,'DUPLICATE_ID');return;}
  // Retain only private reconciliation fields; discard customer/contact/notes,
  // payment instrument metadata and other unneeded provider fields immediately.
  maps[name].set(row.id,{id:row.id,status:row.status,amount:row.amount,currency:row.currency,amount_paid:row.amount_paid,
   amount_refunded:row.amount_refunded,order_id:row.order_id,payment_id:row.payment_id});target.records++;
  const status=spec.statuses.includes(row.status)?row.status:'unknown';target.statuses[status]++;
  if(status==='unknown')warning(target,'UNKNOWN_STATUS');
  if(name==='subscriptions'){
   warning(target,'SUBSCRIPTION_AMOUNT_UNAVAILABLE');
   const cycles=value=>integer(value)?value:typeof value==='string'&&/^(?:0|[1-9]\d{0,14})$/.test(value)&&integer(Number(value))?Number(value):null;
   const total=cycles(row.total_count),paid=cycles(row.paid_count),remaining=cycles(row.remaining_count);
   if(total===null||paid===null||remaining===null||paid>total||remaining>total||paid+remaining>total
     ||status==='completed'&&remaining!==0)warning(target,'INCONSISTENT_CYCLES');return;
  }
  const amountValid=money(row,target);
  if(name==='orders'){
   if(!integer(row.amount_paid)||!integer(row.amount_due)||!amountValid||row.amount_paid>row.amount||row.amount_due!==row.amount-row.amount_paid
    ||status==='paid'&&(row.amount_paid!==row.amount||row.amount_due!==0)||status==='created'&&row.amount_paid!==0){
    warning(target,'INCONSISTENT_ORDER');target.amounts.complete=false;}
   if(integer(row.amount_paid)&&row.currency==='INR')add(target.amounts,'knownPaid',row.amount_paid,target);
  }else if(name==='payments'){
   const refunded=integer(row.amount_refunded)&&amountValid&&row.amount_refunded<=row.amount;
   const refundStatus=row.refund_status===null||row.refund_status==='null'?'none':row.refund_status;
   if(!refunded||!['none','partial','full'].includes(refundStatus)
    ||refunded&&(refundStatus==='none'&&row.amount_refunded!==0||refundStatus==='partial'&&(row.amount_refunded===0||row.amount_refunded===row.amount)
      ||refundStatus==='full'&&row.amount_refunded!==row.amount)||status==='refunded'&&refundStatus!=='full'){
    warning(target,'INCONSISTENT_REFUND');target.amounts.complete=false;}
   if(typeof row.captured!=='boolean'||['captured','refunded'].includes(status)&&row.captured!==true
    ||['created','authorized','failed'].includes(status)&&row.captured!==false)warning(target,'INCONSISTENT_CAPTURE');
   if(integer(row.amount_refunded)&&row.currency==='INR')add(target.amounts,'knownRefunded',row.amount_refunded,target);
   if(row.order_id!==null&&!id(row.order_id,'order_'))warning(target,'MISSING_ORDER_REFERENCE');
  }else if(!id(row.payment_id,'pay_'))warning(target,'MISSING_PAYMENT_REFERENCE');
 }
 for(const name of Object.keys(COLLECTIONS)){
  const target=report.collections[name];
  try{
   for(let page=0;page<10;page++){
    const raw=await get(name,page);
    if(!object(raw)||raw.entity!=='collection'||!Array.isArray(raw.items)||raw.items.length>100||raw.count!==raw.items.length
      ||!integer(raw.count)||Object.keys(raw).some(key=>!['entity','count','items'].includes(key)))throw Error('COLLECTION_SHAPE');
    target.pages++;for(const row of raw.items)record(name,row,target);
    if(target.invalidRecords||target.duplicateIds)break;
    if(raw.items.length<100){target.complete=true;break;}
   }
   if(!target.complete&&!target.invalidRecords&&!target.duplicateIds)warning(target,'PAGE_CAP');
  }catch(error){warning(target,WARNINGS.includes(error?.message)?error.message:'NETWORK');}
  if(target.amounts&&!target.complete)target.amounts.complete=false;
  if(target.records)warning(target,'NONEMPTY_HISTORY');
 }
 // Linkage reads are NOT atomic: mismatches require review, never a mutation.
 const capturedByOrder=new Map(),refundsByPayment=new Map();
 const sum=(map,key,amount)=>{if(map.get(key)===null)return;const value=(map.get(key)??0)+amount;map.set(key,Number.isSafeInteger(value)?value:null);};
 for(const row of maps.payments.values()){
  const target=report.collections.payments,order=maps.orders.get(row.order_id);
  if(row.order_id!==null&&!order&&report.collections.orders.complete)warning(target,'MISSING_ORDER_REFERENCE');
  if(order&&row.currency!==order.currency)warning(target,'CROSS_CURRENCY');
  if(id(row.order_id,'order_')&&integer(row.amount)&&['captured','refunded'].includes(row.status))sum(capturedByOrder,row.order_id,row.amount);
 }
 for(const row of maps.refunds.values()){
  const target=report.collections.refunds,payment=maps.payments.get(row.payment_id);
  if(!payment&&report.collections.payments.complete)warning(target,'MISSING_PAYMENT_REFERENCE');
  if(payment&&(row.currency!==payment.currency||integer(row.amount)&&row.amount>payment.amount))warning(target,row.currency!==payment.currency?'CROSS_CURRENCY':'INCONSISTENT_REFUND');
  if(row.status==='processed'&&integer(row.amount))sum(refundsByPayment,row.payment_id,row.amount);
 }
 if(report.collections.payments.complete)for(const [key,row] of maps.orders){
  const amount=capturedByOrder.get(key)??0;if(capturedByOrder.get(key)===null||integer(row.amount_paid)&&amount!==row.amount_paid)warning(report.collections.orders,'ORDER_PAYMENT_TOTAL_REVIEW');}
 if(report.collections.refunds.complete)for(const [key,row] of maps.payments){
  const amount=refundsByPayment.get(key)??0;if(refundsByPayment.get(key)===null||integer(row.amount_refunded)&&amount!==row.amount_refunded)warning(report.collections.payments,'REFUND_TOTAL_REVIEW');}
 report.completeInventory=Object.values(report.collections).every(target=>target.complete);
 report.needsReview=!report.completeInventory||Object.values(report.collections).some(target=>target.records>0||target.warnings.length>0);
 try{if(now()>deadline)throw Error('DEADLINE');}catch{
  report.completeInventory=false;report.needsReview=true;warning(report,'DEADLINE');return finish('INVENTORY_DEADLINE');}
 // Empty complete Test collections do NOT clear Live/Paddle, ownership or grants.
 return finish('READ_ONLY_INVENTORY_COMPLETE');
}
module.exports={audit};
if(require.main===module){const args=process.argv.slice(2),options=args.length===1?{expectedSourceSha:args[0]}:{};
 audit(process.env,fetch,options).then(report=>{console.log('CLUERA_TEST_OBLIGATIONS '+JSON.stringify(report));process.exitCode=2;})
 .catch(()=>{console.log('CLUERA_TEST_OBLIGATIONS '+JSON.stringify({component:'cluera-test-obligations-get-only',stopped:'UNAVAILABLE',completeInventory:false,needsReview:true,mutations:0}));process.exitCode=2;});}
