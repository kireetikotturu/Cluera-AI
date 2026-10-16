import {test} from 'vitest';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {audit}=require('../../scripts/payments/audit-razorpay-test.cjs');
const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
 NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',RAZORPAY_ENVIRONMENT:'test',
 SIGMAROUND_PAYMENT_PROVIDER:'razorpay',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',
 SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',RAZORPAY_TEST_KEY_ID:'rzp_test_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'sb_secret_synthetic-server-secret-not-real-0000',
 RAZORPAY_TEST_WEBHOOK_SECRET:'synthetic-webhook-secret-not-real-0000',RAZORPAY_TEST_ACCOUNT_ID:'acc_synthetic123456'};
const row={id:'webhook_synthetic',url:'https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook',
 active:true,disabled_at:0,service:'beta-api-test',owner_type:'merchant',owner_id:'synthetic123456',secret_exists:true,
 events:['payment.captured','order.paid','refund.processed']};
function fetcher(webhooks=[row],status=200){const calls:any[]=[];return {calls,request:async(url:any,init:any)=>{calls.push([url,init]);
 assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
 return String(url).includes('/orders?')?Response.json({entity:'collection',count:0,items:[]}):Response.json({entity:'collection',items:webhooks},{status});}};}
test('safe successful GET report does not claim an unreadable secret matches',async()=>{
 const f=fetcher(),r=await audit(env,f.request);assert.equal(r.testAuthentication,true);assert.equal(r.webhooks.complete,true);
 assert.equal(r.webhooks.exactMatches,1);assert.equal(r.webhooks.matches[0].accountIdMatchesWebhookOwner,true);
 assert.equal(r.webhooks.matches[0].requiredEvents,true);assert.equal(r.webhooks.matches[0].secretMatches,null);assert.equal(r.requests,2);
 const text=JSON.stringify(r);for(const secret of [env.RAZORPAY_TEST_KEY_ID,env.RAZORPAY_TEST_KEY_SECRET,env.RAZORPAY_TEST_WEBHOOK_SECRET,env.RAZORPAY_TEST_ACCOUNT_ID])assert.ok(!text.includes(secret));
});
for(const override of [{RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456'},{RAZORPAY_TEST_KEY_SECRET:''},{RAZORPAY_TEST_WEBHOOK_SECRET:'short'},
 {RAZORPAY_TEST_ACCOUNT_ID:'merchant-not-account'},{NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},
 {SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'},{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true'}])
 test('invalid config stops before credential-bearing request '+Object.keys(override)[0],async()=>{const f=fetcher();const r=await audit({...env,...override},f.request);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);});
test('authentication denial neither continues nor reflects raw errors',async()=>{
 const r=await audit(env,async()=>Response.json({error:{description:env.RAZORPAY_TEST_KEY_SECRET}},{status:401}));
 assert.equal(r.stopped,'API_AUTHENTICATION');assert.equal(r.requests,1);assert.ok(!JSON.stringify(r).includes(env.RAZORPAY_TEST_KEY_SECRET));
});
test('webhook403 is unreadable configuration, not zero destinations',async()=>{const r=await audit(env,fetcher([],403).request);assert.equal(r.stopped,'WEBHOOK_READ_UNAVAILABLE');assert.equal(r.webhooks.complete,false);});
test('lookalike or path-suffixed destinations cannot match',async()=>{const r=await audit(env,fetcher([{...row,url:row.url+'/'}]).request);assert.equal(r.webhooks.exactMatches,0);});
test('missing event, different owner and inactive destination remain explicit failed categories',async()=>{const r=await audit(env,fetcher([{...row,active:false,owner_id:'another-merchant',events:['order.paid']}]).request);assert.equal(r.webhooks.matches[0].active,false);assert.equal(r.webhooks.matches[0].accountIdMatchesWebhookOwner,false);assert.equal(r.webhooks.matches[0].requiredEvents,false);});
test('secret comparison stays private when API actually returns it',async()=>{const r=await audit(env,fetcher([{...row,secret:env.RAZORPAY_TEST_WEBHOOK_SECRET}]).request);assert.equal(r.webhooks.matches[0].secretMatches,true);assert.ok(!JSON.stringify(r).includes(env.RAZORPAY_TEST_WEBHOOK_SECRET));});
test('oversized and malformed responses fail safely without reflecting their contents',async()=>{for(const body of ['x'.repeat(262145),'{bad-json']){const r=await audit(env,async()=>new Response(body));assert.equal(r.unavailable,true);assert.equal(r.requests,1);}});


test('obsolete singular enablement cannot authorize a credential probe',async()=>{
 const f=fetcher(),r=await audit({...env,SIGMAROUND_ACCOUNTS_ENABLED:undefined,SIGMAROUND_ACCOUNT_ENABLED:'true'},f.request);
 assert.equal(r.stopped,'CONFIGURATION');assert.equal(r.requests,0);
});
test('incomplete pagination is not reported as verified',async()=>{
 const r=await audit(env,async(url:string)=>String(url).includes('/orders?')?Response.json({entity:'collection',count:0,items:[]}):
 Response.json({items:Array.from({length:100},(_,i)=>({...row,id:'webhook_'+new URL(url).searchParams.get('skip')+'_'+i,url:'https://unrelated.invalid'}))}));
 assert.equal(r.requests,11);assert.equal(r.webhooks.pages,10);assert.equal(r.webhooks.complete,false);
});
test('extra event and Live/unknown service cannot pass the exact Test destination policy',async()=>{
 for(const service of ['beta-api-live','api-live','unknown']){
  const r=await audit(env,fetcher([{...row,service,events:[...row.events,'payment.failed']}]).request);
  assert.equal(r.webhooks.matches[0].testService,false);assert.equal(r.webhooks.matches[0].exactEvents,false);
 }
});
test('the actual artifact scanner detects both Razorpay secrets without printing them',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sigma-razorpay-scan-'));
 try{
  fs.mkdirSync(path.join(root,'scripts/security'),{recursive:true});
  fs.copyFileSync(path.resolve(import.meta.dirname,'../../scripts/security/source-secret-scan.cjs'),path.join(root,'scripts/security/source-secret-scan.cjs'));fs.mkdirSync(path.join(root,'web/.next/static'),{recursive:true});
  fs.copyFileSync(path.resolve(import.meta.dirname,'../../scripts/verify-cluera-artifacts.cjs'),path.join(root,'scripts/verify-cluera-artifacts.cjs'));
  for(const name of ['RAZORPAY_TEST_KEY_SECRET','RAZORPAY_TEST_WEBHOOK_SECRET'] as const){
   fs.writeFileSync(path.join(root,'web/.next/static/leak.js'),JSON.stringify(env[name]));
   const result=spawnSync(process.execPath,[path.join(root,'scripts/verify-cluera-artifacts.cjs'),'--web'],
    {env:{...process.env,[name]:env[name]},encoding:'utf8',windowsHide:true});
   assert.equal(result.status,1);assert.ok(result.stderr.includes(name));assert.ok(!result.stderr.includes(env[name]));
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('primary v1 numeric activation and explicit event flag maps are parsed without truthiness',async()=>{
 const r=await audit(env,fetcher([{...row,active:1,events:{'payment.captured':1,'order.paid':true,'refund.processed':1,'payment.failed':0}}] as any).request);
 assert.equal(r.webhooks.matches[0].active,true);assert.equal(r.webhooks.matches[0].exactEvents,true);
 assert.equal(r.webhooks.matches[0].eventsKnown,true);assert.equal(r.webhooks.matches[0].eventsRepresentation,'flag-map');
});
test('false/unknown activation, disabled destinations and malformed event flags never pass',async()=>{
 for(const active of [0,false,'false',2,'enabled',undefined]){
  const r=await audit(env,fetcher([{...row,active}] as any).request);assert.equal(r.webhooks.matches[0].active,false);
 }
 for(const events of [{'payment.captured':'yes','order.paid':1,'refund.processed':1},null,['payment.captured','order.paid','refund.processed','order.paid']]){
  const r=await audit(env,fetcher([{...row,events}] as any).request);assert.equal(r.webhooks.matches[0].requiredEvents,false);
 }
 const r=await audit(env,fetcher([{...row,active:1,disabled_at:1}] as any).request);
 assert.equal(r.webhooks.matches[0].active,true);assert.equal(r.webhooks.matches[0].disabledMarkerZero,false);
 assert.equal('deliveryReady' in r.webhooks.matches[0],false);
});
test('raw provider activation is distinct from a numeric-string disabled marker',async()=>{
 const r=await audit(env,fetcher([{...row,active:true,disabled_at:'0'}] as any).request);
 assert.equal(r.webhooks.matches[0].active,true);assert.equal(r.webhooks.matches[0].disabledAtRepresentation,'string');
 assert.equal(r.webhooks.matches[0].disabledMarkerZero,true);assert.equal('deliveryReady' in r.webhooks.matches[0],false);
});
test('unknown disabled markers remain unverified without falsifying the raw active flag',async()=>{
 for(const disabled_at of [undefined,null,'',false,'unknown','0.0',1,'1']){
  const r=await audit(env,fetcher([{...row,active:true,disabled_at}] as any).request);
  assert.equal(r.webhooks.matches[0].active,true);assert.equal('deliveryReady' in r.webhooks.matches[0],false);
 }
});

const testerId='00000000-0000-4000-8000-000000000801';
const intakeOptions={phase:'intake-only',expectedTesterDigest:createHash('sha256').update(testerId).digest('hex')};
const intakeEnv={...env,SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true',SIGMAROUND_PAYMENT_TESTER_IDS:testerId};
test('explicit intake-only preflight reads real enabled intake without rewriting it or enabling checkout',async()=>{
 const f=fetcher(),before=JSON.stringify(intakeEnv),r=await audit(intakeEnv,f.request,intakeOptions);
 assert.equal(r.phase,'intake-only');assert.equal(r.disabled,false);assert.equal(r.switchesMatch,true);
 assert.deepEqual(r.tester,{validSingle:true,approvedMatch:true});assert.equal(r.testAuthentication,true);
 assert.equal(r.requests,2);assert.equal(r.mutations,0);assert.equal(JSON.stringify(intakeEnv),before);
 for(const privateValue of [testerId,intakeOptions.expectedTesterDigest,env.RAZORPAY_TEST_KEY_ID,env.RAZORPAY_TEST_KEY_SECRET,env.RAZORPAY_TEST_WEBHOOK_SECRET,env.RAZORPAY_TEST_ACCOUNT_ID])
  assert.ok(!JSON.stringify(r).includes(privateValue));
});
for(const override of [
 {SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true'}, {SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true'},
 {SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'}, {SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'TRUE'},
 {SIGMAROUND_PAYMENT_TESTER_IDS:''}, {SIGMAROUND_PAYMENT_TESTER_IDS:testerId+','+testerId},
 {SIGMAROUND_PAYMENT_TESTER_IDS:'00000000-0000-4000-8000-000000000802'},
 {RAZORPAY_ENVIRONMENT:'live'}, {SIGMAROUND_ACCOUNTS_ENABLED:'false'}
])test('intake-only phase rejects changed flags/owner/Test boundary before any GET '+JSON.stringify(override),async()=>{
 const f=fetcher(),r=await audit({...intakeEnv,...override},f.request,intakeOptions);
 assert.equal(r.stopped,'CONFIGURATION');assert.equal(r.requests,0);assert.equal(f.calls.length,0);
});
test('unknown phase and missing/malformed/wrong tester pins cannot authorize an intake-only probe',async()=>{
 for(const options of [{phase:'checkout-enabled'}, {phase:'intake-only'}, {...intakeOptions,expectedTesterDigest:'short'},
  {...intakeOptions,expectedTesterDigest:'a'.repeat(64)}, {...intakeOptions,override:true}]){
  const f=fetcher(),r=await audit(intakeEnv,f.request,options);
  assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
 }
});
