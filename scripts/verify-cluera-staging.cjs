'use strict';
const {detectSecrets,loadKnownSecrets}=require('./security/source-secret-scan.cjs'),path=require('node:path');
const ORIGIN='https://cluera-ai-staging.vercel.app';
// Negative bodies only. No identities, credentials, event payload, order, financial RPC or SDK.
const checks=[
 ['home','GET','/',200],['pricing','GET','/pricing',200],['checkout-page','GET','/account/checkout',200],
 ['paused-checkout','POST','/api/account/checkout',404,ORIGIN],
 ['paused-foreign-checkout','POST','/api/account/checkout',404,'https://untrusted.invalid'],
 ['credits','GET','/api/account/credits',401],['native-credits','GET','/api/account/native/credits',401],
 ['admin','GET','/api/account/admin',401],['unsigned-webhook','POST','/api/payments/razorpay/test/webhook',404],
 ['worker','POST','/api/internal/billing/tick',404]];
async function boundedText(response){if(!response.body)return '';const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2097152)throw Error('Body bound');chunks.push(r.value);}return Buffer.concat(chunks).toString('utf8');}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
function inspect(check,response,body,known=[]){
 const [name,,,expected]=check,page=['home','pricing','checkout-page'].includes(name);
 const noSecrets=detectSecrets(Buffer.from(body),known).length===0;
 const visible=body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
 const pricing=!['home','pricing'].includes(name)||["Cluera 3 Hours","Cluera Pro 40 Hours","Cluera Pro 100 Hours","Cluera Enterprise 200 Hours","₹549","₹5,499","₹9,599","₹19,549"].every(t=>visible.includes(t))&&['100 hours per month','not active payment offers','no expiry','do not roll over'].every(t=>visible.toLowerCase().includes(t));
 const paused=name!=='checkout-page'||body.includes('Test payments are paused')&&body.includes('Checkout unavailable');
 const noSdk=!page||!/<script[^>]+src=["'][^"']*(?:paddle[.]com|razorpay[.]com)/i.test(body);
 const pass=response.status===expected&&response.headers.get('cache-control')?.includes('no-store')&&response.headers.get('x-content-type-options')==='nosniff'&&!response.headers.get('location')&&noSecrets&&pricing&&paused&&noSdk;
 return {name,status:response.status,expected,pass:!!pass,noSecrets,noSdk};
}
async function run(fetcher=fetch,known=[]){
 const results=[];for(const check of checks){const [,method,route,,origin]=check,headers=method==='POST'?{'Content-Type':'application/json'}:{};
  if(origin)headers.Origin=origin;
  const response=await fetcher(ORIGIN+route,{method,headers,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000),...(method==='POST'?{body:'{}'}:{})});
  results.push(inspect(check,response,await boundedText(response),known));
 }
 return {origin:ORIGIN,checks:results,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length};
}
module.exports={ORIGIN,checks,inspect,run,boundedText};
if(require.main===module)run(fetch,loadKnownSecrets(path.resolve(__dirname,'..'))).then(r=>{console.log(JSON.stringify(r));if(r.failed)process.exitCode=1;}).catch(()=>{console.error('Cluera fixed-target verification failed; no response details displayed.');process.exitCode=1;});
