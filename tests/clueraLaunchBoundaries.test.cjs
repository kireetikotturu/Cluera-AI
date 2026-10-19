'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, inspect, checks } = require('../scripts/verify-cluera-launch-boundaries.cjs');
const revision = 'a'.repeat(40);
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-cluera-revision': revision };
const html = content => `<!DOCTYPE html><html><body><main>${content}</main></body></html>`;
const pages = { home: html('Your interview workspace. One Cluera account.'), pricing: html('Your time. One shared balance.'),
  account: html('Your Cluera account. Checking your account'), checkout: html('Buy Cluera credits'),
  download: html('Download Cluera AI. Cluera TEST installer awaiting approval'),
  'admin-page': html('<h1>Verify access to continue</h1><p>Checking your current session...</p><a href="/account#login">Go to your account</a>') };
const errors = { 'credits-denied': 'UNAUTHENTICATED', 'native-credits-denied': 'UNAUTHENTICATED',
  'admin-denied': 'ADMIN_SIGN_IN_REQUIRED', 'admin-access-denied': 'Sign in to continue.',
  'checkout-denied': 'Sign in with a verified email.', 'history-denied': 'Sign in with a verified Cluera account.',
  'release-unapproved': 'No approved Cluera AI test installer is available.' };
const catalog = { catalog: Object.entries({ cluera_pack_3h_v2: [54900,10800,'PACK'], cluera_monthly_40h_v2: [549900,144000,'RECURRING'],
  cluera_monthly_100h_v2: [959900,360000,'RECURRING'], cluera_monthly_200h_v2: [1954900,720000,'RECURRING'] })
  .map(([offerCode, [amountPaise,allowanceSeconds,kind]],index) => ({offerCode,amountPaise,allowanceSeconds,kind,currency:'INR',enabled:kind==='PACK',
    revisionId:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,name:`Synthetic offer ${index+1}`,version:2,
    interval:kind==='PACK'?null:'MONTH',totalCount:kind==='PACK'?null:120,testPlanValidated:false})) };
function body(name) { return pages[name] ?? (errors[name] ? JSON.stringify({error:errors[name]})
  : name === 'catalog' ? JSON.stringify(catalog) : name === 'auth-options' ? '{"google":"disabled"}' : '{"ok":true}'); }
function response(name,status=checks.find(row=>row[0]===name)[3][0],content=body(name),extra={}) {
  return new Response(content,{status,headers:{...headers,'content-type':pages[name]?'text/html; charset=utf-8':'application/json; charset=utf-8',...extra}});
}
function fixture(alter) { return async (url,options) => {
  const check=checks.find(row=>row[1]+row[2]===url);assert.ok(check);
  return alter?.(check[0],options) ?? response(check[0]);
}; }
test('current staged boundaries require genuine pages and JSON contracts using fixed credential-free GETs', async () => {
  const calls=[];
  const report=await run(fixture((name,options) => {
    calls.push(name);assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');
    assert.deepEqual(Object.keys(options.headers),['Accept']);assert.equal(options.body,undefined);
  }),[],revision);
  assert.equal(calls.length,16);assert.equal(report.failed,0);assert.equal(report.google,'disabled');
  assert.equal(report.productionReady,false);assert.equal(report.privateAcceptance,'NOT_TESTED');assert.equal(report.financialMutations,0);
  const history=checks.find(row=>row[0]==='history-denied');
  assert.equal(new URL(history[1]+history[2]).search,'?expectedAccountId=00000000-0000-4000-8000-000000000001');
});
test('fails missing/stale relay revision, enabled monthly, duplicate catalog rows and protected Admin content', () => {
  assert.equal(inspect('relay-health',response('relay-health'),'{"ok":true}',[],'b'.repeat(40)),false);
  assert.equal(inspect('relay-health',response('relay-health',200,'{}',{'x-cluera-revision':''}),'{"ok":true}',[]),false);
  const changed=structuredClone(catalog);changed.catalog[1].enabled=true;
  assert.equal(inspect('catalog',response('catalog'),JSON.stringify(changed),[]),false);
  changed.catalog[1]=changed.catalog[0];assert.equal(inspect('catalog',response('catalog'),JSON.stringify(changed),[]),false);
  assert.equal(inspect('admin-page',response('admin-page'),pages['admin-page']+'<h1>Account administration</h1>',[]),false);
});
test('empty pages, third-party login HTML, missing neutral Admin gate and unknown check names cannot pass', () => {
  for(const name of Object.keys(pages))for(const content of ['', '{}', html('<h1>Vercel Authentication</h1>')])
    assert.equal(inspect(name,response(name),content,[]),false);
  assert.equal(inspect('admin-page',response('admin-page'),html('Verify access to continue'),[]),false);
  assert.equal(inspect('unknown-denial',response('admin-denied'),JSON.stringify({error:'UNAUTHENTICATED'}),[]),false);
});
test('matching unauthorized status cannot substitute HTML, unrelated errors or additional customer fields for the real API denial', async () => {
  const names=Object.keys(errors);
  for(const name of names)for(const content of [html('Authentication required'), '{}', '{"error":"private upstream auth detail"}',
    JSON.stringify({error:errors[name],customerId:'private customer field'})])
    assert.equal(inspect(name,response(name),content,[]),false);
  const report=await run(fixture(name=>names.includes(name)?response(name,undefined,html('Authentication required'),{'content-type':'text/html'}):undefined));
  assert.equal(report.failed,names.length);for(const row of report.checks.filter(row=>names.includes(row.name)))assert.equal(row.pass,false);
  assert.ok(!JSON.stringify(report).includes('Authentication required'));
});
test('history accepts only the real enabled401 or disabled404 contract and never a public successful history',async()=>{
  const disabled=await run(fixture(name=>name==='history-denied'?response(name,404,'{"error":"Billing history is unavailable."}'):undefined));
  assert.equal(disabled.failed,0);
  for(const [status,content]of [[200,'{"history":{}}'],[400,'{"error":"The history request could not be accepted."}'],[404,'{"error":"Sign in with a verified Cluera account."}']]){
    const report=await run(fixture(name=>name==='history-denied'?response(name,status,content):undefined));
    assert.equal(report.checks.find(row=>row.name==='history-denied').pass,false);
  }
});
test('catalog validates the complete public allowlist and rejects private fields, wrong types, amounts and period policy',()=>{
  for(const patch of [{revisionId:'not-a-uuid'},{version:0},{enabled:'false'},{testPlanValidated:'false'},
    {name:''},{amountPaise:1},{currency:'USD'},{interval:'YEAR'},{totalCount:0},{razorpayPlanId:'plan_private0001'}]){
    const changed=structuredClone(catalog);Object.assign(changed.catalog[1],patch);
    assert.equal(inspect('catalog',response('catalog'),JSON.stringify(changed),[]),false);
  }
  for(const content of ['null','[]','{"catalog":null}',JSON.stringify({...catalog,privateConfig:'private field'})])
    assert.equal(inspect('catalog',response('catalog'),content,[]),false);
  assert.equal(inspect('auth-options',response('auth-options'),'{"google":"unavailable"}',[]),false);
  assert.equal(inspect('auth-options',response('auth-options'),'{"google":"disabled","private":true}',[]),false);
});
test('wrong content types, missing security headers and cache directive lookalikes fail independently of a valid body',async()=>{
  for(const override of [{'content-type':'text/plain'},{'cache-control':'no-storey'},{'cache-control':''},{'x-content-type-options':''}]){
    const report=await run(fixture(name=>name==='admin-denied'?response(name,undefined,body(name),override):undefined));
    assert.equal(report.checks.find(row=>row.name==='admin-denied').pass,false);
  }
  assert.equal(inspect('home',response('home',200,pages.home,{'content-type':'application/json'}),pages.home,[]),false);
});
test('request failures and redirects remain failed categories without reflecting bodies or exception text', async () => {
  const report=await run(async () => new Response('private diagnostic that must not print',{status:302,headers:{...headers,location:'https://outside.invalid'}}),[]);
  assert.equal(report.failed,16);assert.ok(!JSON.stringify(report).includes('private diagnostic'));
  const thrown=await run(()=>{throw Error('private exception text');});assert.equal(thrown.failed,16);
  assert.ok(!JSON.stringify(thrown).includes('private exception'));
  await assert.rejects(run(()=>{throw Error('must not request');},[],'invalid'));
  await assert.rejects(run(()=>{throw Error('must not request');},[],new String(revision)));
});
test('secret markers, declared size overflow, streamed overflow and malformed UTF8 never become accepted evidence',async()=>{
  const privateValue='synthetic-private-marker-never-output';
  const leaked=await run(fixture(name=>name==='home'?response(name,200,pages.home+privateValue):undefined),[{type:'synthetic probe',value:privateValue}]);
  assert.equal(leaked.checks[0].pass,false);assert.ok(!JSON.stringify(leaked).includes(privateValue));
  for(const make of [()=>response('auth-options',200,body('auth-options'),{'content-length':'4097'}),
    ()=>response('auth-options',200,body('auth-options'),{'content-length':'not-a-number'}),
    ()=>response('auth-options',200,' '.repeat(4097)),
    ()=>new Response(new Uint8Array([0xc3,0x28]),{headers:{...headers,'content-type':'application/json'}})]){
    const report=await run(fixture(name=>name==='auth-options'?make():undefined));
    assert.equal(report.checks.find(row=>row.name==='auth-options').pass,false);
  }
});
test('the fixed deadline settles a hanging stream even when cancellation never completes',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const never=()=>new Promise(()=>{});let canceled=0;
  const pending=run(fixture(name=>name==='home'?new Response(new ReadableStream({pull:never,cancel:()=>{canceled++;return never();}}),
    {headers:{...headers,'content-type':'text/html'}}):undefined));
  await new Promise(setImmediate);context.mock.timers.tick(20000);
  const report=await pending;assert.equal(report.failed,1);assert.equal(report.checks[0].pass,false);assert.equal(canceled,1);
});
