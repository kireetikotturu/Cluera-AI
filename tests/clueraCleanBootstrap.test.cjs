'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const {TARGET,SOURCES,CORE,REVOKED,prepare,functionDigestSql}=require('../scripts/migrations/prepare-cluera-clean-bootstrap.cjs');
const {PGlite}=createRequire(path.join(__dirname,'../web/package.json'))('@electric-sql/pglite');
const root=path.resolve(__dirname,'..');
async function fixture(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);return db;}
const call=async(db,name,args=[]) =>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;
test('pins every trusted source and refuses wrong target or changed SQL before generating a proposal',()=>{
 const a=prepare();assert.equal(a.target,TARGET);assert.equal(a.activationAuthorized,false);assert.equal(a.sourcePins.length,20);
 assert.throws(()=>prepare('dwqltsqumiwsxtkzdoaa'));assert.throws(()=>prepare('bzccuqforilpifhiysjk'));
 assert.throws(()=>prepare(TARGET,file=>Buffer.concat([fs.readFileSync(path.join(root,file)),Buffer.from('changed')])));
 assert.equal(prepare().sha256,a.sha256);assert.equal(new Set(SOURCES.map(s=>s.file)).size,SOURCES.length);assert(CORE.sha256);
});
test('keeps original proposals unchanged and excludes all old authority/active scheduler material',()=>{
 const {sql}=prepare();assert(!/dwqltsqumiwsxtkzdoaa|sigmaround-account-staging|cron\.schedule|net\.http_post|vault\.(create_secret|decrypted_secrets)|customer_billing_provision_worker/i.test(sql));
 assert(sql.includes('clean_worker_stays_passive'));assert(!/create\s+(?:table|trigger|function)\s+auth\./i.test(sql));
 for(const signature of REVOKED)assert(sql.includes(signature));
 assert(prepare().excluded.some(x=>x.includes('staging_billing_cron')));
});
test('actual clean bootstrap seeds policy only, retains service-only Auth/Admin/ledger/context and leaves all billing passive',async()=>{
 const db=await fixture();try{
  await db.exec(prepare().sql);
  const bodyDigests=(await db.query(functionDigestSql())).rows;
  assert(bodyDigests.length>50);assert(bodyDigests.every(row=>/^[a-f0-9]{32}$/.test(row.body_md5)));
  assert(!bodyDigests.some(row=>row.name==='rls_auto_enable'));
  assert(bodyDigests.some(row=>row.name==='cluera_billing_apply'&&row.definer===true));
  for(const table of ['customer_accounts','customer_trial_grants','customer_usage_grants','account_admin_profiles','account_admin_audit','customer_context_documents','cluera_releases'])
   assert.equal((await db.query(`select count(*) n from public.${table}`)).rows[0].n,0);
  assert.equal((await db.query('select count(*) n from public.account_ai_models where enabled or is_default')).rows[0].n,0);
  assert.equal((await db.query('select count(*) n from public.account_catalog_policy where enabled')).rows[0].n,0);
  assert.equal((await db.query('select count(*) n from cluera_billing_private.catalog_heads where enabled')).rows[0].n,0);
  const catalog=await call(db,'cluera_billing_catalog');
  assert.deepEqual(catalog.map(r=>[r.amountPaise,r.allowanceSeconds,r.testPlanValidated,r.enabled]),[[54900,10800,true,false],[549900,144000,false,false],[959900,360000,false,false],[1954900,720000,false,false]]);
  assert.deepEqual((await db.query("select has_function_privilege('anon','public.rls_auto_enable()','EXECUTE') anon,has_function_privilege('authenticated','public.rls_auto_enable()','EXECUTE') browser,has_function_privilege(current_user,'public.rls_auto_enable()','EXECUTE') owner")).rows[0],{anon:false,browser:false,owner:true});
  assert.deepEqual((await db.query('select owner,epoch from cluera_billing_private.processing_owner')).rows[0],{owner:'cluera',epoch:1});
  assert.deepEqual((await db.query('select enabled,secret_id from billing_private.worker_config')).rows[0],{enabled:false,secret_id:null});
  await db.exec('select billing_private.wake_worker()');
  assert.equal((await db.query("select to_regnamespace('cron') present")).rows[0].present,null);
  for(const fn of ['public.customer_authorize(uuid,uuid)','public.customer_usage_command(uuid,uuid,uuid,integer,text)','public.cluera_credits_read(uuid,uuid)','public.customer_context_command(uuid,uuid,jsonb)','public.account_admin_check(uuid,uuid,boolean)']){
   const value=(await db.query('select has_function_privilege(\'anon\',$1,\'EXECUTE\') anon,has_function_privilege(\'authenticated\',$1,\'EXECUTE\') browser,has_function_privilege(\'service_role\',$1,\'EXECUTE\') service',[fn])).rows[0];assert.deepEqual(value,{anon:false,browser:false,service:true});
  }
  for(const fn of REVOKED)assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') permitted",[fn])).rows[0].permitted,false);
  await assert.rejects(db.exec('update billing_private.worker_config set enabled=true'),/clean_worker_stays_passive/);
 }finally{await db.close();}
});
test('clean PACK has no plan dependency; future explicitly enabled SQL flow grants exactly10800s once and preserves the trial',async()=>{
 const db=await fixture();try{
  await db.exec(prepare().sql);
  const user=crypto.randomUUID(),session=crypto.randomUUID(),digest='a'.repeat(64),order='order_cleanpack0001',payment='pay_cleanpack0001';
  await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,user]);
  assert.equal((await call(db,'customer_authorize',[user,session])).code,'ACTIVE');
  assert.equal((await call(db,'cluera_credits_read',[user,session])).availableMilliseconds,900000);
  const before=(await db.query('select * from public.customer_trial_grants')).rows;
  await db.query('insert into public.account_admin_profiles(user_id) values($1)',[user]);
  const revision=(await call(db,'cluera_billing_catalog'))[0];assert.equal(revision.testPlanValidated,true);
  const enabled=await call(db,'cluera_billing_admin_mutate',[user,session,crypto.randomUUID(),'SET_ENABLED',revision.offerCode,revision.revisionId,new Date().toISOString(),'Synthetic explicitly approved local enablement',{enabled:true}]);
  assert.equal(enabled.code,'APPLIED');
  const intent=await call(db,'cluera_billing_prepare',[user,session,crypto.randomUUID(),revision.revisionId,digest,1]);assert.equal(intent.code,'CLAIMED');
  assert.equal(await call(db,'cluera_billing_bind',[intent.intentId,intent.attemptId,digest,1,{orderId:order,subscriptionId:null}]),'BOUND');
  for(const [index,type] of ['payment.captured','order.paid'].entries()){
   const event={eventId:'evt_cleanpack000'+index,eventType:type,resourceId:index?order:payment,paymentId:payment,orderId:order,subscriptionId:null,invoiceId:null,digest:'b'.repeat(64),occurredAt:new Date().toISOString()};
   assert.equal(await call(db,'cluera_billing_event_accept',[event,digest]),'STORED');
   const claim=await call(db,'cluera_billing_event_claim',[digest,1]);assert.equal(claim.legacy,false);
   const proof={action:'GRANT',intentId:intent.intentId,orderId:order,paymentId:payment,invoiceId:null,subscriptionId:null,amountPaise:54900,currency:'INR',observedAt:new Date().toISOString(),periodStart:null,periodEnd:null,paidAt:null,cancellationAt:null,subscriptionState:null,refundId:null};
   assert.equal((await call(db,'cluera_billing_apply',[event.eventId,claim.claimId,event.digest,digest,1,proof])).code,'VERIFIED');
   assert.equal(await call(db,'cluera_billing_event_accept',[event,digest]),'DUPLICATE');
  }
  const packs=(await db.query("select granted_ms,expires_at,spent_ms,reserved_ms from public.customer_usage_grants where kind='PACK'")).rows;
  assert.deepEqual(packs,[{granted_ms:10800000,expires_at:null,spent_ms:0,reserved_ms:0}]);
  assert.equal((await call(db,'cluera_credits_read',[user,session])).availableMilliseconds,11700000);
  assert.deepEqual((await db.query('select * from public.customer_trial_grants')).rows,before);
  assert.equal((await db.query('select count(*) n from cluera_billing_private.applications')).rows[0].n,2);
 }finally{await db.close();}
});
test('reviewed generated artifact matches exact preparer bytes',()=>{
 assert.equal(fs.readFileSync(path.join(root,'docs/proposals/cluera-clean-foundation.sql'),'utf8'),prepare().sql);
 assert.equal(fs.readFileSync(path.join(root,'supabase/migrations/20261016014532_cluera_clean_foundation.sql'),'utf8'),prepare().sql);
});
test('fresh same UUID receives one once-ever trial; START/STOP, reporting and owner isolation retain ledger invariants',async()=>{
 const db=await fixture();try{
  await db.exec(prepare().sql);
  const user='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000002',run='00000000-0000-4000-8000-000000000003';
  await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[session,user]);
  assert.equal((await call(db,'customer_authorize',[user,session])).code,'ACTIVE');
  const first=await call(db,'cluera_credits_read',[user,session]);assert.equal(first.availableMilliseconds,900000);
  assert.equal((await call(db,'customer_usage_command',[user,session,run,0,'START'])).code,'ACTIVE');
  const spent=await call(db,'customer_usage_command',[user,session,run,1,'STOP']);assert.equal(spent.code,'CLOSED');
  assert.equal((await db.query('select count(*) n from public.customer_trial_grants')).rows[0].n,1);
  assert.equal((await db.query("select count(*) n from public.customer_usage_grants where kind='TRIAL'")).rows[0].n,1);
  assert.equal(await call(db,'account_admin_check',[user,session,true]),false);
  assert.equal((await call(db,'customer_authorize',[user,'00000000-0000-4000-8000-000000000099'])).code,'UNAUTHENTICATED');
  assert.equal((await call(db,'cluera_billing_prepare',[user,session,crypto.randomUUID(),(await call(db,'cluera_billing_catalog'))[0].revisionId,'a'.repeat(64),1])).code,'DISABLED');
 }finally{await db.close();}
});
test('preflight rejects a populated Auth destination or an existing foundation without destructive cleanup',async()=>{
 for(const mode of ['auth','schema']){const db=await fixture();try{
  if(mode==='auth')await db.exec("insert into auth.users values('00000000-0000-4000-8000-000000000001','existing@example.invalid',now())");
  else await db.exec('create table public.existing_customer(id integer)');
  await assert.rejects(db.exec(prepare().sql),/Clean empty destination prerequisite failed/);
  assert.equal((await db.query("select to_regnamespace('billing_private') present")).rows[0].present,null);
 }finally{await db.close();}}
});
