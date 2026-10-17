'use strict';
// Complete-source GET-only operator diagnostic. Never a financial validator.
const {auditMerchantPinEvidence:readiness}=require('./audit-cluera-test-readiness.cjs');
const ENV=['VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA',
 'SIGMAROUND_ACCOUNTS_ENABLED','SIGMAROUND_ACCOUNT_ORIGIN','NEXT_PUBLIC_SUPABASE_URL','SIGMAROUND_RAZORPAY_TEST_PROJECT_REF',
 'RAZORPAY_ENVIRONMENT','SIGMAROUND_PAYMENT_PROVIDER','SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','CLUERA_BILLING_V2_ENABLED',
 'CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED',
 'SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','RAZORPAY_TEST_KEY_ID','RAZORPAY_TEST_KEY_SECRET','RAZORPAY_TEST_WEBHOOK_SECRET','RAZORPAY_TEST_ACCOUNT_ID'];
const STATES=['created','attempted','paid','unknown'],PAYMENTS=['created','authorized','captured','refunded','failed','unknown'];
const TYPES=['missing','null','integer','number-other','string-zero','string-decimal','string-other','boolean','array','object'];
const FAILURES=['NONE','DEADLINE','HTTP_AUTH','HTTP_RATE_LIMIT','HTTP_UNAVAILABLE','REDIRECT','CONTENT_TYPE','BODY_BOUND','MALFORMED_BODY','COLLECTION_SHAPE','IDENTITY','CROSS_ORDER','DUPLICATE_PAYMENT','NETWORK'];
const STOPS=['NOT_STARTED','CONFIGURATION','MERCHANT_REVIEW_REQUIRED','ORDER_COUNT_REVIEW','ORDER_LIST_UNAVAILABLE','ORDER_DIRECT_UNAVAILABLE','ORDER_PAYMENTS_UNAVAILABLE','READ_ONLY_DIRECT_REVIEW_COMPLETE','UNAVAILABLE'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),integer=v=>Number.isSafeInteger(v)&&v>=0;
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'[A-Za-z0-9]{8,64}$').test(v);
class Stop extends Error{constructor(code){super('Diagnostic stopped.');this.code=code;}}
function base(){return {component:'cluera-test-direct-order-get-only',scope:'CONFIGURED_TEST_MERCHANT_ONLY',mutations:0,requests:0,financialRequests:0,
 merchantVerified:false,atomicSnapshot:false,financialClearance:'NOT_GRANTED',obligationsUnresolved:true,liveReviewed:false,paddleReviewed:false,
 activationAuthorized:false,signedDeliveryVerified:false,databaseCompared:false,fullTreeAttested:false,externalDeploymentVerificationRequired:true,
 selection:'NOT_READ',listed:null,direct:null,comparison:{statusMatches:null,paidTypeMatches:null,safeProjectionMatches:null,monetaryOperandsMatch:null},
 payments:{complete:false,records:0,statuses:Object.fromEntries(PAYMENTS.map(s=>[s,0])),sameOrder:false,exactINR54900:0,
 invalidAmounts:0,invalidRefunds:0,invalidCaptureFlags:0,captureStateMismatches:0,capturedSumKnown:false,capturedPaidEquationMatches:null},
 failure:'NONE',stopped:'NOT_STARTED',completedAt:new Date().toISOString()};}
function environment(input){if(!object(input))throw new Stop('NETWORK');const env=Object.create(null);
 for(const key of ENV){const d=Object.getOwnPropertyDescriptor(input,key);if(d&&(!Object.hasOwn(d,'value')||typeof d.value!=='string'))throw new Stop('NETWORK');if(d)env[key]=d.value;}
 return Object.freeze(env);}
function category(row,key){if(!Object.hasOwn(row,key))return 'missing';const value=row[key];
 if(value===null)return 'null';if(typeof value==='number')return integer(value)?'integer':'number-other';
 if(typeof value==='string')return value==='0'?'string-zero':/^[1-9][0-9]*$/.test(value)?'string-decimal':'string-other';
 return typeof value==='boolean'?'boolean':Array.isArray(value)?'array':'object';}
function summary(row){const amount=integer(row.amount)&&row.amount>0,paid=integer(row.amount_paid),due=integer(row.amount_due),known=amount&&paid&&due;
 const state=STATES.includes(row.status)?row.status:'unknown',currency=row.currency==='INR'?'INR':!Object.hasOwn(row,'currency')?'MISSING':typeof row.currency==='string'?'OTHER':'INVALID';
 return {state,currency,amountType:category(row,'amount'),paidType:category(row,'amount_paid'),dueType:category(row,'amount_due'),
 amountIs54900:row.amount===54900,numericEquationKnown:known,paidZero:paid?row.amount_paid===0:null,
 paidAtMostAmount:amount&&paid?row.amount_paid<=row.amount:null,dueEquationMatches:known?row.amount_due===row.amount-row.amount_paid:null,
 paidStateTotalsMatch:state==='paid'&&known?row.amount_paid===row.amount&&row.amount_due===0:null,
 createdStatePaidZero:state==='created'&&paid?row.amount_paid===0:null};}
function collection(raw,max){if(!object(raw)||Object.keys(raw).sort().join(',')!=='count,entity,items'||raw.entity!=='collection'
 ||!Array.isArray(raw.items)||raw.items.length>max||!integer(raw.count)||raw.count!==raw.items.length)throw new Stop('COLLECTION_SHAPE');return raw.items;}
async function audit(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 const report=base(),finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});let env,last=-Infinity,deadline;
 const now=()=>{const value=monotonic();if(!Number.isFinite(value)||value<last)throw new Stop('DEADLINE');last=value;return value;};
 try{if(typeof request!=='function'||typeof monotonic!=='function')return finish('CONFIGURATION');env=environment(input);deadline=now()+120000;}catch{return finish('CONFIGURATION');}
 let proof;try{proof=await readiness(env,request,options,now);}catch{return finish('MERCHANT_REVIEW_REQUIRED');}
 if(!object(proof))return finish('MERCHANT_REVIEW_REQUIRED');
 report.requests=Number.isSafeInteger(proof.requests)&&proof.requests>=0&&proof.requests<=13?proof.requests:0;
 if(![proof.testAuthentication,proof.merchantMatches,proof.configuredDigestMatches,proof.testModeVerified].every(v=>v===true)
 ||proof.mutations!==0||report.requests<2)return finish('MERCHANT_REVIEW_REQUIRED');
 report.merchantVerified=true;
 const headers={Authorization:'Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'),Accept:'application/json'};
 const allowed=new Set(['/v1/orders?count=2&skip=0']);
 async function get(resource){if(!allowed.has(resource)||report.financialRequests>=3)throw new Stop('IDENTITY');
  const remaining=Math.min(10000,deadline-now());if(remaining<=0)throw new Stop('DEADLINE');const perDeadline=now()+remaining;
  let timer,reader;const controller=new AbortController(),url='https://api.razorpay.com'+resource;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Stop('DEADLINE'));controller.abort();void reader?.cancel().catch(()=>{});},remaining);});
  const inTime=()=>{if(now()>perDeadline||now()>deadline)throw new Stop('DEADLINE');};
  try{report.requests++;report.financialRequests++;
   const response=await Promise.race([request(url,{method:'GET',headers,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal}),expired]);inTime();
   if(response.redirected||response.status>=300&&response.status<400||response.url&&response.url!==url)throw new Stop('REDIRECT');
   if(response.status!==200)throw new Stop([401,403].includes(response.status)?'HTTP_AUTH':response.status===429?'HTTP_RATE_LIMIT':'HTTP_UNAVAILABLE');
   if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new Stop('CONTENT_TYPE');
   const length=response.headers.get('content-length');if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)>262144))throw new Stop('BODY_BOUND');
   if(!response.body)throw new Stop('MALFORMED_BODY');reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);inTime();if(part.done)break;
    if(!(part.value instanceof Uint8Array))throw new Stop('MALFORMED_BODY');bytes+=part.value.byteLength;if(bytes>262144)throw new Stop('BODY_BOUND');chunks.push(part.value);}
   let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new Stop('MALFORMED_BODY');}inTime();return raw;
  }finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* No unbounded cleanup wait. */}}
 }
 let stage='ORDER_LIST_UNAVAILABLE';
 try{const orders=collection(await get('/v1/orders?count=2&skip=0'),2);
  report.selection=orders.length===0?'NONE':orders.length===1?'SOLE':'MULTIPLE';if(orders.length!==1)return finish('ORDER_COUNT_REVIEW');
  const listed=orders[0];if(!object(listed)||listed.entity!=='order'||!id(listed.id,'order_'))throw new Stop('IDENTITY');report.listed=summary(listed);
  const directPath='/v1/orders/'+listed.id,paymentPath=directPath+'/payments';allowed.add(directPath);allowed.add(paymentPath);stage='ORDER_DIRECT_UNAVAILABLE';
  const direct=await get(directPath);if(!object(direct)||direct.entity!=='order'||direct.id!==listed.id)throw new Stop('IDENTITY');report.direct=summary(direct);
  report.comparison={statusMatches:typeof listed.status==='string'&&listed.status===direct.status,paidTypeMatches:report.listed.paidType===report.direct.paidType,
   safeProjectionMatches:JSON.stringify(report.listed)===JSON.stringify(report.direct),
   monetaryOperandsMatch:['amount','amount_paid','amount_due','currency'].every(k=>Object.is(listed[k],direct[k]))};
  stage='ORDER_PAYMENTS_UNAVAILABLE';const payments=collection(await get(paymentPath),100),seen=new Set();let captured=0,sumKnown=true;
  for(const row of payments){if(!object(row)||row.entity!=='payment'||!id(row.id,'pay_'))throw new Stop('IDENTITY');
   if(seen.has(row.id))throw new Stop('DUPLICATE_PAYMENT');seen.add(row.id);if(row.order_id!==listed.id)throw new Stop('CROSS_ORDER');
   report.payments.records++;const status=PAYMENTS.includes(row.status)?row.status:'unknown';report.payments.statuses[status]++;
   const amount=integer(row.amount)&&row.amount>0,refund=integer(row.amount_refunded)&&amount&&row.amount_refunded<=row.amount;
   if(row.currency==='INR'&&row.amount===54900)report.payments.exactINR54900++;
   if(!amount||row.currency!=='INR'){report.payments.invalidAmounts++;sumKnown=false;}
   const refundStatus=row.refund_status,validRefund=refund&&(refundStatus===null?row.amount_refunded===0
    :refundStatus==='partial'?row.amount_refunded>0&&row.amount_refunded<row.amount:refundStatus==='full'?row.amount_refunded===row.amount:false);
   if(!validRefund||status==='refunded'&&refundStatus!=='full')report.payments.invalidRefunds++;
   if(typeof row.captured!=='boolean')report.payments.invalidCaptureFlags++;
   if(['captured','refunded'].includes(status)?row.captured!==true:['created','authorized','failed'].includes(status)?row.captured!==false:false)report.payments.captureStateMismatches++;
   if(status==='unknown')sumKnown=false;
   if(['captured','refunded'].includes(status)){if(!amount||!Number.isSafeInteger(captured+row.amount))sumKnown=false;else captured+=row.amount;}
  }
  report.payments.complete=payments.length<100;report.payments.sameOrder=true;
  report.payments.capturedSumKnown=sumKnown&&report.payments.complete;
  report.payments.capturedPaidEquationMatches=report.payments.capturedSumKnown&&direct.currency==='INR'&&integer(direct.amount_paid)?captured===direct.amount_paid:null;
  return finish('READ_ONLY_DIRECT_REVIEW_COMPLETE');
 }catch(error){report.failure=error instanceof Stop&&FAILURES.includes(error.code)?error.code:'NETWORK';return finish(stage);}
}
function reportLines(value){
 const refuse=()=>{throw Error('Safe direct-order report refused.');};
 const fixed=x=>v=>v===x?x:refuse(),choice=xs=>v=>typeof v==='string'&&xs.includes(v)?v:refuse();
 const bool=v=>typeof v==='boolean'?v:refuse(),count=max=>v=>integer(v)&&v<=max?v:refuse(),nullable=f=>v=>v===null?null:f(v);
 const record=(v,s)=>{if(!object(v)||![null,Object.prototype].includes(Object.getPrototypeOf(v)))return refuse();
  const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);if(keys.some(k=>typeof k!=='string')||keys.sort().join(',')!==Object.keys(s).sort().join(',')
   ||Object.values(d).some(p=>!Object.hasOwn(p,'value')))return refuse();const safe=Object.create(null);for(const k of Object.keys(s))safe[k]=s[k](d[k].value);return safe;};
 const projection=v=>record(v,{state:choice(STATES),currency:choice(['INR','OTHER','MISSING','INVALID']),amountType:choice(TYPES),paidType:choice(TYPES),dueType:choice(TYPES),
  amountIs54900:bool,numericEquationKnown:bool,paidZero:nullable(bool),paidAtMostAmount:nullable(bool),dueEquationMatches:nullable(bool),paidStateTotalsMatch:nullable(bool),createdStatePaidZero:nullable(bool)});
 const template=base(),schema=Object.create(null);
 for(const k of ['component','scope','mutations','atomicSnapshot','financialClearance','obligationsUnresolved','liveReviewed','paddleReviewed','activationAuthorized',
  'signedDeliveryVerified','databaseCompared','fullTreeAttested','externalDeploymentVerificationRequired'])schema[k]=fixed(template[k]);
 schema.requests=count(16);schema.financialRequests=count(3);schema.merchantVerified=bool;schema.selection=choice(['NOT_READ','NONE','SOLE','MULTIPLE']);
 schema.listed=nullable(projection);schema.direct=nullable(projection);
 schema.comparison=v=>record(v,{statusMatches:nullable(bool),paidTypeMatches:nullable(bool),safeProjectionMatches:nullable(bool),monetaryOperandsMatch:nullable(bool)});
 schema.payments=v=>record(v,{complete:bool,records:count(100),statuses:v=>record(v,Object.fromEntries(PAYMENTS.map(s=>[s,count(100)]))),sameOrder:bool,
  exactINR54900:count(100),invalidAmounts:count(100),invalidRefunds:count(100),invalidCaptureFlags:count(100),captureStateMismatches:count(100),capturedSumKnown:bool,capturedPaidEquationMatches:nullable(bool)});
 schema.failure=choice(FAILURES);schema.stopped=choice(STOPS);
 schema.completedAt=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v?v:refuse();
 const safe=record(value,schema),header=Object.create(null);for(const k of Object.keys(safe))if(!['listed','direct','comparison','payments','stopped','completedAt'].includes(k))header[k]=safe[k];
 const lines=['CLUERA_TEST_ORDER_HEADER '+JSON.stringify(header),'CLUERA_TEST_ORDER_LISTED '+JSON.stringify(safe.listed),
  'CLUERA_TEST_ORDER_DIRECT '+JSON.stringify({report:safe.direct,comparison:safe.comparison}),'CLUERA_TEST_ORDER_PAYMENTS '+JSON.stringify(safe.payments),
  'CLUERA_TEST_ORDER_COMPLETE '+JSON.stringify({stopped:safe.stopped,completedAt:safe.completedAt})];
 if(lines.some(line=>Buffer.byteLength(line,'utf8')>1900||/[\r\n]/.test(line)))return refuse();return lines;
}
module.exports={audit,reportLines};
if(require.main===module){const args=process.argv.slice(2),options=args.length===1?{expectedSourceSha:args[0]}:{};
 audit(process.env,fetch,options).then(report=>{for(const line of reportLines(report))console.log(line);process.exitCode=2;})
 .catch(()=>{for(const line of reportLines({...base(),stopped:'UNAVAILABLE'}))console.log(line);process.exitCode=2;});}
