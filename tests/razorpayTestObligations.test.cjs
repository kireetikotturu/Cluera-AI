'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {audit}=require('../scripts/payments/audit-razorpay-test-obligations.cjs');
const env={VERCEL_PROJECT_ID:'prj_VuG3xCUQqKmPhT0LIAmLuyUwBXg6',VERCEL_ENV:'production',SIGMAROUND_ACCOUNT_ORIGIN:'https://sigmaround-account-staging.vercel.app',
 RAZORPAY_ENVIRONMENT:'test',RAZORPAY_TEST_KEY_ID:'rzp_test_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'synthetic-api-secret-never-real',RAZORPAY_TEST_ACCOUNT_ID:'acc_syntheticmerchant01'};
const webhook={id:'TmqOkUNGtvEPLz',url:env.SIGMAROUND_ACCOUNT_ORIGIN+'/api/payments/razorpay/test/webhook',service:'api-test',owner_type:'merchant',
 owner_id:env.RAZORPAY_TEST_ACCOUNT_ID,active:true,events:['payment.captured','order.paid','refund.processed'],secret_exists:true,secret:'never-echo-upstream-secret'};
const entities={orders:['order','created'],payments:['payment','authorized'],refunds:['refund','pending'],subscriptions:['subscription','paused']};
const record=(name,n=1)=>{const [entity,status]=entities[name],prefix={orders:'order',payments:'pay',refunds:'rfnd',subscriptions:'sub'}[name];return {id:prefix+'_synthetic'+String(n).padStart(8,'0'),entity,status,customer_email:'never-echo-customer',notes:{private:'never-echo-note'}};};
function fixture(change){const calls=[];return {calls,request:async(url,init)=>{calls.push([url,init]);const u=new URL(url);
 if(change){const response=change(u,init);if(response)return response;}
 return Response.json(u.pathname.startsWith('/v1/webhooks/')?webhook:{entity:'collection',count:0,items:[]});}};}
test('only exact protected old Account production/Test context can inspect; new project/Live/arbitrary origin stops before requests',async()=>{
 for(const patch of [{VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B'},{VERCEL_ENV:'preview'},{SIGMAROUND_ACCOUNT_ORIGIN:'https://attacker.invalid'},
  {RAZORPAY_ENVIRONMENT:'live'},{RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456'},{RAZORPAY_TEST_KEY_SECRET:'short'},{RAZORPAY_TEST_ACCOUNT_ID:'foreign'}]){
  const f=fixture(),r=await audit({...env,...patch},f.request);assert.equal(r.stopped,'CONFIGURATION');assert.equal(r.activationAuthorized,false);assert.equal(f.calls.length,0);
 }
});
test('complete empty bounded Test reads never authorize activation, obligations clearance, Paddle or Live',async()=>{
 const f=fixture(),r=await audit(env,f.request);assert.equal(r.stopped,'BOUNDED_TEST_REVIEW_COMPLETE');assert.equal(r.requests,5);assert.equal(r.mutations,0);
 assert.equal(r.merchantVerified,true);assert.equal(r.activationAuthorized,false);assert.equal(r.obligationsUnresolved,true);assert.equal(r.liveReconciled,false);assert.equal(r.paddleReconciled,false);assert.equal(r.signerMatch,'UNVERIFIED');
 for(const summary of Object.values(r.collections)){assert.equal(summary.complete,true);assert.equal(summary.records,0);}
 for(const [url,init] of f.calls){assert.equal(new URL(url).origin,'https://api.razorpay.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.body,undefined);assert.equal(new Headers(init.headers).has('cookie'),false);}
});
for(const [label,patch] of Object.entries({foreignMerchant:{owner_id:'acc_foreign0001'},wrongURL:{url:'https://attacker.invalid'},wrongID:{id:'otherWebhook01'},
 liveService:{service:'api-live'},inactive:{active:false},truthyActive:{active:'true'},extraEvent:{events:[...webhook.events,'payment.failed']},missingSigner:{secret_exists:false}})){
 test('webhook '+label+' stops before any financial listing',async()=>{const f=fixture(()=>Response.json({...webhook,...patch})),r=await audit(env,f.request);
  assert.equal(r.stopped,'WEBHOOK_REVIEW');assert.equal(r.merchantVerified,false);assert.equal(f.calls.length,1);});
}
test('supported raw event flag map and normalized merchant ID retain strict event selection',async()=>{
 const f=fixture(u=>u.pathname.startsWith('/v1/webhooks/')?Response.json({...webhook,owner_id:env.RAZORPAY_TEST_ACCOUNT_ID.slice(4),events:{'payment.captured':1,'order.paid':true,'refund.processed':'true','payment.failed':false}}):null);
 assert.equal((await audit(env,f.request)).stopped,'BOUNDED_TEST_REVIEW_COMPLETE');
});
test('all four collection status counts are fixed and contain no raw IDs, customer fields, notes, keys or upstream secrets',async()=>{
 const f=fixture(u=>{const name=u.pathname.slice(4);return entities[name]?Response.json({entity:'collection',count:1,items:[record(name)]}):null;}),r=await audit(env,f.request);
 assert.equal(r.stopped,'BOUNDED_TEST_REVIEW_COMPLETE');for(const [name,[,state]] of Object.entries(entities)){assert.equal(r.collections[name].records,1);assert.equal(r.collections[name].states[state],1);}
 const text=JSON.stringify(r);for(const value of [env.RAZORPAY_TEST_KEY_ID,env.RAZORPAY_TEST_KEY_SECRET,env.RAZORPAY_TEST_ACCOUNT_ID,'never-echo','synthetic00000001','TmqOkUNGtvEPLz'])assert(!text.includes(value));
});
for(const failure of ['unknownStatus','wrongId','wrongEntity','duplicateId','countMismatch'])test('invalid collection '+failure+' is review-only, never silently skipped',async()=>{
 const f=fixture(u=>{if(u.pathname!=='/v1/orders')return null;let rows=[record('orders')],count=1;
  if(failure==='unknownStatus')rows[0].status='private-provider-state';if(failure==='wrongId')rows[0].id='foreign';if(failure==='wrongEntity')rows[0].entity='payment';
  if(failure==='duplicateId'){rows.push({...rows[0]});count=2;}if(failure==='countMismatch')count=0;
  return Response.json({entity:'collection',count,items:rows});}),r=await audit(env,f.request);
 assert.equal(r.stopped,'ORDERS_REVIEW');assert.equal(r.collections.orders.complete,false);assert.equal(r.collections.payments.attempted,false);assert(!JSON.stringify(r).includes('private-provider-state'));
});
test('ten full pages hit a strict cap rather than claiming all-history completion or requesting page eleven',async()=>{
 const f=fixture(u=>u.pathname==='/v1/orders'?Response.json({entity:'collection',count:100,items:Array.from({length:100},(_,i)=>record('orders',Number(u.searchParams.get('skip'))+i))}):null),r=await audit(env,f.request);
 assert.equal(r.stopped,'ORDERS_PAGE_CAP');assert.equal(r.collections.orders.records,1000);assert.equal(r.collections.orders.pages,10);assert.equal(f.calls.length,11);assert.equal(r.collections.orders.complete,false);
});
test('a repeated row across pages cannot make a moving provider listing appear complete',async()=>{
 const f=fixture(u=>u.pathname==='/v1/orders'?Response.json({entity:'collection',count:100,items:Array.from({length:100},(_,i)=>record('orders',i))}):null),r=await audit(env,f.request);
 assert.equal(r.stopped,'ORDERS_REVIEW');assert.equal(f.calls.length,3);assert.equal(r.collections.orders.complete,false);
});
for(const mode of ['forbidden','redirect','oversized','malformed','html','throw'])test('upstream '+mode+' fails closed with no retry or raw body/error reflection',async()=>{
 const f=fixture(()=>{if(mode==='forbidden')return Response.json({private:'never-echo'},{status:403});if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://attacker.invalid'}});
  if(mode==='oversized')return Response.json({private:'x'.repeat(262145)});if(mode==='malformed')return new Response('never-echo',{headers:{'content-type':'application/json'}});if(mode==='html')return new Response('never-echo');throw Error('never-echo');});
 const r=await audit(env,f.request);assert.equal(r.stopped,'WEBHOOK_REVIEW');assert.equal(f.calls.length,1);assert(!JSON.stringify(r).includes('never-echo'));
});
test('one whole-chain monotonic deadline prevents further requests, even before individual timeouts',async()=>{
 let reads=0;const f=fixture(),r=await audit(env,f.request,()=>reads++===0?0:90001);assert.equal(r.stopped,'WEBHOOK_REVIEW');assert.equal(f.calls.length,0);assert.equal(r.requests,0);
});
test('a subscription permission failure remains unaccepted rather than an empty obligations list',async()=>{
 const f=fixture(u=>u.pathname==='/v1/subscriptions'?Response.json({private:'never-echo'},{status:403}):null),r=await audit(env,f.request);
 assert.equal(r.stopped,'SUBSCRIPTIONS_REVIEW');assert.equal(r.collections.orders.complete,true);assert.equal(r.collections.subscriptions.complete,false);
 assert.equal(r.activationAuthorized,false);assert.equal(r.obligationsUnresolved,true);assert.equal(f.calls.length,5);
});
test('fixed eight-second request timeout does not depend on the injected fetch honoring AbortSignal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const pending=audit(env,()=>new Promise(()=>{}));t.mock.timers.tick(8000);const r=await pending;
  assert.equal(r.stopped,'WEBHOOK_REVIEW');assert.equal(r.requests,1);assert.equal(r.activationAuthorized,false);
 }finally{t.mock.timers.reset();}
});
test('fixed body timeout stays bounded even when a hostile cancellation promise never settles',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
 try{
  const pending=audit(env,async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}));
  await Promise.resolve();await Promise.resolve();t.mock.timers.tick(8000);const r=await pending;
  assert.equal(r.stopped,'WEBHOOK_REVIEW');assert.equal(r.requests,1);assert.equal(cancelled,true);assert.equal(r.activationAuthorized,false);
 }finally{t.mock.timers.reset();}
});
