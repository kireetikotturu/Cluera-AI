'use strict';
// Protected full-source diagnostic only. NO payment/settings/DB/event writes.
// Provider contracts: official razorpay/razorpay-node lib/types/{orders,payments,
// refunds,subscriptions}.d.ts and lib/resources/{refunds,subscriptions}.js.
const {audit:readiness,auditReceiver:receiverReadiness,auditCheckoutPrepared:preparedReadiness,auditCheckout:checkoutReadiness}=require('./audit-cluera-test-readiness.cjs');
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
// Fixed aggregate observations ONLY. Invalid/missing operands are not evidence
// that an otherwise numeric order equation is wrong. Never return raw values.
const ORDER_FACTS=Object.freeze(['amountMissing','amountNonNumeric','amountOutOfRange',
 'paidMissing','paidNonNumeric','paidOutOfRange','dueMissing','dueNonNumeric','dueOutOfRange',
 'paidExceedsAmount','dueEquationMismatch','paidStateMismatch','createdStateMismatch']);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const id=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix)&&/^[A-Za-z0-9]{1,64}$/.test(value.slice(prefix.length));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function environment(input,receiver=false,checkout=false){
 if(!object(input))throw Error('CONFIGURATION');const env=Object.create(null);
 const names=[...ENV,...(receiver?['CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED']:[]),...(checkout?
  ['SIGMAROUND_PAYMENT_TESTER_IDS','CLUERA_PROVIDER_VAULT_ENABLED','CLUERA_AI_BOOTSTRAP_MODE','CLUERA_PROVIDER_VAULT_KEYRING_BASE64']:[])];
 for(const key of names){const d=Object.getOwnPropertyDescriptor(input,key);
  if(d&&(!Object.hasOwn(d,'value')||typeof d.value!=='string'))throw Error('CONFIGURATION');if(d)env[key]=d.value;}
 return Object.freeze(env);
}
function collection(name){return {complete:false,pages:0,records:0,invalidRecords:0,duplicateIds:0,
 statuses:Object.fromEntries([...COLLECTIONS[name].statuses,'unknown'].map(status=>[status,0])),
 currency:name==='subscriptions'?null:{INR:0,other:0,unknown:0},
 amounts:name==='subscriptions'?null:{unit:'minor-units',currency:'INR',knownAmount:0,
  ...(name==='orders'?{knownPaid:0}:name==='payments'?{knownRefunded:0}:{}),complete:true},
 ...(name==='orders'?{validationFacts:Object.fromEntries(ORDER_FACTS.map(key=>[key,0]))}:{}),warnings:[]};}
function base(){return {component:'cluera-test-obligations-get-only',scope:'CONFIGURED_TEST_MERCHANT_ONLY',mutations:0,requests:0,
 financialRequests:0,completeInventory:false,needsReview:true,atomicSnapshot:false,
 limitation:'BOUNDED_NON_ATOMIC_TEST_COLLECTIONS_NOT_FINANCIAL_CLEARANCE',financialClearance:'NOT_GRANTED',obligationsUnresolved:true,
 liveReviewed:false,paddleReviewed:false,warnings:[],
 databaseCompared:false,signedDeliveryVerified:false,activationAuthorized:false,fullTreeAttested:false,externalDeploymentVerificationRequired:true,
 limits:{count:100,maxPagesPerCollection:10,maxFinancialRequests:40,bodyBytes:262144,requestDeadlineMs:10000,totalDeadlineMs:500000},
 merchant:{configurationAccepted:false,testAuthentication:false,listingComplete:false,verified:false,newDestinationState:'UNVERIFIED'},
 collections:Object.fromEntries(Object.keys(COLLECTIONS).map(name=>[name,collection(name)]))};}
/** Never return provider fields, IDs, request headers, exceptions or dynamic keys. */
async function inspect(input=process.env,request=fetch,options={},monotonic=()=>performance.now(),receiver=false,checkout=null){
 const report=base(),warning=(target,code)=>{if(!WARNINGS.includes(code))code='NETWORK';if(!target.warnings.includes(code))target.warnings.push(code);};
 const finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});
 let env,lastClock=-Infinity,deadline;
 const now=()=>{const value=monotonic();if(!Number.isFinite(value)||value<lastClock)throw Error('DEADLINE');lastClock=value;return value;};
 try{env=environment(input,receiver||checkout!==null,checkout!==null);if(typeof request!=='function'||typeof monotonic!=='function')throw Error('CONFIGURATION');deadline=now()+500000;}
 catch{return finish('CONFIGURATION');}
 // Each entry point uses its own ACTUAL application phase guard. The original
 // remains OFF-only; receiver proof requires intake-only flags, the operator's
 // exact webhook ID and one consistent canonical Test destination. Neither
 // performs a financial resource read before its bounded webhook proof.
 const verifier=checkout==='prepared'?preparedReadiness:checkout==='enabled'?checkoutReadiness:receiver?receiverReadiness:readiness;
 let proof;try{proof=await verifier(env,request,options,now);}catch{return finish('MERCHANT_REVIEW_REQUIRED');}
 report.requests=Number.isSafeInteger(proof.requests)?proof.requests:0;
 if(receiver||checkout!==null){
  // Map only the completed fixed projection, never infer equality/delivery from
  // partial key authentication or secret presence.
  const phaseAccepted=checkout===null?proof.stopped==='RECEIVER_CONFIGURATION_VERIFIED'&&proof.receiverConfigurationAccepted===true&&proof.actualCheckoutDisabledVerified===true
   :proof.stopped===(checkout==='prepared'?'CHECKOUT_PREPARED_CONFIGURATION_VERIFIED':'CHECKOUT_CONFIGURATION_VERIFIED')
    &&proof.phase===checkout&&proof.checkoutConfigurationAccepted===true&&proof.actualCheckoutEnabled===(checkout==='enabled')
    &&proof.actualOwnerAllowed===(checkout==='enabled')&&proof.foreignTesterDenied===true&&proof.soleTesterVerified===true
    &&proof.approvedOwnerMatches===true&&proof.providerConfigurationDisabled===true;
  const accepted=phaseAccepted&&proof.configurationAccepted===true&&proof.actualIntakeVerified===true
   &&proof.operatorIdMatches===true&&proof.merchantVerified===true&&proof.listing?.complete===true
   &&proof.listing.records===1&&proof.listing.otherDestinations===0&&proof.destinations?.oldAccount===0
   &&proof.destinations.clueraLegacy===0&&proof.destinations.clueraV2===1
   &&proof.canonical?.state==='MATCHED_TEST_MERCHANT'&&proof.canonical.listingConsistent===true;
  if(!accepted)return finish(proof.stopped==='CONFIGURATION'?'CONFIGURATION':'MERCHANT_REVIEW_REQUIRED');
  report.merchant={configurationAccepted:true,testAuthentication:true,listingComplete:true,verified:true,newDestinationState:'MATCHED_TEST_MERCHANT'};
 }else{
  report.merchant={configurationAccepted:proof.configurationAccepted===true&&proof.actualPaymentGuardLoaded===true,
   testAuthentication:proof.testAuthentication===true,listingComplete:proof.listing?.complete===true,verified:proof.merchantVerified===true,
   newDestinationState:['MISSING','AMBIGUOUS','MATCHED_TEST_MERCHANT','IDENTITY_REVIEW','DIRECT_UNAVAILABLE','DIRECT_IDENTITY_REVIEW'].includes(proof.destinations?.clueraV2?.state)
    ?proof.destinations.clueraV2.state:'UNVERIFIED'};
  if(proof.stopped!=='READ_ONLY_REVIEW_COMPLETE'||!report.merchant.configurationAccepted||!report.merchant.testAuthentication
   ||!report.merchant.listingComplete||!report.merchant.verified)return finish(proof.stopped==='CONFIGURATION'?'CONFIGURATION':'MERCHANT_REVIEW_REQUIRED');
 }
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
   const facts=target.validationFacts;
   const field=(name,prefix,positive)=>{
    if(!Object.hasOwn(row,name)){facts[prefix+'Missing']++;return false;}
    if(typeof row[name]!=='number'){facts[prefix+'NonNumeric']++;return false;}
    if(!integer(row[name])||(positive&&row[name]===0)){facts[prefix+'OutOfRange']++;return false;}
    return true;
   };
   const amountKnown=field('amount','amount',true),paidKnown=field('amount_paid','paid',false),dueKnown=field('amount_due','due',false);
   if(amountKnown&&paidKnown&&row.amount_paid>row.amount)facts.paidExceedsAmount++;
   if(amountKnown&&paidKnown&&dueKnown&&row.amount_due!==row.amount-row.amount_paid)facts.dueEquationMismatch++;
   if(amountKnown&&paidKnown&&dueKnown&&status==='paid'&&(row.amount_paid!==row.amount||row.amount_due!==0))facts.paidStateMismatch++;
   if(paidKnown&&status==='created'&&row.amount_paid!==0)facts.createdStateMismatch++;
   // Existing strict warning/acceptance rules remain unchanged. Facts improve
   // diagnosis only; even complete valid Test history grants no clearance.
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
// Original OFF phase cannot be selected with an extra public argument.
async function audit(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 return inspect(input,request,options,monotonic,false);
}
// Receiver-only inventory does not assert equality, signed delivery or clearance.
async function auditReceiverInventory(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 return inspect(input,request,options,monotonic,true);
}
// Connector-safe structural validation, not authentication of an external report.
async function auditCheckoutPreparedInventory(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 return inspect(input,request,options,monotonic,false,'prepared');
}
async function auditCheckoutInventory(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 return inspect(input,request,options,monotonic,false,'enabled');
}
function serializeReport(report){
 const refuse=()=>{throw Error('Safe obligations report logging refused.');};
 const record=(value,schema)=>{
  if(!object(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value)))return refuse();
  const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d),expected=Object.keys(schema);
  if(keys.some(key=>typeof key!=='string')||keys.length!==expected.length||expected.some(key=>!Object.hasOwn(d,key))
   ||Object.values(d).some(item=>!Object.hasOwn(item,'value')))return refuse();
  const output=Object.create(null);for(const key of expected)output[key]=schema[key](d[key].value);return output;
 };
 const fixed=expected=>value=>value===expected?expected:refuse(),boolean=value=>typeof value==='boolean'?value:refuse();
 const count=maximum=>value=>integer(value)&&value<=maximum?value:refuse(),total=value=>value===null||integer(value)?value:refuse();
 const choice=values=>value=>typeof value==='string'&&values.includes(value)?value:refuse();
 const warnings=allowed=>value=>{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return refuse();
  const d=Object.getOwnPropertyDescriptors(value),size=d.length?.value;
  if(!integer(size)||size>allowed.length||Reflect.ownKeys(d).length!==size+1)return refuse();
  const output=[];for(let index=0;index<size;index++){const item=d[String(index)];
   if(!item||!Object.hasOwn(item,'value')||typeof item.value!=='string'||!allowed.includes(item.value)||output.includes(item.value))return refuse();
   output.push(item.value);}
  return Object.setPrototypeOf(output,null);
 };
 const timestamp=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)return refuse();return value;};
 const template=base(),schema=Object.create(null);
 for(const key of ['component','scope','mutations','atomicSnapshot','limitation','financialClearance','obligationsUnresolved',
  'liveReviewed','paddleReviewed','databaseCompared','signedDeliveryVerified','activationAuthorized','fullTreeAttested','externalDeploymentVerificationRequired'])schema[key]=fixed(template[key]);
 schema.requests=count(53);schema.financialRequests=count(40);schema.completeInventory=boolean;schema.needsReview=boolean;
 schema.warnings=warnings(['DEADLINE']);
 schema.limits=value=>record(value,Object.fromEntries(Object.entries(template.limits).map(([key,value])=>[key,fixed(value)])));
 schema.merchant=value=>record(value,{configurationAccepted:boolean,testAuthentication:boolean,listingComplete:boolean,verified:boolean,
  newDestinationState:choice(['UNVERIFIED','MISSING','AMBIGUOUS','MATCHED_TEST_MERCHANT','IDENTITY_REVIEW','DIRECT_UNAVAILABLE','DIRECT_IDENTITY_REVIEW'])});
 schema.collections=value=>record(value,Object.fromEntries(Object.keys(COLLECTIONS).map(name=>[name,value=>{
  const amounts={unit:fixed('minor-units'),currency:fixed('INR'),knownAmount:total,
   ...(name==='orders'?{knownPaid:total}:name==='payments'?{knownRefunded:total}:{}),complete:boolean};
  return record(value,{complete:boolean,pages:count(10),records:count(1000),invalidRecords:count(1000),duplicateIds:count(1000),
   statuses:value=>record(value,Object.fromEntries([...COLLECTIONS[name].statuses,'unknown'].map(status=>[status,count(1000)]))),
   currency:name==='subscriptions'?fixed(null):value=>record(value,{INR:count(1000),other:count(1000),unknown:count(1000)}),
   amounts:name==='subscriptions'?fixed(null):value=>record(value,amounts),
   ...(name==='orders'?{validationFacts:value=>record(value,Object.fromEntries(ORDER_FACTS.map(key=>[key,count(1000)])))}:{}),warnings:warnings(WARNINGS)});
 }])));
 schema.stopped=choice(['CONFIGURATION','MERCHANT_REVIEW_REQUIRED','READ_ONLY_INVENTORY_COMPLETE','INVENTORY_DEADLINE']);schema.completedAt=timestamp;
 const safe=record(report,schema),header=Object.create(null);for(const key of Object.keys(safe))if(key!=='collections')header[key]=safe[key];
 const lines=['CLUERA_TEST_OBLIGATIONS_HEADER '+JSON.stringify(header)];
 for(const name of Object.keys(COLLECTIONS)){const item=Object.create(null);item.collection=name;item.report=safe.collections[name];
  lines.push('CLUERA_TEST_OBLIGATIONS_COLLECTION '+JSON.stringify(item));}
 const complete=Object.create(null);complete.stopped=safe.stopped;complete.completedAt=safe.completedAt;
 lines.push('CLUERA_TEST_OBLIGATIONS_COMPLETE '+JSON.stringify(complete));
 if(lines.some(line=>line.length>1900||Buffer.byteLength(line)>1900||/[\r\n]/.test(line)))return refuse();return lines;
}
module.exports={audit,auditReceiverInventory,auditCheckoutPreparedInventory,auditCheckoutInventory,serializeReport};
if(require.main===module){const args=process.argv.slice(2),options=args.length===1?{expectedSourceSha:args[0]}:{};
 audit(process.env,fetch,options).then(report=>{for(const line of serializeReport(report))console.log(line);process.exitCode=2;})
 .catch(()=>{console.log('CLUERA_TEST_OBLIGATIONS_COMPLETE {"stopped":"UNAVAILABLE","completeInventory":false,"needsReview":true,"mutations":0}');process.exitCode=2;});}
