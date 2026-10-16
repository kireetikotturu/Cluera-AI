import {test} from 'vitest';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {compare:implementation,invocation}=require('../../scripts/payments/compare-razorpay-webhook.cjs');
const compare=(audit:any,request:any,env:any)=>implementation(audit,request,env,'WebhookTest0001');
const env={RAZORPAY_TEST_ACCOUNT_ID:'acc_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'sb_secret_synthetic-server-secret-not-real-0000'};
const row={id:'WebhookTest0001',url:'https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook',
 owner_id:'synthetic123456',owner_type:'merchant',service:'beta-api-test',active:false,disabled_at:0,
 events:{'payment.captured':1,'order.paid':1,'refund.processed':1},secret_exists:true,secret:env.RAZORPAY_TEST_KEY_SECRET};
const audit=async(_env:any,get:any)=>{const r=await get('https://api.razorpay.com/v1/webhooks?count=100&skip=0',
 {method:'GET',headers:{authorization:'Basic synthetic'},redirect:'error',cache:'no-store'});await r.json();
 return{testAuthentication:true,webhooks:{complete:true},requests:1,mutations:0};};
function fetcher(value=row,status=200){const calls:any[]=[];return{calls,request:async(url:string,init:RequestInit)=>{
 calls.push(url);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
 return Response.json(url.includes('/v1/webhooks?')?{items:[value]}:value,{status:url.includes('?')?200:status});}};}
test('compares the supplied exact destination ID and both GET resources, no credentials in output',async()=>{
 const f=fetcher(),r=await compare(audit,f.request,env);
 assert.equal(r.dashboardIdComparison.list.idMatches,true);assert.equal(r.dashboardIdComparison.list.active,false);
 assert.equal(r.dashboardIdComparison.list.disabledAtZero,true);assert.equal(r.dashboardIdComparison.list.requiredEvents,true);
 assert.equal(r.dashboardIdComparison.direct.length,2);assert.equal(r.requests,3);assert.equal(r.mutations,0);
 assert.equal(f.calls.length,3);assert.ok(!JSON.stringify(r).includes(env.RAZORPAY_TEST_KEY_SECRET));assert.ok(!JSON.stringify(r).includes(env.RAZORPAY_TEST_ACCOUNT_ID));
});
for(const change of [{id:'another_id'},{url:row.url+'/'},{owner_id:'foreignmerchant'},{service:'beta-api-live'},{owner_type:'partner'}])
 test('mismatched list identity prevents direct resource reads '+Object.keys(change)[0],async()=>{
  const f=fetcher({...row,...change});const r=await compare(audit,f.request,env);assert.equal(f.calls.length,1);assert.equal(r.dashboardIdComparison.direct.length,0);
 });
test('direct403 does not become a false absence/activation claim or reflect its body',async()=>{
 const f=fetcher(row,403),r=await compare(audit,f.request,env);
 assert.ok(r.dashboardIdComparison.direct.every(x=>x.status===403&&!('active' in x)));
 assert.ok(!JSON.stringify(r).includes(env.RAZORPAY_TEST_KEY_SECRET));
});
test('failed provider authentication prevents additional reads',async()=>{
 const f=fetcher(),r=await compare(async()=>({testAuthentication:false,requests:0,mutations:0}),f.request,env);
 assert.equal(f.calls.length,0);assert.equal(r.dashboardIdComparison.listed,false);
});
test('the exact raw active flag and serialized disabled marker stay distinct',async()=>{
 const f=fetcher({...row,active:true,disabled_at:'0'} as any),r=await compare(audit,f.request,env);
 assert.equal(r.dashboardIdComparison.list.active,true);assert.equal(r.dashboardIdComparison.list.disabledAtZero,false);
 assert.equal(r.dashboardIdComparison.list.disabledAtStringZero,true);assert.equal(r.dashboardIdComparison.list.disabledAtType,'string');
});
test('oversized response is rejected before unbounded decoding',async()=>{
 await assert.rejects(compare(audit,async()=>new Response('x'.repeat(262145)),env));
});


test('invalid/operator-missing destination IDs fail before any credential request',async()=>{
 const f=fetcher();for(const id of [undefined,'','../orders','hook?test','x'.repeat(65)]){
 const r=await implementation(audit,f.request,env,id);assert.equal(r.stopped,'INVALID_DESTINATION_ID');assert.equal(r.requests,0);}
 assert.equal(f.calls.length,0);
});

test('intake-only CLI accepts only the exact explicit mode with a private tester digest pin',()=>{
 assert.deepEqual(invocation(['WebhookTest0001']),{expected:'WebhookTest0001',options:{}});
 assert.deepEqual(invocation(['WebhookTest0001','--intake-only','a'.repeat(64)]),
  {expected:'WebhookTest0001',options:{phase:'intake-only',expectedTesterDigest:'a'.repeat(64)}});
 for(const args of [[],['WebhookTest0001','--intake-only'],['WebhookTest0001','--checkout-enabled','a'.repeat(64)],
  ['WebhookTest0001','--intake-only','short'],['WebhookTest0001','--intake-only','a'.repeat(64),'extra']])
  assert.equal(invocation(args).expected,undefined);
});
test('comparison forwards the explicit audit phase without changing environment or leaking its private pin',async()=>{
 const f=fetcher(),options={phase:'intake-only',expectedTesterDigest:'a'.repeat(64)},before=JSON.stringify(env);let received:any;
 const r=await implementation(async(e:any,get:any,o:any)=>{received=o;return audit(e,get);},f.request,env,'WebhookTest0001',options);
 assert.deepEqual(received,options);assert.equal(JSON.stringify(env),before);assert.equal(r.mutations,0);
 assert.ok(!JSON.stringify(r).includes(options.expectedTesterDigest));
});
