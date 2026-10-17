'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {audit}=require('../scripts/payments/audit-cluera-test-readiness.cjs');
const sha='a'.repeat(40),options={expectedSourceSha:sha};
const env={VERCEL_ENV:'production',VERCEL_PROJECT_ID:'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B',VERCEL_ORG_ID:'team_AksnPXhi2VBXI5UsY2xBIakc',
 VERCEL_GIT_COMMIT_SHA:sha,SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
 NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',
 RAZORPAY_ENVIRONMENT:'test',SIGMAROUND_PAYMENT_PROVIDER:'razorpay',CLUERA_BILLING_V2_ENABLED:'false',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false',
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',RAZORPAY_TEST_KEY_ID:'rzp_test_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'synthetic-test-api-secret-never-real',
 RAZORPAY_TEST_WEBHOOK_SECRET:'synthetic-test-webhook-secret-never-real-0000',RAZORPAY_TEST_ACCOUNT_ID:'acc_syntheticmerchant01'};
const urls={oldAccount:'https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook',
 clueraLegacy:'https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook',clueraV2:'https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook'};
const pack=['payment.captured','order.paid','refund.processed'];
const recurring=[...pack,'subscription.charged','subscription.authenticated','subscription.activated','subscription.pending','subscription.halted',
 'subscription.cancelled','subscription.paused','subscription.resumed','subscription.completed','subscription.updated'];
const row=(target='oldAccount',id='TestWebhook0001',events=pack)=>({id,url:urls[target],owner_id:env.RAZORPAY_TEST_ACCOUNT_ID,
 owner_type:'merchant',service:'api-test',active:true,disabled_at:1234567890,events,secret_exists:true,
 secret:'never-return-upstream-secret',private_body:'never-return-private-provider-body'});
function fixture(rows=[row()],change){const calls=[];return {calls,request:async(url,init)=>{
 calls.push([url,init]);const parsed=new URL(url);const altered=change?.(parsed,init);if(altered)return altered;
 if(parsed.pathname==='/v1/orders')return Response.json({entity:'collection',count:0,items:[]});
 if(parsed.pathname==='/v1/webhooks')return Response.json({entity:'collection',count:rows.length,items:rows});
 return Response.json(rows.find(value=>'/v1/webhooks/'+value.id===parsed.pathname));
 }};}
test('actual payment guard accepts only clean disabled target and old destination is not misreported as missing merchant',async()=>{
 const f=fixture(),r=await audit(env,f.request,options);assert.equal(r.stopped,'READ_ONLY_REVIEW_COMPLETE');assert.equal(r.actualPaymentGuardLoaded,true);
 assert.equal(r.testAuthentication,true);assert.equal(r.merchantVerified,true);assert.equal(r.listing.complete,true);assert.equal(r.requests,2);
 assert.equal(r.destinations.oldAccount.state,'MATCHED_TEST_MERCHANT');assert.equal(r.destinations.clueraV2.state,'MISSING');
 assert.equal(r.destinations.oldAccount.direct.active.value,true);assert.equal(r.destinations.oldAccount.direct.disabledAt.zero,false);
 assert.equal(r.destinations.oldAccount.direct.events.profile,'exact-pack');
 assert.equal(r.activationAuthorized,false);assert.equal(r.financialClearance,'NOT_GRANTED');assert.equal(r.signedDelivery,'UNVERIFIED');
 for(const [url,init] of f.calls){assert.equal(new URL(url).origin,'https://api.razorpay.com');assert(new URL(url).pathname.startsWith('/v1/webhooks'));assert.equal(init.method,'GET');
 assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.body,undefined);
 assert(new Headers(init.headers).get('authorization').startsWith('Basic '));assert.equal(new Headers(init.headers).has('cookie'),false);}
 const text=JSON.stringify(r);for(const value of [...Object.values(urls),...Object.values(env).filter(value=>value.includes('synthetic')),row().id,row().secret,row().private_body])assert(!text.includes(value));
});
for(const [name,value] of Object.entries({CLUERA_BILLING_V2_ENABLED:'true',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'true',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'true',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',RAZORPAY_ENVIRONMENT:'live',NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co',
 SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'dwqltsqumiwsxtkzdoaa',SIGMAROUND_ACCOUNT_ORIGIN:'https://sigmaround-account-staging.vercel.app',
 SIGMAROUND_ACCOUNTS_ENABLED:'false',VERCEL_ENV:'preview',VERCEL_PROJECT_ID:'prj_foreign',VERCEL_ORG_ID:'team_foreign',VERCEL_GIT_COMMIT_SHA:'b'.repeat(40),
 RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456',RAZORPAY_TEST_KEY_SECRET:'short',RAZORPAY_TEST_WEBHOOK_SECRET:'short',RAZORPAY_TEST_ACCOUNT_ID:'merchant-invalid'}))
 test('refuses '+name+' before provider request',async()=>{const f=fixture(),r=await audit({...env,[name]:value},f.request,options);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);});
test('platform source/project/team variables absent require external deployment pin, never fabricated full-tree attestation',async()=>{
 const f=fixture(),minimal={...env};for(const key of ['VERCEL_PROJECT_ID','VERCEL_ORG_ID','VERCEL_GIT_COMMIT_SHA'])delete minimal[key];
 const r=await audit(minimal,f.request,options);assert.equal(r.testAuthentication,true);assert.equal(r.deploymentContext,'external-deployment-pin-required');
 assert.equal(r.fullTreeAttested,false);assert.equal(r.externalDeploymentVerificationRequired,true);
});
test('strict source/options/environment string validation rejects coercion and accessors without executing them',async()=>{
 for(const bad of [{},{expectedSourceSha:new String(sha)},{expectedSourceSha:sha,secret:'never-output'},Object.assign(Object.create({toJSON(){throw Error('never');}}),options)]){
  const f=fixture(),r=await audit(env,f.request,bad);assert.equal(r.stopped,'CONFIGURATION');assert.equal(f.calls.length,0);
 }
 let called=0;const hostile={...env};Object.defineProperty(hostile,'RAZORPAY_TEST_KEY_ID',{get(){called++;return env.RAZORPAY_TEST_KEY_ID;}});
 const f=fixture(),r=await audit(hostile,f.request,options);assert.equal(r.stopped,'CONFIGURATION');assert.equal(called,0);assert.equal(f.calls.length,0);
});
test('distinguishes all three literal destinations and exact3 versus exact13 profiles without printing event/provider values',async()=>{
 const f=fixture([row('oldAccount','TestWebhook0001'),row('clueraLegacy','TestWebhook0002'),row('clueraV2','TestWebhook0003',recurring)]),r=await audit(env,f.request,options);
 assert.equal(r.requests,4);for(const target of Object.keys(urls))assert.equal(r.destinations[target].state,'MATCHED_TEST_MERCHANT');
 assert.equal(r.destinations.clueraV2.direct.events.profile,'exact-recurring');assert.equal(r.destinations.clueraV2.direct.events.enabledCount,13);
 assert.equal(r.destinations.oldAccount.direct.events.profile,'exact-pack');assert.equal(r.mutations,0);assert.equal(r.signerMatch,'UNVERIFIED');
});
test('array/flag-map event profiles fail closed on missing/extra/duplicate/unknown representations',async()=>{
 for(const [events,profile] of [[{'payment.captured':1,'order.paid':true,'refund.processed':'true','payment.failed':false},'exact-pack'],
 [['order.paid'],'missing-base'],[[...pack,'payment.failed'],'unexpected'],[[...pack,pack[0]],'unexpected'],[{'payment.captured':'yes'},'unexpected']]){
  const f=fixture([row('clueraV2','TestWebhook0003',events)]),r=await audit(env,f.request,options);assert.equal(r.destinations.clueraV2.direct.events.profile,profile);
 }
});
test('raw active boolean and historical disabled marker are independent, never truthiness or derived inactive',async()=>{
 for(const [active,type,value] of [[true,'boolean',true],[false,'boolean',false],['true','string',null],[1,'number',null]]){
  const f=fixture([{...row('clueraV2'),active}]),r=await audit(env,f.request,options);assert.deepEqual(r.destinations.clueraV2.direct.active,{type,value});
  assert.equal(r.destinations.clueraV2.direct.disabledAt.type,'number');assert.equal(r.destinations.clueraV2.direct.disabledAt.zero,false);
 }
});
test('foreign merchant, Live or unknown owner never receives a direct resource request or establishes merchant authority',async()=>{
 for(const patch of [{owner_id:'acc_foreignmerchant01'},{service:'api-live'},{service:'never-echo-provider-value'},{owner_type:'partner'},{owner_id:{private:'never-echo'}}]){
  const f=fixture([{...row('clueraV2'),...patch}]),r=await audit(env,f.request,options);assert.equal(r.merchantVerified,false);assert.equal(r.requests,1);
  assert.equal(r.destinations.clueraV2.state,'IDENTITY_REVIEW');assert(!JSON.stringify(r).includes('never-echo'));
 }
});
test('duplicate destination URLs remain ambiguous rather than selecting an arbitrary resource',async()=>{
 const f=fixture([row('clueraV2','TestWebhook0001'),row('clueraV2','TestWebhook0002')]),r=await audit(env,f.request,options);
 assert.equal(r.destinations.clueraV2.state,'AMBIGUOUS');assert.equal(r.requests,1);assert.equal(r.merchantVerified,false);
});
test('GET authentication failures and unsupported listing shapes stop without financial requests or raw errors',async()=>{
 for(const response of [Response.json({secret:env.RAZORPAY_TEST_KEY_SECRET},{status:401}),Response.json({entity:'collection',count:2,items:[]}),Response.json({entity:'wrong',items:[]})]){
  const f=fixture([],()=>response),r=await audit(env,f.request,options);assert.equal(r.testAuthentication,false);assert.equal(r.requests,1);
  assert(!JSON.stringify(r).includes(env.RAZORPAY_TEST_KEY_SECRET));
 }
});
test('bounded pagination accepts complete arrays/wrappers and rejects duplicate IDs, cursor URLs, count mismatch and cap',async()=>{
 const hundred=Array.from({length:100},(_,index)=>({...row(),id:'OtherWebhook'+String(index).padStart(5,'0'),url:'https://unrelated.invalid'}));
 const complete=fixture([],url=>url.pathname==='/v1/webhooks'?Response.json(url.searchParams.get('skip')==='0'?hundred:[row()]):undefined);
 const good=await audit(env,complete.request,options);assert.equal(good.listing.complete,true);assert.equal(good.listing.pages,2);assert.equal(good.listing.records,101);
 for(const payload of [{entity:'collection',count:1,items:[]},{items:[row(),row()]},{items:[row()],next:'https://attacker.invalid'},
 {items:[row()],has_more:true},{items:[{...row(),id:3}]},{items:[{...row(),url:{private:'never-output'}}]}]){
  const f=fixture([],url=>url.pathname==='/v1/webhooks'?Response.json(payload):undefined),r=await audit(env,f.request,options);assert.equal(r.listing.complete,false);assert.equal(r.merchantVerified,false);
  assert.equal(r.destinations.clueraV2.state,'UNVERIFIED');
 }
 const capped=fixture([],url=>url.pathname==='/v1/webhooks'?Response.json(hundred.map((value,index)=>({...value,id:'Page'+url.searchParams.get('skip')+'Webhook'+index}))):undefined);
 const cap=await audit(env,capped.request,options);assert.equal(cap.stopped,'WEBHOOK_PAGE_CAP');assert.equal(cap.listing.complete,false);assert.equal(cap.requests,10);
});
test('direct primary-v1 response must independently match exact selected identity; changes remain explicit',async()=>{
 const changed=fixture([row('clueraV2')],url=>url.pathname.startsWith('/v1/webhooks/')?Response.json({...row('clueraV2'),active:false}):undefined);
 const r=await audit(env,changed.request,options);assert.equal(r.destinations.clueraV2.direct.active.value,false);assert.equal(r.destinations.clueraV2.listingConsistent,false);
 const wrong=fixture([row('clueraV2')],url=>url.pathname.startsWith('/v1/webhooks/')?Response.json({...row('clueraV2'),id:'ForeignWebhook0001'}):undefined);
 const bad=await audit(env,wrong.request,options);assert.equal(bad.merchantVerified,false);assert.equal(bad.destinations.clueraV2.state,'DIRECT_IDENTITY_REVIEW');
});
test('strict HTTP/body validation rejects redirects, HTML, oversized, malformed and thrown private errors',async()=>{
 for(const make of [()=>Response.json({},{status:302}),()=>new Response('private-html',{headers:{'content-type':'text/html'}}),
 ()=>new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}}),()=>new Response('{bad-json',{headers:{'content-type':'application/json'}}),
 ()=>{throw Error(env.RAZORPAY_TEST_KEY_SECRET);}]){
  const r=await audit(env,async()=>make(),options);assert.equal(r.requests,1);assert.equal(r.testAuthentication,false);assert(!JSON.stringify(r).includes(env.RAZORPAY_TEST_KEY_SECRET));
 }
});
test('whole-chain deadline is monotonic and never triggers retries',async()=>{
 let clock=0;const f=fixture([],()=>{clock=90001;return Response.json({entity:'collection',count:0,items:[]});});
 const r=await audit(env,f.request,options,()=>clock);assert.equal(r.requests,1);assert.equal(r.listing.complete,false);assert.equal(r.activationAuthorized,false);
});
test('a request ignoring AbortSignal and a hanging stream/cancel remain bounded by the same fixed8s deadline',async()=>{
 const started=performance.now();
 const never=()=>new Promise(()=>{});
 const results=await Promise.all([
  audit(env,never,options),
  audit(env,async()=>new Response(new ReadableStream({pull:never,cancel:never}),{headers:{'content-type':'application/json'}}),options),
 ]);
 assert(performance.now()-started>=7900);assert(performance.now()-started<10000);
 for(const result of results){assert.equal(result.requests,1);assert.equal(result.merchantVerified,false);assert.equal(result.listing.complete,false);
  assert.equal(result.stopped,'WEBHOOK_LISTING_UNAVAILABLE');assert.equal(result.destinations.clueraV2.state,'UNVERIFIED');}
});
test('declared size, malformed UTF8, direct403 and lookalike destinations never produce accepted proof or leak provider values',async()=>{
 for(const response of [new Response('{}',{headers:{'content-type':'application/json','content-length':'262145'}}),
  new Response('{}',{headers:{'content-type':'application/json','content-length':'not-a-number'}}),
  new Response(new Uint8Array([0xc3,0x28]),{headers:{'content-type':'application/json'}})]){
  const result=await audit(env,async()=>response,options);assert.equal(result.testAuthentication,false);assert.equal(result.merchantVerified,false);assert.equal(result.requests,1);
 }
 const denied=fixture([row('clueraV2')],url=>url.pathname.startsWith('/v1/webhooks/')?Response.json({private:'never-return-direct-body'},{status:403}):undefined);
 const failed=await audit(env,denied.request,options);assert.equal(failed.destinations.clueraV2.state,'DIRECT_UNAVAILABLE');assert.equal(failed.merchantVerified,false);
 assert(!JSON.stringify(failed).includes('never-return-direct-body'));
 const lookalike=fixture([{...row('clueraV2'),url:urls.clueraV2+'/'}]),missing=await audit(env,lookalike.request,options);
 assert.equal(missing.destinations.clueraV2.state,'MISSING');assert.equal(missing.listing.otherDestinations,1);assert.equal(missing.requests,1);
});
