'use strict';
// Operator-only protected-build diagnostic. No database/app guard, SDK, write,
// URL override, local secret import, retry or automatic financial action.
const PROJECT='prj_VuG3xCUQqKmPhT0LIAmLuyUwBXg6',ORIGIN='https://sigmaround-account-staging.vercel.app';
const WEBHOOK_ID='TmqOkUNGtvEPLz',DESTINATION=ORIGIN+'/api/payments/razorpay/test/webhook';
const EVENTS=Object.freeze(['payment.captured','order.paid','refund.processed']);
const RESOURCES=Object.freeze({
 orders:{entity:'order',id:/^order_[A-Za-z0-9]{8,64}$/,states:['created','attempted','paid']},
 payments:{entity:'payment',id:/^pay_[A-Za-z0-9]{8,64}$/,states:['created','authorized','captured','refunded','failed']},
 refunds:{entity:'refund',id:/^rfnd_[A-Za-z0-9]{8,64}$/,states:['pending','processed','failed']},
 subscriptions:{entity:'subscription',id:/^sub_[A-Za-z0-9]{8,64}$/,states:['created','authenticated','active','pending','halted','paused','cancelled','completed','expired']},
});
const flag=value=>value===true||value===1||value==='true'?true:value===false||value===0||value==='false'?false:null;
function eventMatch(value){
 let names;
 if(Array.isArray(value)){if(value.some(name=>typeof name!=='string')||new Set(value).size!==value.length)return false;names=value;}
 else if(value&&typeof value==='object'){
  const entries=Object.entries(value);if(entries.some(([,enabled])=>flag(enabled)===null))return false;
  names=entries.filter(([,enabled])=>flag(enabled)===true).map(([name])=>name);
 }else return false;
 return names.length===EVENTS.length&&EVENTS.every(name=>names.includes(name));
}
function webhookMatches(row,account){return Boolean(row&&row.id===WEBHOOK_ID&&row.url===DESTINATION
 &&['api-test','beta-api-test'].includes(row.service)&&row.owner_type==='merchant'
 &&[account,account.slice(4)].includes(row.owner_id)&&row.active===true&&eventMatch(row.events)&&row.secret_exists===true);}
function configuration(env){return env?.VERCEL_PROJECT_ID===PROJECT&&env.VERCEL_ENV==='production'
 &&env.SIGMAROUND_ACCOUNT_ORIGIN===ORIGIN&&env.RAZORPAY_ENVIRONMENT==='test'
 &&/^rzp_test_[A-Za-z0-9]{8,64}$/.test(env.RAZORPAY_TEST_KEY_ID??'')
 &&typeof env.RAZORPAY_TEST_KEY_SECRET==='string'&&env.RAZORPAY_TEST_KEY_SECRET.length>=16&&env.RAZORPAY_TEST_KEY_SECRET.length<=256
 &&/^acc_[A-Za-z0-9]{8,64}$/.test(env.RAZORPAY_TEST_ACCOUNT_ID??'');}
function base(){return {component:'razorpay-test-obligations-get-only',scope:'TEST_ONLY_BOUNDED_NON_ATOMIC_SNAPSHOT',
 activationAuthorized:false,financialClearance:'NOT_GRANTED',liveReconciled:false,paddleReconciled:false,
 obligationsUnresolved:true,signerMatch:'UNVERIFIED',configurationAccepted:false,merchantVerified:false,
 requests:0,mutations:0,collections:Object.fromEntries(Object.entries(RESOURCES).map(([name,rule])=>[name,
  {attempted:false,complete:false,pages:0,records:0,states:Object.fromEntries(rule.states.map(state=>[state,0]))}]))};}
/** Bounded Test inventory only, not attribution or refund/subscription settlement.
 * Empty Test history NEVER clears Live/Paddle or authorizes new financial work. */
async function audit(env=process.env,request=fetch,monotonic=()=>performance.now()){
 const report=base();let stage='CONFIGURATION';
 const finish=stopped=>({...report,stopped,completedAt:new Date().toISOString()});
 if(!configuration(env))return finish(stage);
 report.configurationAccepted=true;const deadline=monotonic()+90000;
 const headers={Authorization:'Basic '+Buffer.from(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET).toString('base64'),Accept:'application/json'};
 async function get(path){
  if(path!=='/v1/webhooks/'+WEBHOOK_ID&&!/^\/v1\/(?:orders|payments|refunds|subscriptions)\?count=100&skip=(?:0|100|200|300|400|500|600|700|800|900)$/.test(path))throw Error('BOUND');
  const remaining=Math.min(8000,deadline-monotonic());if(!Number.isFinite(remaining)||remaining<=0)throw Error('DEADLINE');
  const controller=new AbortController();let timer,reader;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DEADLINE'));void reader?.cancel().catch(()=>{});},remaining);});
  try{
   report.requests++;
   const response=await Promise.race([request('https://api.razorpay.com'+path,{method:'GET',headers,
    redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal}),expired]);
   if(response.status!==200||response.redirected||!response.body
    ||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error('READ');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))throw Error('BOUND');
   reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;
    bytes+=part.value.byteLength;if(bytes>262144)throw Error('BOUND');chunks.push(part.value);}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }finally{
   clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});
   try{reader?.releaseLock();}catch{/* Cancellation requested, never awaited without a deadline. */}
  }
 }
 try{
  stage='WEBHOOK_REVIEW';const webhook=await get('/v1/webhooks/'+WEBHOOK_ID);
  if(!webhookMatches(webhook,env.RAZORPAY_TEST_ACCOUNT_ID))return finish(stage);
  report.merchantVerified=true;
  for(const [name,rule] of Object.entries(RESOURCES)){
   stage=name.toUpperCase()+'_REVIEW';const summary=report.collections[name],ids=new Set();summary.attempted=true;
   for(let page=0;page<10;page++){
    const raw=await get('/v1/'+name+'?count=100&skip='+page*100);
    if(!raw||raw.entity!=='collection'||!Array.isArray(raw.items)||raw.items.length>100||raw.count!==raw.items.length)throw Error('COLLECTION');
    summary.pages++;
    for(const row of raw.items){
     if(!row||row.entity!==rule.entity||!rule.id.test(row.id??'')||ids.has(row.id)||!rule.states.includes(row.status))throw Error('EVIDENCE');
     ids.add(row.id);summary.records++;summary.states[row.status]++;
    }
    if(raw.items.length<100){summary.complete=true;break;}
   }
   if(!summary.complete)return finish(name.toUpperCase()+'_PAGE_CAP');
  }
  return finish('BOUNDED_TEST_REVIEW_COMPLETE');
 }catch{return finish(stage);}
}
module.exports={audit};
if(require.main===module){audit().then(report=>{console.log('CLUERA_RAZORPAY_TEST_OBLIGATIONS '+JSON.stringify(report));process.exitCode=2;})
 .catch(()=>{console.error('Razorpay Test obligations inspection unavailable.');process.exitCode=2;});}
