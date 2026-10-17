'use strict';
// Protected-build GET diagnostic only: no DB/SDK/schema/settings/event/payment
// write, local secret file, retry, URL override or website artifact/promotion.
const path=require('node:path'),{createRequire,Module}=require('node:module');
const {createHash}=require('node:crypto');
const PROJECT='prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',TEAM='team_AksnPXhi2VBXI5UsY2xBIakc';
const TARGETS=Object.freeze({oldAccount:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook',
 clueraLegacy:'https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook',
 clueraV2:'https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook'});
const BASE_EVENTS=Object.freeze(['payment.captured','order.paid','refund.processed']);
const FLAGS=Object.freeze(['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED',
 'SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED']);
const ENV=Object.freeze([...FLAGS,'VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA',
 'SIGMAROUND_ACCOUNTS_ENABLED','SIGMAROUND_ACCOUNT_ORIGIN','NEXT_PUBLIC_SUPABASE_URL','SIGMAROUND_RAZORPAY_TEST_PROJECT_REF',
 'RAZORPAY_ENVIRONMENT','SIGMAROUND_PAYMENT_PROVIDER','SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED',
 'RAZORPAY_TEST_KEY_ID','RAZORPAY_TEST_KEY_SECRET','RAZORPAY_TEST_WEBHOOK_SECRET','RAZORPAY_TEST_ACCOUNT_ID']);
let application;
function loadApplication(){
 if(application)return application;
 const web=path.resolve(__dirname,'../../web'),webRequire=createRequire(path.join(web,'package.json'));
 const output=webRequire('esbuild').buildSync({stdin:{contents:"export {assertPaymentStaging,razorpayConfig} from './lib/payments/core/config';export {eventTypes} from './lib/payments/cluera/contracts';export {merchantDigest,clueraIntakeEnabled,clueraCheckoutEnabled} from './lib/payments/cluera/config';",
   resolveDir:web,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'}).outputFiles[0].text;
 const filename=path.join(web,'cluera-test-readiness-memory.cjs'),loaded=new Module(filename,module);
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(web);loaded._compile(output,filename);
 application=loaded.exports;return application;
}
function optionsValid(value){
 if(!value||typeof value!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(value)))return false;
 const d=Object.getOwnPropertyDescriptors(value);return Reflect.ownKeys(d).length===1&&Object.hasOwn(d,'expectedSourceSha')
   &&Object.hasOwn(d.expectedSourceSha,'value')&&typeof d.expectedSourceSha.value==='string'&&/^[a-f0-9]{40}$/.test(d.expectedSourceSha.value);
}
function environment(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CONFIGURATION');
 const safe=Object.create(null);for(const key of ENV){const d=Object.getOwnPropertyDescriptor(value,key);
  if(d&&!Object.hasOwn(d,'value'))throw Error('CONFIGURATION');
  if(d&&typeof d.value!=='string')throw Error('CONFIGURATION');safe[key]=d?.value;
 }return safe;
}
function base(){return {component:'cluera-test-readiness-get-only',scope:'TEST_CONFIGURATION_ONLY',activationAuthorized:false,
 financialClearance:'NOT_GRANTED',signedDelivery:'UNVERIFIED',signerMatch:'UNVERIFIED',liveReconciled:false,paddleReconciled:false,
 obligationsUnresolved:true,mutations:0,requests:0,actualPaymentGuardLoaded:false,configurationAccepted:false,
 fullTreeAttested:false,externalDeploymentVerificationRequired:true,deploymentContext:'external-deployment-pin-required',
 formats:{testKeyId:false,apiSecret:false,webhookSecret:false,merchantId:false},testAuthentication:false,merchantVerified:false,
 listing:{complete:false,pages:0,records:0,otherDestinations:0},
 destinations:Object.fromEntries(Object.keys(TARGETS).map(key=>[key,{count:0,state:'UNVERIFIED',listing:null,direct:null,listingConsistent:false}]))};}
function events(value,recurring){
 let names=null;
 if(Array.isArray(value)&&value.length<=128&&value.every(name=>typeof name==='string'&&/^[a-z][a-z0-9_.]{1,99}$/.test(name))
   &&new Set(value).size===value.length)names=value;
 else if(value&&typeof value==='object'&&!Array.isArray(value)){
  const rows=Object.entries(value),flag=v=>v===true||v===1||v==='true'?true:v===false||v===0||v==='false'?false:null;
  if(rows.length<=128&&rows.every(([name,enabled])=>/^[a-z][a-z0-9_.]{1,99}$/.test(name)&&flag(enabled)!==null))
    names=rows.filter(([,enabled])=>flag(enabled)).map(([name])=>name);
 }
 const exact=expected=>names&&names.length===expected.length&&expected.every(name=>names.includes(name));
 return {valid:names!==null,enabledCount:names?.length??null,profile:exact(BASE_EVENTS)?'exact-pack':exact(recurring)?'exact-recurring'
   :names&&BASE_EVENTS.some(name=>!names.includes(name))?'missing-base':'unexpected'};
}
const type=value=>value===undefined?'missing':value===null?'null':['boolean','number','string'].includes(typeof value)?typeof value:'other';
function summary(row,account,recurring){
 const marker=row.disabled_at,markerType=type(marker),activeType=type(row.active);
 const merchantOwner=row.owner_type==='merchant',ownerValid=typeof row.owner_id==='string'&&/^(?:acc_)?[A-Za-z0-9]{8,64}$/.test(row.owner_id);
 return {mode:['api-test','beta-api-test'].includes(row.service)?'test':['api-live','beta-api-live'].includes(row.service)?'live':'unknown',
 merchantOwner,merchantMatches:merchantOwner&&ownerValid&&(row.owner_id===account||row.owner_id===account.slice(4)),
 active:{type:activeType,value:activeType==='boolean'?row.active:null},
 disabledAt:{type:markerType,zero:markerType==='number'&&Number.isFinite(marker)?marker===0
   :markerType==='string'&&/^\d+$/.test(marker)?marker==='0':null},events:events(row.events,recurring),
 signerPresence:row.secret_exists===true?'present':row.secret_exists===false?'absent':'unknown'};
}
const identity=record=>record.mode==='test'&&record.merchantOwner&&record.merchantMatches;
/** Expected SHA is an operator pin, not self-attestation. Available mismatching
 * platform values fail closed; absent values require external metadata/clone/tree
 * verification. Even matching system values NEVER attest the complete Git tree.
 */
async function inspect(input=process.env,request=fetch,options={},monotonic=()=>performance.now(),receiverId=null){
 const report=base(),finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});
 const receiver=receiverId!==null;
 if(receiver)Object.assign(report,{component:'cluera-test-receiver-get-only',scope:'TEST_RECEIVER_CONFIGURATION_ONLY',
  operatorIdMatches:false,actualIntakeVerified:false,actualCheckoutDisabledVerified:false,receiverConfigurationAccepted:false});
 let env,recurring;try{
  if(!optionsValid(options)||typeof request!=='function'||typeof monotonic!=='function')return finish('CONFIGURATION');
  env=environment(input);
  if(receiver){const external=Object.getOwnPropertyDescriptor(input,'CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED');
   if(!external||!Object.hasOwn(external,'value')||external.value!=='false')return finish('CONFIGURATION');}
  const context=[[env.VERCEL_PROJECT_ID,PROJECT],[env.VERCEL_ORG_ID,TEAM],[env.VERCEL_GIT_COMMIT_SHA,options.expectedSourceSha]];
  if(context.some(([actual,expected])=>actual!==undefined&&actual!==expected))return finish('CONFIGURATION');
  report.deploymentContext=context.every(([actual])=>actual!==undefined)?'available-system-values-match':'external-deployment-pin-required';
  if(env.VERCEL_ENV!=='production'||env.VERCEL_TARGET_ENV!==undefined&&env.VERCEL_TARGET_ENV!=='production'
    ||!FLAGS.every(key=>env[key]===(receiver&&['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED'].includes(key)?'true':'false'))
    ||env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED!=='true'||env.SIGMAROUND_PAYMENT_PROVIDER!=='razorpay')return finish('CONFIGURATION');
  report.formats={testKeyId:typeof env.RAZORPAY_TEST_KEY_ID==='string'&&/^rzp_test_[A-Za-z0-9]{8,64}$/.test(env.RAZORPAY_TEST_KEY_ID),
   apiSecret:typeof env.RAZORPAY_TEST_KEY_SECRET==='string'&&env.RAZORPAY_TEST_KEY_SECRET.length>=16&&env.RAZORPAY_TEST_KEY_SECRET.length<=256,
   webhookSecret:typeof env.RAZORPAY_TEST_WEBHOOK_SECRET==='string'&&env.RAZORPAY_TEST_WEBHOOK_SECRET.length>=32&&env.RAZORPAY_TEST_WEBHOOK_SECRET.length<=256,
   merchantId:typeof env.RAZORPAY_TEST_ACCOUNT_ID==='string'&&/^acc_[A-Za-z0-9]{8,64}$/.test(env.RAZORPAY_TEST_ACCOUNT_ID)};
  if(!Object.values(report.formats).every(value=>value))return finish('CONFIGURATION');
  const actual=loadApplication();actual.assertPaymentStaging(env);actual.razorpayConfig(env);
  if(receiver){
   report.actualIntakeVerified=actual.clueraIntakeEnabled(env)===true;
   report.actualCheckoutDisabledVerified=actual.clueraCheckoutEnabled(env)===false;
   if(!report.actualIntakeVerified||!report.actualCheckoutDisabledVerified)return finish('CONFIGURATION');
  }
  recurring=actual.eventTypes;
  if(!Array.isArray(recurring)||recurring.length!==13||new Set(recurring).size!==13
    ||!recurring.every(name=>typeof name==='string'&&/^(?:payment\.captured|order\.paid|refund\.processed|subscription\.[a-z_]+)$/.test(name))
    ||!BASE_EVENTS.every(name=>recurring.includes(name)))return finish('CONFIGURATION');
  report.actualPaymentGuardLoaded=true;report.configurationAccepted=true;
 }catch{return finish('CONFIGURATION');}
 let stage='WEBHOOK_LISTING',lastClock=-Infinity;
 const now=()=>{const value=monotonic();if(!Number.isFinite(value)||value<lastClock)throw Error('DEADLINE');lastClock=value;return value;};
 let deadline;try{deadline=now()+90000;}catch{return finish('DEADLINE');}
 const headers={Authorization:'Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'),Accept:'application/json'};
 const directPaths=new Set();
 async function get(resource){
  if(!/^\/v1\/webhooks\?count=100&skip=(?:0|100|200|300|400|500|600|700|800|900)$/.test(resource)&&!directPaths.has(resource))throw Error('BOUND');
  const remaining=Math.min(8000,deadline-now());if(remaining<=0)throw Error('DEADLINE');
  let timer,reader;const controller=new AbortController();
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DEADLINE'));void reader?.cancel().catch(()=>{});},remaining);});
  try{
   report.requests++;
   const response=await Promise.race([request('https://api.razorpay.com'+resource,{method:'GET',headers,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal}),expired]);
   if(now()>deadline)throw Error('DEADLINE');
   if(response.status!==200||response.redirected||!response.body||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error('READ');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))throw Error('BOUND');
   reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>262144)throw Error('BOUND');chunks.push(part.value);}
   if(now()>deadline)throw Error('DEADLINE');
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* Never await unbounded cancellation. */}}
 }
 try{
  // The authenticated primary-v1 listing itself tests the key pair. No order,
  // payment, refund or subscription resource is read before OR after this proof.
  const seen=new Set(),selected=Object.fromEntries(Object.keys(TARGETS).map(key=>[key,[]]));
  for(let page=0;page<10;page++){
   const raw=await get('/v1/webhooks?count=100&skip='+page*100);
   let rows;
   if(Array.isArray(raw))rows=raw;
   else if(raw&&typeof raw==='object'&&Array.isArray(raw.items)
     &&(raw.entity===undefined||raw.entity==='collection')&&(raw.count===undefined||raw.count===raw.items.length)
     &&!['next','next_page','next_cursor','cursor','has_more','links','meta'].some(key=>Object.hasOwn(raw,key)))rows=raw.items;
   if(!rows||rows.length>100)throw Error('LIST_SHAPE');report.testAuthentication=true;report.listing.pages++;
   for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!/^[A-Za-z0-9_]{8,64}$/.test(row.id)||seen.has(row.id)
      ||typeof row.url!=='string'||row.url.length>2048)throw Error('LIST_RECORD');
    seen.add(row.id);report.listing.records++;
    const match=Object.entries(TARGETS).find(([,url])=>row.url===url);
    if(match){selected[match[0]].push(row);report.destinations[match[0]].count++;}else report.listing.otherDestinations++;
   }
   if(rows.length<100){report.listing.complete=true;break;}
  }
  if(!report.listing.complete)return finish('WEBHOOK_PAGE_CAP');
  stage='WEBHOOK_PRIMARY_V1';
  for(const [target,rows] of Object.entries(selected)){
   const destination=report.destinations[target];
   if(!rows.length){destination.state='MISSING';continue;}if(rows.length!==1){destination.state='AMBIGUOUS';continue;}
   if(receiver&&target!=='clueraV2'){destination.state='NONCANONICAL_TARGET_REVIEW';continue;}
   const listed=rows[0];destination.listing=summary(listed,env.RAZORPAY_TEST_ACCOUNT_ID,recurring);
   if(!identity(destination.listing)){destination.state='IDENTITY_REVIEW';continue;}
   if(receiver){if(listed.id!==receiverId){destination.state='OPERATOR_ID_MISMATCH';continue;}report.operatorIdMatches=true;}
   const resource='/v1/webhooks/'+listed.id;directPaths.add(resource);destination.state='DIRECT_UNAVAILABLE';
   const direct=await get(resource);
   if(!direct||typeof direct!=='object'||Array.isArray(direct))throw Error('DIRECT_SHAPE');
   destination.direct=summary(direct,env.RAZORPAY_TEST_ACCOUNT_ID,recurring);
   if(direct.id!==listed.id||direct.url!==TARGETS[target]||!identity(destination.direct)){
    destination.state='DIRECT_IDENTITY_REVIEW';continue;
   }
   // Equality covers inspected safe fields only, never the complete provider body.
   destination.listingConsistent=JSON.stringify(destination.listing)===JSON.stringify(destination.direct);
   destination.state='MATCHED_TEST_MERCHANT';report.merchantVerified=true;
  }
  if(receiver){const canonical=report.destinations.clueraV2;
   const ready=value=>value&&identity(value)&&value.active.type==='boolean'&&value.active.value===true
    &&value.events.valid===true&&value.events.enabledCount===3&&value.events.profile==='exact-pack'&&value.signerPresence==='present';
   report.receiverConfigurationAccepted=report.operatorIdMatches&&report.listing.complete&&report.listing.records===1
    &&report.listing.otherDestinations===0&&report.destinations.oldAccount.count===0&&report.destinations.clueraLegacy.count===0
    &&canonical.count===1&&canonical.state==='MATCHED_TEST_MERCHANT'&&canonical.listingConsistent
    &&ready(canonical.listing)&&ready(canonical.direct);
   return finish(report.receiverConfigurationAccepted?'RECEIVER_CONFIGURATION_VERIFIED':'RECEIVER_REVIEW_REQUIRED');
  }
  return finish('READ_ONLY_REVIEW_COMPLETE');
 }catch{return finish(stage+'_UNAVAILABLE');}
}
// The original OFF-phase entry point cannot be switched with an extra argument.
async function audit(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 return inspect(input,request,options,monotonic,null);
}
function receiverOptions(value){
 if(!value||typeof value!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(value)))return null;
 const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d);
 if(keys.some(k=>typeof k!=='string')||keys.sort().join(',')!=='expectedSourceSha,expectedWebhookId'
  ||Object.values(d).some(p=>!Object.hasOwn(p,'value'))
  ||typeof d.expectedSourceSha.value!=='string'||!/^[a-f0-9]{40}$/.test(d.expectedSourceSha.value)
  ||typeof d.expectedWebhookId.value!=='string'||!/^[A-Za-z0-9_]{8,64}$/.test(d.expectedWebhookId.value))return null;
 return {expectedSourceSha:d.expectedSourceSha.value,expectedWebhookId:d.expectedWebhookId.value};
}
function receiverProjection(report){
 const c=report.destinations.clueraV2,count=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
 return {component:'cluera-test-receiver-get-only',scope:'TEST_RECEIVER_CONFIGURATION_ONLY',
  configurationAccepted:report.configurationAccepted===true,actualIntakeVerified:report.actualIntakeVerified===true,
  actualCheckoutDisabledVerified:report.actualCheckoutDisabledVerified===true,merchantVerified:report.merchantVerified===true,
  operatorIdMatches:report.operatorIdMatches===true,receiverConfigurationAccepted:report.receiverConfigurationAccepted===true,
  listing:{complete:report.listing.complete===true,pages:count(report.listing.pages,10),records:count(report.listing.records,1000),otherDestinations:count(report.listing.otherDestinations,1000)},
  destinations:{oldAccount:count(report.destinations.oldAccount.count,1000),clueraLegacy:count(report.destinations.clueraLegacy.count,1000),clueraV2:count(c.count,1000)},
  canonical:{state:c.state,listing:c.listing,direct:c.direct,listingConsistent:c.listingConsistent===true},
  signerMatch:'UNVERIFIED',signedDelivery:'UNVERIFIED',activationAuthorized:false,financialClearance:'NOT_GRANTED',
  mutations:0,requests:count(report.requests,13),financialRequests:0,fullTreeAttested:false,externalDeploymentVerificationRequired:true,
  stopped:report.stopped,completedAt:report.completedAt};
}
/** Actual receiver-only phase: no env rewriting, financial resources or events.
 * URL/profile agreement never proves secret equality or signed delivery. */
async function auditReceiver(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 const selected=receiverOptions(options);
 if(!selected)return receiverProjection({...base(),stopped:'CONFIGURATION',completedAt:new Date().toISOString()});
 return receiverProjection(await inspect(input,request,{expectedSourceSha:selected.expectedSourceSha},monotonic,selected.expectedWebhookId));
}
const PIN_PROJECT='yhnqlfcgrmckhyjdxegg';
const PIN_FIELDS=Object.freeze(['projectRef','sourceCommit','observedAt','merchantDigest','reportDigest','testAuthentication',
 'merchantMatches','configuredDigestMatches','testModeVerified','requests','mutations','activationAuthorized','financialClearance']);
function pinFailure(sourceCommit=null,observedAt=new Date().toISOString()){
 return {projectRef:PIN_PROJECT,sourceCommit,observedAt,merchantDigest:null,reportDigest:null,testAuthentication:false,
  merchantMatches:false,configuredDigestMatches:false,testModeVerified:false,requests:0,mutations:0,
  activationAuthorized:false,financialClearance:'NOT_GRANTED'};
}
/** Private operator correlation metadata, not an authentication credential.
 * Snapshot configuration so proof for one merchant cannot bind another digest. */
async function auditMerchantPinEvidence(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 let report,sourceCommit=null;
 try{
  if(!optionsValid(options))return pinFailure();sourceCommit=options.expectedSourceSha;
  // Drop only originally absent descriptors. Explicit undefined/accessor input
  // is rejected by the first environment validation, never silently accepted.
  const env=Object.freeze(Object.fromEntries(Object.entries(environment(input)).filter(([,value])=>value!==undefined)));
  report=await audit(env,request,options,monotonic);
  const failed=pinFailure(sourceCommit,report.completedAt);
  failed.requests=Number.isSafeInteger(report.requests)&&report.requests>=0&&report.requests<=13?report.requests:0;
  failed.testAuthentication=report.testAuthentication===true;
  const destinations=Object.values(report.destinations);
  const matching=destinations.filter(destination=>destination.count===1&&destination.state==='MATCHED_TEST_MERCHANT'
   &&destination.listingConsistent===true&&identity(destination.listing)&&identity(destination.direct));
  if(report.stopped!=='READ_ONLY_REVIEW_COMPLETE'||report.actualPaymentGuardLoaded!==true||report.configurationAccepted!==true
   ||report.testAuthentication!==true||report.listing.complete!==true||report.merchantVerified!==true||report.mutations!==0
   ||!matching.length||!destinations.every(destination=>destination.count===0?destination.state==='MISSING':matching.includes(destination)))return failed;
  const digest=loadApplication().merchantDigest(env);
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return failed;
  return {...failed,merchantDigest:digest,reportDigest:createHash('sha256').update(JSON.stringify(report)).digest('hex'),
   merchantMatches:true,configuredDigestMatches:true,testModeVerified:true};
 }catch{
  const failed=pinFailure(sourceCommit);
  if(report){failed.testAuthentication=report.testAuthentication===true;
   failed.requests=Number.isSafeInteger(report.requests)&&report.requests>=0&&report.requests<=13?report.requests:0;}
  return failed;
 }
}
/** Dedicated bounded line: never raw provider bodies, credentials or arbitrary fields. */
function merchantPinEvidenceLine(value){
 let safe;
 try{
  if(!value||typeof value!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw Error();
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(keys.some(key=>typeof key!=='string')||keys.sort().join(',')!==[...PIN_FIELDS].sort().join(',')
   ||Object.values(descriptors).some(property=>!Object.hasOwn(property,'value')))throw Error();
  safe=Object.create(null);for(const key of PIN_FIELDS)safe[key]=descriptors[key].value;
  const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const instant=typeof safe.observedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(safe.observedAt)
   &&Number.isFinite(Date.parse(safe.observedAt))&&new Date(safe.observedAt).toISOString()===safe.observedAt;
  const proved=safe.merchantMatches===true&&safe.configuredDigestMatches===true&&safe.testModeVerified===true&&safe.testAuthentication===true;
  if(safe.projectRef!==PIN_PROJECT||!(safe.sourceCommit===null||typeof safe.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(safe.sourceCommit))
   ||!instant||!['testAuthentication','merchantMatches','configuredDigestMatches','testModeVerified'].every(key=>typeof safe[key]==='boolean')
   ||!Number.isSafeInteger(safe.requests)||safe.requests<0||safe.requests>13||safe.mutations!==0||safe.activationAuthorized!==false
   ||safe.financialClearance!=='NOT_GRANTED'||(proved?!(hex(safe.merchantDigest)&&hex(safe.reportDigest)&&safe.sourceCommit&&safe.requests>=2)
    :safe.merchantDigest!==null||safe.reportDigest!==null||safe.merchantMatches||safe.configuredDigestMatches||safe.testModeVerified))throw Error();
 }catch{safe=pinFailure();}
 const line='CLUERA_TEST_MERCHANT_PIN '+JSON.stringify(safe);
 return Buffer.byteLength(line,'utf8')<=1200?line:'CLUERA_TEST_MERCHANT_PIN '+JSON.stringify(pinFailure());
}
module.exports={audit,auditMerchantPinEvidence,merchantPinEvidenceLine,auditReceiver};
if(require.main===module){const args=process.argv.slice(2),options=args.length===1?{expectedSourceSha:args[0]}:{};
 audit(process.env,fetch,options).then(report=>{console.log('CLUERA_TEST_READINESS '+JSON.stringify(report));process.exitCode=2;})
 .catch(()=>{console.log('CLUERA_TEST_READINESS '+JSON.stringify({stopped:'UNAVAILABLE',mutations:0,activationAuthorized:false}));process.exitCode=2;});}
