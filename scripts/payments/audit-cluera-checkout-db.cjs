'use strict';
// Operator-only SDK proof: exactly two owner SELECT RPCs and one catalog SELECT.
// No Auth API, user/status/rate/financial RPC, environment mutation or artifact.
const path=require('node:path'),{createRequire,Module}=require('node:module');
const SITE='https://cluera-ai-staging.vercel.app',DB='https://yhnqlfcgrmckhyjdxegg.supabase.co';
const PROJECT='prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',TEAM='team_AksnPXhi2VBXI5UsY2xBIakc';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const ENV=['NODE_ENV','VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA',
 'SIGMAROUND_ACCOUNTS_ENABLED','SIGMAROUND_ACCOUNT_ORIGIN','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY',
 'SUPABASE_SERVICE_ROLE_KEY','SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64','SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',
 'CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED',
 'SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED',
 'CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED','CLUERA_PROVIDER_VAULT_ENABLED','CLUERA_PROVIDER_VAULT_KEYRING_BASE64','CLUERA_AI_BOOTSTRAP_MODE',
 'SIGMAROUND_PAYMENT_PROVIDER','SIGMAROUND_RAZORPAY_TEST_PROJECT_REF','RAZORPAY_ENVIRONMENT','RAZORPAY_TEST_KEY_ID',
 'RAZORPAY_TEST_KEY_SECRET','RAZORPAY_TEST_WEBHOOK_SECRET','RAZORPAY_TEST_ACCOUNT_ID','SIGMAROUND_PAYMENT_TESTER_IDS'];
function select(value,keys,exact=false){
 if(!value||typeof value!=='object'||Array.isArray(value)||(exact&&![null,Object.prototype].includes(Object.getPrototypeOf(value))))throw Error('CONFIGURATION');
 const d=exact?Object.getOwnPropertyDescriptors(value):Object.fromEntries(keys.flatMap(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor?[[key,descriptor]]:[];})),names=Reflect.ownKeys(d);
 if(exact&&(names.some(key=>typeof key!=='string')||names.sort().join(',')!==[...keys].sort().join(',')))throw Error('CONFIGURATION');
 const result=Object.create(null);for(const key of keys){if(!Object.hasOwn(d,key))continue;
  if(!Object.hasOwn(d[key],'value')||typeof d[key].value!=='string')throw Error('CONFIGURATION');result[key]=d[key].value;}
 return Object.freeze(result);
}
let applicationSource;
function loadApplication(guard){
 const web=path.resolve(__dirname,'../../web'),webRequire=createRequire(path.join(web,'package.json'));
 if(!applicationSource)applicationSource=webRequire('esbuild').buildSync({stdin:{contents:
  "export {accountConfig} from './lib/accounts/config';export {accountClients} from './lib/accounts/clients';export {billingOwner,merchantDigest,clueraCheckoutEnabled,clueraIntakeEnabled} from './lib/payments/cluera/config';export {clueraBillingCatalog} from './lib/payments/cluera/checkout';",resolveDir:web,loader:'ts'},
  bundle:true,write:false,platform:'node',format:'cjs',target:'node24',logLevel:'silent',
  define:{fetch:'__clueraReadOnlyFetch','globalThis.fetch':'__clueraReadOnlyFetch','global.fetch':'__clueraReadOnlyFetch'}}).outputFiles[0].text;
 const filename=path.join(web,'cluera-checkout-db-memory.cjs'),loaded=new Module(filename,module);
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(web);loaded.__clueraReadOnlyFetch=guard;
 loaded._compile('const __clueraReadOnlyFetch=module.__clueraReadOnlyFetch;\n'+applicationSource,filename);
 delete loaded.__clueraReadOnlyFetch;return loaded.exports;
}
function base(){return {component:'cluera-checkout-db-read-only',phase:null,configurationAccepted:false,actualClientFactoryLoaded:false,
 modernServiceKeyAuthenticated:false,merchantPinVerified:false,ownerEpochVerified:false,packPolicyVerified:false,monthlyDisabledVerified:false,
 soleTesterShapeVerified:false,requests:0,databaseReads:0,blockedRequests:0,authRequests:0,providerRequests:0,financialRequests:0,
 mutations:0,activationAuthorized:false,financialClearance:'NOT_GRANTED',fullTreeAttested:false,externalDeploymentVerificationRequired:true};}
async function audit(input=process.env,request=fetch,options={},monotonic=()=>performance.now()){
 const report=base(),finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});let env,pins,stage='CONFIGURATION',step=0,expected=[],config,last=-Infinity,deadline;
 const now=()=>{const value=monotonic();if(!Number.isFinite(value)||value<last)throw Error('DEADLINE');last=value;return value;};
 const deny=()=>{report.blockedRequests=Math.min(99,report.blockedRequests+1);throw Error('READ_ONLY_BOUNDARY');};
 async function guarded(input,init){
  const next=expected[step];
  if(!next||typeof input!=='string'||input!==next.url||!init||init.method!=='POST'||typeof init.body!=='string'||init.body!==JSON.stringify(next.body))return deny();
  const headers=new Headers(init.headers);
  if(headers.get('apikey')!==config.serviceKey||headers.get('authorization')!==`Bearer ${config.serviceKey}`
   ||headers.get('content-type')?.split(';')[0].trim()!=='application/json'||headers.has('cookie')||headers.has('origin'))return deny();
  const remaining=Math.min(10000,deadline-now());if(remaining<=0)throw Error('DEADLINE');step++;
  let timer,reader;const controller=new AbortController();
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Error('DEADLINE'));controller.abort();void reader?.cancel().catch(()=>{});},remaining);});
  try{
   report.requests++;report.databaseReads++;
   const response=await Promise.race([request(next.url,{method:'POST',body:init.body,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,
    headers:{apikey:config.serviceKey,Authorization:`Bearer ${config.serviceKey}`,'Content-Type':'application/json','Content-Profile':'public','Accept-Profile':'public'}}),expired]);
   if(now()>deadline||response.status!==200||response.redirected||response.url&&response.url!==next.url||!response.body
    ||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error('READ');
   const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>65536))throw Error('BOUND');
   reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)throw Error('BOUND');chunks.push(part.value);}
   if(now()>deadline)throw Error('DEADLINE');const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));JSON.parse(body);
   return new Response(body,{status:200,headers:{'Content-Type':'application/json'}});
  }finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* No unbounded cleanup. */}}
 }
 try{
  pins=select(options,['expectedSourceSha','phase','expectedRevisionId'],true);
  if(!/^[a-f0-9]{40}$/.test(pins.expectedSourceSha)||!['prepared','enabled'].includes(pins.phase)||!UUID.test(pins.expectedRevisionId)
   ||typeof request!=='function'||typeof monotonic!=='function')return finish('CONFIGURATION');report.phase=pins.phase;
  env=select(input,ENV);const enabled=pins.phase==='enabled';
  const context=[[env.VERCEL_PROJECT_ID,PROJECT],[env.VERCEL_ORG_ID,TEAM],[env.VERCEL_GIT_COMMIT_SHA,pins.expectedSourceSha]];
  if(context.some(([actual,wanted])=>actual!==undefined&&actual!==wanted)||env.VERCEL_ENV!=='production'||env.VERCEL_TARGET_ENV!==undefined&&env.VERCEL_TARGET_ENV!=='production'
   ||env.SIGMAROUND_ACCOUNT_ORIGIN!==SITE||env.NEXT_PUBLIC_SUPABASE_URL!==DB
   ||!['CLUERA_BILLING_V2_ENABLED','CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED'].every(key=>env[key]==='true')
   ||env.SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED!==(enabled?'true':'false')||env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED!==(enabled?'false':'true')
   ||env.SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED!=='false'||env.CLUERA_PROVIDER_VAULT_ENABLED!=='false'||env.CLUERA_PROVIDER_VAULT_KEYRING_BASE64
   ||env.CLUERA_AI_BOOTSTRAP_MODE!=='auth-only'||!/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(env.SUPABASE_SERVICE_ROLE_KEY??''))return finish('CONFIGURATION');
  if(!UUID.test(env.SIGMAROUND_PAYMENT_TESTER_IDS??''))return finish('CONFIGURATION');report.soleTesterShapeVerified=true;
  deadline=now()+20000;const app=loadApplication(guarded);report.actualClientFactoryLoaded=true;
  config=app.accountConfig(env);if(!app.clueraIntakeEnabled(env)||app.clueraCheckoutEnabled(env)!==enabled)return finish('CONFIGURATION');
  const digest=app.merchantDigest(env),foreign=`${(Number.parseInt(digest[0],16)^1).toString(16)}${digest.slice(1)}`;
  expected=[{url:DB+'/rest/v1/rpc/cluera_billing_owner',body:{p_account_digest:digest}},
   {url:DB+'/rest/v1/rpc/cluera_billing_owner',body:{p_account_digest:foreign}},{url:DB+'/rest/v1/rpc/cluera_billing_catalog',body:{}}];
  report.configurationAccepted=true;const clients=app.accountClients(config),rpc=(name,args)=>clients.service.rpc(name,args);
  stage='OWNER_READ';const owner=await app.billingOwner(rpc,env);
  if(step!==2||report.blockedRequests||owner.accountDigest!==digest||owner.epoch!==1)return finish('OWNER_READ');
  report.modernServiceKeyAuthenticated=true;report.merchantPinVerified=true;report.ownerEpochVerified=true;
  stage='CATALOG_READ';const catalog=await app.clueraBillingCatalog(rpc);
  const policies=[['cluera_pack_3h_v2',54900,10800],['cluera_monthly_40h_v2',549900,144000],['cluera_monthly_100h_v2',959900,360000],['cluera_monthly_200h_v2',1954900,720000]];
  if(step!==3||report.blockedRequests||catalog.length!==4)return finish('CATALOG_READ');
  for(const [code,amount,seconds]of policies){const row=catalog.find(value=>value.offerCode===code),pack=code==='cluera_pack_3h_v2';
   if(!row||row.version!==1||row.amountPaise!==amount||row.allowanceSeconds!==seconds||row.currency!=='INR'||row.enabled!==pack
    ||row.kind!==(pack?'PACK':'RECURRING')||row.interval!==(pack?null:'MONTH')||row.totalCount!==(pack?null:120)
    ||pack&&(row.revisionId!==pins.expectedRevisionId||row.testPlanValidated!==true))return finish('CATALOG_READ');}
  report.packPolicyVerified=true;report.monthlyDisabledVerified=true;return finish('READ_ONLY_DB_PROOF_COMPLETE');
 }catch{return finish(stage);}
}
module.exports={audit};
if(require.main===module){const args=process.argv.slice(2),options=args.length===3?{expectedSourceSha:args[0],phase:args[1],expectedRevisionId:args[2]}:{};
 audit(process.env,fetch,options).then(report=>{console.log('CLUERA_CHECKOUT_DB_READ_ONLY '+JSON.stringify(report));process.exitCode=1;})
 .catch(()=>{console.log('CLUERA_CHECKOUT_DB_READ_ONLY '+JSON.stringify({stopped:'UNAVAILABLE',mutations:0,activationAuthorized:false}));process.exitCode=1;});}
