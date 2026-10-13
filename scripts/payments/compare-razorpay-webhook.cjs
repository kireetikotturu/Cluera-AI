'use strict';
async function compare(audit,request=fetch,env=process.env,expected,options={}){
 if(typeof expected!=='string'||! /^[A-Za-z0-9]{8,64}$/.test(expected))return{stopped:'INVALID_DESTINATION_ID',requests:0,mutations:0};
 const endpoint='https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook';
 let target,headers;
 async function read(url,init){
  if(init.method!=='GET'||new URL(url).origin!=='https://api.razorpay.com')throw Error('BOUND');
  const r=await request(url,init),reader=r.body.getReader(),chunks=[];let size=0;
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>262144)throw Error('BOUND');chunks.push(x.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=Buffer.concat(chunks);
  if(r.status===200&&new URL(url).pathname==='/v1/webhooks'){
   const data=JSON.parse(bytes.toString());target=target??(Array.isArray(data)?data:data.items??[]).find(x=>x.id===expected);headers=init.headers;
  }
  return new Response(bytes,{status:r.status,headers:r.headers});
 }
 const result=await audit(env,read,options);
 const flag=x=>x===true||x===1||x==='true'?true:x===false||x===0||x==='false'?false:null;
 function summary(x){
  const events=Array.isArray(x.events)?x.events:Object.entries(x.events??{}).filter(([,v])=>flag(v)===true).map(([k])=>k);
  return{idMatches:x.id===expected,urlMatches:x.url===endpoint,ownerMatches:typeof x.owner_id==='string'&&(x.owner_id===env.RAZORPAY_TEST_ACCOUNT_ID||'acc_'+x.owner_id===env.RAZORPAY_TEST_ACCOUNT_ID),
   merchantOwner:x.owner_type==='merchant',testService:['beta-api-test','api-test'].includes(x.service),active:flag(x.active),activeType:typeof x.active,
   enabled:flag(x.enabled),enabledType:typeof x.enabled,disabledAtZero:x.disabled_at===0,disabledAtStringZero:x.disabled_at==='0',disabledAtType:typeof x.disabled_at,disabledAtPresent:x.disabled_at!==undefined,
   eventCount:events.length,requiredEvents:['payment.captured','order.paid','refund.processed'].every(e=>events.includes(e)),secretExists:x.secret_exists===true};
 }
 result.dashboardIdComparison={listed:!!target,list:target?summary(target):null,direct:[]};
 if(!result.testAuthentication||!result.webhooks?.complete||!target||!summary(target).urlMatches||!summary(target).ownerMatches||!summary(target).merchantOwner||!summary(target).testService)return result;
 for(const path of ['/v1/webhooks/'+expected,'/v2/accounts/'+env.RAZORPAY_TEST_ACCOUNT_ID+'/webhooks/'+expected]){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{result.requests++;const r=await read('https://api.razorpay.com'+path,{method:'GET',headers,redirect:'error',cache:'no-store',signal:controller.signal});
   result.dashboardIdComparison.direct.push({api:path.startsWith('/v1/')?'primary-v1':'account-v2',status:r.status,...(r.status===200?summary(await r.json()):{})});}
  catch{result.dashboardIdComparison.direct.push({api:path.startsWith('/v1/')?'primary-v1':'account-v2',unavailable:true});}
  finally{clearTimeout(timer);}
 }
 result.completedAt=new Date().toISOString();return result;
}
// Explicit protected-build diagnostic only. Never produce a website artifact or promote an alias.
function invocation(args){
 if(args.length===1)return{expected:args[0],options:{}};
 if(args.length===3&&args[1]==='--intake-only'&&/^[a-f0-9]{64}$/.test(args[2]))
  return{expected:args[0],options:{phase:'intake-only',expectedTesterDigest:args[2]}};
 return{expected:undefined,options:{}};
}
if(require.main===module){
 const {audit}=require('./audit-razorpay-test.cjs');
 const {expected,options}=invocation(process.argv.slice(2));
 compare(audit,fetch,process.env,expected,options)
 .then(report=>{console.log('SIGMAROUND_SAFE_RAZORPAY_AUDIT '+JSON.stringify(report));process.exitCode=1;})
 .catch(()=>{console.log('SIGMAROUND_SAFE_RAZORPAY_AUDIT '+JSON.stringify({stopped:'UNAVAILABLE',mutations:0}));process.exitCode=1;});
}
module.exports={compare,invocation};
