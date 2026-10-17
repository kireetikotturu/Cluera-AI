'use strict';
// Protected-build metadata diagnostic only: at most two fixed STATUS POSTs.
// No WAKE/DISPATCH, database, provider, worker, private file or activation.
const path=require('node:path'),{createRequire,Module}=require('node:module');
const PROJECT='prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',TEAM='team_AksnPXhi2VBXI5UsY2xBIakc';
const STATUS='https://cluera-ai-relay-staging.onrender.com/internal/billing/status';
const FLAGS=Object.freeze(['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED',
 'SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED']);
const ENV=Object.freeze([...FLAGS,'CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED','SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED',
 'CLUERA_PROVIDER_VAULT_ENABLED','CLUERA_PROVIDER_VAULT_KEYRING_BASE64','CLUERA_AI_BOOTSTRAP_MODE',
 'SIGMAROUND_ACCOUNTS_ENABLED','SIGMAROUND_ACCOUNT_ORIGIN','NEXT_PUBLIC_SUPABASE_URL','SIGMAROUND_BILLING_WORKER_SECRET',
 'VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA']);
let application;
function loadApplication(){
 if(application)return application;
 const web=path.resolve(__dirname,'../../web'),webRequire=createRequire(path.join(web,'package.json'));
 const output=webRequire('esbuild').buildSync({stdin:{contents:"export {schedulerHeaders,schedulerSecret,schedulerTargetMatches,RELAY_STATUS_URL} from '../shared/billingDispatch';",resolveDir:web,loader:'ts'},
  bundle:true,write:false,platform:'node',format:'cjs',target:'node24',logLevel:'silent'}).outputFiles[0].text;
 const filename=path.join(web,'cluera-scheduler-status-memory.cjs'),loaded=new Module(filename,module);
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(web);loaded._compile(output,filename);
 application=loaded.exports;return application;
}
function validOptions(value){
 if(!value||typeof value!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(value)))return false;
 const d=Object.getOwnPropertyDescriptors(value);
 return Reflect.ownKeys(d).length===1&&Object.hasOwn(d,'expectedSourceSha')&&Object.hasOwn(d.expectedSourceSha,'value')
  &&typeof d.expectedSourceSha.value==='string'&&/^[a-f0-9]{40}$/.test(d.expectedSourceSha.value);
}
function activeOptions(value){
 if(!value||typeof value!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(value)))return null;
 const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d);
 if(keys.length!==2||!Object.hasOwn(d,'expectedSourceSha')||!Object.hasOwn(d,'expectedRelayEnabled')
  ||!Object.hasOwn(d.expectedSourceSha,'value')||!Object.hasOwn(d.expectedRelayEnabled,'value')
  ||typeof d.expectedSourceSha.value!=='string'||!/^[a-f0-9]{40}$/.test(d.expectedSourceSha.value)
  ||typeof d.expectedRelayEnabled.value!=='boolean')return null;
 return {expectedSourceSha:d.expectedSourceSha.value,expectedRelayEnabled:d.expectedRelayEnabled.value};
}
function environment(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CONFIGURATION');
 const safe=Object.create(null);
 for(const key of ENV){const d=Object.getOwnPropertyDescriptor(value,key);
  if(d&&(!Object.hasOwn(d,'value')||typeof d.value!=='string'))throw Error('CONFIGURATION');safe[key]=d?.value;
 }return safe;
}
function base(){return {component:'cluera-scheduler-status-only',activationAuthorized:false,processingEnabled:false,
 configurationAccepted:false,actualProtocolLoaded:false,badProofRejected:false,sharedSecretMatched:false,relayDisabled:false,
 requests:0,dispatchRequests:0,wakeRequests:0,databaseRequests:0,providerRequests:0,mutations:0,
 fullTreeAttested:false,externalDeploymentVerificationRequired:true,deploymentContext:'external-deployment-pin-required'};}
// Expected SHA remains an external pin, never full-tree self-attestation.
async function inspect(input,request,options,monotonic,wall,expectedRelayEnabled=null){
 const active=expectedRelayEnabled!==null;
 // processingEnabled is the legacy diagnostic-action field: this tool never
 // turns on or invokes processing. observedRelayEnabled is the live flag.
 const report={...base(),...(active?{mode:'ACTIVE_METADATA_ONLY',expectedRelayEnabled,observedRelayEnabled:null,diagnosticProcessingInvoked:false}:{})};
 const finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});
 let env,actual,key;
 try{
  if(!validOptions(options)||typeof request!=='function'||typeof monotonic!=='function'||typeof wall!=='function')return finish('CONFIGURATION');
  env=environment(input);
  const context=[[env.VERCEL_PROJECT_ID,PROJECT],[env.VERCEL_ORG_ID,TEAM],[env.VERCEL_GIT_COMMIT_SHA,options.expectedSourceSha]];
  if(context.some(([value,expected])=>value!==undefined&&value!==expected))return finish('CONFIGURATION');
  report.deploymentContext=context.every(([value])=>value!==undefined)?'available-system-values-match':'external-deployment-pin-required';
  const flagsMatch=FLAGS.every(flag=>env[flag]===(active&&['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED'].includes(flag)?'true':'false'));
  if(env.VERCEL_ENV!=='production'||env.VERCEL_TARGET_ENV!==undefined&&env.VERCEL_TARGET_ENV!=='production'
   ||!flagsMatch||env.CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED!==(active?'true':'false')
   ||env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED!=='true'||env.CLUERA_PROVIDER_VAULT_ENABLED!=='false'
   ||env.CLUERA_PROVIDER_VAULT_KEYRING_BASE64||(active?env.CLUERA_AI_BOOTSTRAP_MODE!=='auth-only':env.CLUERA_AI_BOOTSTRAP_MODE!==undefined&&env.CLUERA_AI_BOOTSTRAP_MODE!=='auth-only'))return finish('CONFIGURATION');
  actual=loadApplication();report.actualProtocolLoaded=true;
  if(actual.RELAY_STATUS_URL!==STATUS||!actual.schedulerTargetMatches(env)||!(key=actual.schedulerSecret(env)))return finish('CONFIGURATION');
  report.configurationAccepted=true;
 }catch{return finish('CONFIGURATION');}
 let last=-Infinity,deadline;
 const now=()=>{const value=monotonic();if(!Number.isFinite(value)||value<last)throw Error('DEADLINE');last=value;return value;};
 try{deadline=now()+20000;}catch{return finish('DEADLINE');}
 async function status(corrupt){
  const remaining=Math.min(8000,deadline-now());if(remaining<=0)throw Error('DEADLINE');
  const headers=actual.schedulerHeaders('STATUS',key,wall());
  if(corrupt){const proof=headers['x-cluera-scheduler-proof'];headers['x-cluera-scheduler-proof']=proof.slice(0,-1)+(proof.endsWith('a')?'b':'a');}
  let timer,reader;const controller=new AbortController();
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DEADLINE'));void reader?.cancel().catch(()=>{});},remaining);});
  try{
   report.requests++;
   const response=await Promise.race([request(STATUS,{method:'POST',headers,body:'{}',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal}),expired]);
   if(now()>deadline||response.redirected||response.url&&response.url!==STATUS||response.status!==(corrupt?401:200)
    ||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'
    ||response.headers.get('cache-control')!=='no-store'||response.headers.get('x-content-type-options')!=='nosniff'||!response.body)throw Error('READ');
   const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>256))throw Error('BOUND');
   reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>256)throw Error('BOUND');chunks.push(part.value);}
   if(now()>deadline)throw Error('DEADLINE');
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('SHAPE');
   const keys=Object.keys(value).sort().join(',');
   if(corrupt){if(keys!=='error'||value.error!=='Unauthorized.')throw Error('SHAPE');}
   else{
    if(keys!=='configured,enabled'||value.configured!==true||typeof value.enabled!=='boolean')throw Error('SHAPE');
    if(active)report.observedRelayEnabled=value.enabled;
    if(value.enabled!==(active?expectedRelayEnabled:false))throw Error('SHAPE');
   }
  }finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* Never await cancellation. */}}
 }
 let stage='BAD_PROOF';
 try{
  await status(true);report.badProofRejected=true;stage='SIGNED_STATUS';
  await status(false);report.sharedSecretMatched=true;report.relayDisabled=active?!expectedRelayEnabled:true;
  return finish(active?(expectedRelayEnabled?'ACTIVE_STATUS_VERIFIED_RELAY_ENABLED':'ACTIVE_STATUS_VERIFIED_RELAY_DISABLED'):'STATUS_VERIFIED_PROCESSING_DISABLED');
 }catch{return finish(stage+'_UNAVAILABLE');}
}
async function audit(input=process.env,request=fetch,options={},monotonic=()=>performance.now(),wall=()=>Date.now()){
 // Extra arguments cannot switch the original OFF-only authorization policy.
 return inspect(input,request,options,monotonic,wall,null);
}
async function auditActiveStatus(input=process.env,request=fetch,options={},monotonic=()=>performance.now(),wall=()=>Date.now()){
 try{
  const selected=activeOptions(options);
  if(selected)return inspect(input,request,{expectedSourceSha:selected.expectedSourceSha},monotonic,wall,selected.expectedRelayEnabled);
 }catch{/* Never evaluate or reflect malformed option properties. */}
 return {...base(),mode:'ACTIVE_METADATA_ONLY',expectedRelayEnabled:null,observedRelayEnabled:null,diagnosticProcessingInvoked:false,stopped:'CONFIGURATION',completedAt:new Date().toISOString()};
}
module.exports={audit,auditActiveStatus};
if(require.main===module){const args=process.argv.slice(2),options=args.length===1?{expectedSourceSha:args[0]}:{};
 audit(process.env,fetch,options).then(value=>{console.log('CLUERA_SCHEDULER_STATUS '+JSON.stringify(value));process.exitCode=1;})
 .catch(()=>{console.log('CLUERA_SCHEDULER_STATUS '+JSON.stringify({stopped:'UNAVAILABLE',activationAuthorized:false,requests:0,mutations:0}));process.exitCode=1;});}
