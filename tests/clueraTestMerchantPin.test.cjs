'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
const {PGlite}=createRequire(path.join(__dirname,'../web/package.json'))('@electric-sql/pglite');
const {PROJECT,APPROVAL,TEMPLATE_SHA,EVIDENCE_MAX_AGE_MS,APPROVAL_MAX_AGE_MS,prepareMerchantPin}=require('../scripts/payments/prepare-cluera-test-merchant-pin.cjs');
const root=path.resolve(__dirname,'..'),foundation=fs.readFileSync(path.join(root,'docs/proposals/cluera-clean-foundation.sql'),'utf8');
function evidence(now=Date.now()){
 const operationId=randomUUID(),at=new Date(now).toISOString();return {projectRef:PROJECT,operationId,merchantDigest:'a'.repeat(64),
 evidence:{projectRef:PROJECT,deploymentId:'dpl_synthetic0001',sourceCommit:'b'.repeat(40),reportDigest:'c'.repeat(64),observedAt:at,
 testAuthentication:true,merchantMatches:true,configuredDigestMatches:true,testModeVerified:true,requests:2,mutations:0},
 approval:{scope:APPROVAL,projectRef:PROJECT,operationId,approvedAt:at,merchantDigest:'a'.repeat(64),templateSha256:TEMPLATE_SHA}};
}
async function fixture(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);await db.exec(foundation);return db;}
async function owner(db){return(await db.query('select to_jsonb(o) value from cluera_billing_private.processing_owner o')).rows[0].value;}
async function audit(db){return(await db.query('select * from cluera_billing_private.cutover_audit')).rows;}
async function assertPinFails(db,sql,pattern){const before=await owner(db),beforeAudit=await audit(db);
 await assert.rejects(db.exec(sql),pattern);await db.exec('rollback');assert.deepEqual(await owner(db),before);assert.deepEqual(await audit(db),beforeAudit);}

test('requires exact clean target, fresh verified merchant evidence and separate exact operation-bound owner approval',()=>{
 const input=evidence(),now=Date.parse(input.evidence.observedAt),good=prepareMerchantPin(input,now);
 assert.equal(good.projectRef,PROJECT);assert.equal(good.preparedOnly,true);assert.equal(good.activationAuthorized,false);
 assert.equal(good.financialObligationsCleared,false);assert.equal(good.executionTargetIndependentlyVerified,false);
 for(const change of [x=>x.projectRef='dwqltsqumiwsxtkzdoaa',x=>x.projectRef='bzccuqforilpifhiysjk',x=>x.secret='never-accept-secret',
 x=>x.merchantDigest='acc_syntheticmerchant',x=>x.operationId="x';delete",x=>x.evidence.merchantMatches=false,
 x=>x.evidence.configuredDigestMatches=false,x=>x.evidence.testAuthentication=false,x=>x.evidence.testModeVerified=false,
 x=>x.evidence.requests=0,x=>x.evidence.requests=1,x=>x.evidence.requests=14,x=>x.evidence.mutations=1,x=>x.evidence.projectRef='foreign',x=>x.evidence.rawBody='never-accept-body',
 x=>x.evidence.deploymentId="dpl_injected';",x=>x.approval.operationId=randomUUID(),x=>x.approval.scope='APPROVE_ALL_PAYMENTS',
 x=>x.approval.projectRef='foreign',x=>delete x.approval,
 x=>x.approval.merchantDigest='d'.repeat(64),x=>x.approval.templateSha256='d'.repeat(64),
 x=>delete x.approval.merchantDigest,x=>delete x.approval.templateSha256,
 x=>x.approval.approvedAt=new Date(now+1).toISOString(),
 x=>x.approval.approvedAt=new Date(now-APPROVAL_MAX_AGE_MS-1).toISOString(),
 x=>x.evidence.observedAt=new Date(now+1).toISOString()]){
  const bad=structuredClone(input);change(bad);assert.throws(()=>prepareMerchantPin(bad,now));
 }
 assert.throws(()=>prepareMerchantPin(input,now+120001),/expired/);
 assert.throws(()=>prepareMerchantPin(input,now-1),/expired/);
 assert.equal(EVIDENCE_MAX_AGE_MS,120000);assert.equal(APPROVAL_MAX_AGE_MS,3600000);
 const preapproved=structuredClone(input);preapproved.approval.approvedAt=new Date(now-180000).toISOString();
 const rechecked=prepareMerchantPin(preapproved,now);
 assert(rechecked.sql.includes(preapproved.approval.approvedAt));assert(rechecked.sql.includes(input.evidence.observedAt));
 assert.equal(preapproved.approval.approvedAt,new Date(now-180000).toISOString());
 const boundary=structuredClone(preapproved);boundary.approval.approvedAt=new Date(now-APPROVAL_MAX_AGE_MS).toISOString();
 assert.doesNotThrow(()=>prepareMerchantPin(boundary,now));
 const almostExpired=structuredClone(preapproved);almostExpired.approval.approvedAt=new Date(now-APPROVAL_MAX_AGE_MS+1000).toISOString();
 const bounded=prepareMerchantPin(almostExpired,now);
 assert(bounded.sql.includes("deadline timestamptz:='"+new Date(now+1000).toISOString()+"'"));
 const expiredApproval=structuredClone(preapproved);expiredApproval.approval.approvedAt=new Date(now-APPROVAL_MAX_AGE_MS-1).toISOString();
 assert.throws(()=>prepareMerchantPin(expiredApproval,now),/expired/);
 const expiredEvidence=structuredClone(preapproved);expiredEvidence.evidence.observedAt=new Date(now-EVIDENCE_MAX_AGE_MS-1).toISOString();
 assert.throws(()=>prepareMerchantPin(expiredEvidence,now),/expired/);
 const invalidDate=evidence(Date.parse('2026-03-03T12:00:00.000Z'));
 invalidDate.evidence.observedAt='2026-02-31T12:00:00.000Z';
 assert.throws(()=>prepareMerchantPin(invalidDate,Date.parse(invalidDate.approval.approvedAt)),/expired/);
});
test('pins exact applied-clean and template bytes, never imports credentials/env/network or creates privileged APIs',()=>{
 const input=evidence(),good=prepareMerchantPin(input);assert(!/__\w+__/.test(good.sql));
 const statements=good.sql.replace(/--[^\r\n]*/g,'');
 assert(!/\b(?:grant|revoke|create\s+(?:function|table|policy)|net\.http|cron\.schedule|vault\.)\b/i.test(statements));
 assert(!/dwqltsqumiwsxtkzdoaa|sigmaround-account-staging|rzp_test_|acc_/.test(good.sql));
 assert.equal((good.sql.match(/update cluera_billing_private\.processing_owner/g)||[]).length,1);
 assert.equal((good.sql.match(/insert into cluera_billing_private\.cutover_audit/g)||[]).length,1);
 assert(!/set\s+(?:owner|epoch)\s*=/.test(good.sql));
 for(const suffix of ['foundation.sql','merchant-pin.sql'])assert.throws(()=>prepareMerchantPin(input,Date.now(),file=>{
  const bytes=fs.readFileSync(path.join(root,file));return file.endsWith(suffix)?Buffer.concat([bytes,Buffer.from('changed')]):bytes;
 }),/source mismatch/);
 const source=fs.readFileSync(path.join(root,'scripts/payments/prepare-cluera-test-merchant-pin.cjs'),'utf8');
 assert(!/process\.env|\bfetch\(|https:\/\/|createClient|writeFile|execSync/.test(source));
});
test('every expected string rejects coercible objects without executing toString or malicious toJSON',()=>{
 const stringFields=[['projectRef'],['operationId'],['merchantDigest'],
 ['evidence','projectRef'],['evidence','deploymentId'],['evidence','sourceCommit'],['evidence','reportDigest'],['evidence','observedAt'],
 ['approval','scope'],['approval','projectRef'],['approval','operationId'],['approval','approvedAt'],['approval','merchantDigest'],['approval','templateSha256']];
 for(const fields of stringFields){
  const input=evidence(),target=fields.length===1?input:input[fields[0]],key=fields.at(-1),valid=target[key];let calls=0;
  target[key]={toString(){calls++;return valid;},toJSON(){calls++;return "';update cluera_billing_private.processing_owner set epoch=999;--";}};
  assert.throws(()=>prepareMerchantPin(input));assert.equal(calls,0);
 }
});
test('rejects inherited/hidden serialization hooks, accessors and apostrophe injection; legitimate provenance apostrophe is SQL-escaped',()=>{
 for(const location of ['root','evidence','approval']){
  for(const kind of ['inherited','hidden','accessor']){
   const input=evidence(),target=location==='root'?input:input[location];let calls=0;
   const attack=()=>{calls++;return "';delete from public.customer_accounts;--";};
   if(kind==='inherited')Object.setPrototypeOf(target,{toJSON:attack});
   else if(kind==='hidden')Object.defineProperty(target,'toJSON',{value:attack,enumerable:false});
   else Object.defineProperty(target,location==='root'?'merchantDigest':location==='evidence'?'deploymentId':'approvedAt',{get:attack,enumerable:true});
   assert.throws(()=>prepareMerchantPin(input));assert.equal(calls,0);
  }
 }
 const injected=evidence();injected.evidence.deploymentId="dpl_synthetic0001';delete from public.customer_accounts;--";
 assert.throws(()=>prepareMerchantPin(injected));
 assert(prepareMerchantPin(evidence()).sql.includes("Owner''s direct approval"));
});
test('exact clean synthetic bootstrap tightens only merchant digest and records immutable before/after provenance; identical replay is read-only',async()=>{
 const db=await fixture();try{
  const user=randomUUID(),session=randomUUID();await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[session,user]);await db.query('select public.customer_authorize($1,$2)',[user,session]);
  const before=(await db.query('select to_jsonb(c) customer,to_jsonb(t) trial from public.customer_accounts c join public.customer_trial_grants t using(user_id)')).rows;
  const input=evidence(),prepared=prepareMerchantPin(input);await db.exec(prepared.sql);
  const row=await owner(db),records=await audit(db);assert.equal(row.owner,'cluera');assert.equal(row.epoch,1);assert.equal(row.account_digest,input.merchantDigest);
  assert.equal(records.length,1);const record=records[0];assert.equal(record.reason,'OWNER_AUTHORIZED_CLEAN_TEST_MERCHANT_PIN');
  assert.equal(record.before_row.account_digest,null);assert.equal(record.after_row.account_digest,input.merchantDigest);
  assert.equal(record.after_row._merchantPin.activationAuthorized,false);assert.equal(record.after_row._merchantPin.financialObligationsCleared,false);
  assert.equal(record.after_row._merchantPin.evidence.reportDigest,input.evidence.reportDigest);
  assert.equal(record.after_row._merchantPin.approval.operationId,input.operationId);assert.equal(typeof record.after_row._merchantPin.executor,'string');
  assert.equal(record.after_row._merchantPin.approval.merchantDigest,input.merchantDigest);
  assert.equal(record.after_row._merchantPin.approval.templateSha256,TEMPLATE_SHA);
  assert.equal(record.after_row._merchantPin.approval.approvedAt,input.approval.approvedAt);
  assert.equal(record.after_row._merchantPin.authority,"Owner's direct approval; database operator execution, not authenticated Admin action");
  await db.exec(prepared.sql);assert.deepEqual(await owner(db),row);assert.deepEqual(await audit(db),records);
  assert.deepEqual((await db.query('select to_jsonb(c) customer,to_jsonb(t) trial from public.customer_accounts c join public.customer_trial_grants t using(user_id)')).rows,before);
  for(const table of ['public.customer_usage_grants','cluera_billing_private.intents','cluera_billing_private.events','cluera_billing_private.payments'])
   assert.equal((await db.query(`select count(*) n from ${table}`)).rows[0].n,0);
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/standby mismatch/);
  const changed=structuredClone(input);changed.merchantDigest='d'.repeat(64);changed.approval.merchantDigest=changed.merchantDigest;await assertPinFails(db,prepareMerchantPin(changed).sql,/replay conflict/);
  await assert.rejects(db.exec('delete from cluera_billing_private.cutover_audit'),/immutable/);
 }finally{await db.close();}
});
test('refuses active catalog, paid allowance, accepted financial receipt or preexisting plan evidence without changing existing rows',async()=>{
 const db=await fixture();try{
  await db.exec('update cluera_billing_private.catalog_heads set enabled=true');await assertPinFails(db,prepareMerchantPin(evidence()).sql,/activation/);
  await db.exec('update cluera_billing_private.catalog_heads set enabled=false');
  const user=randomUUID(),session=randomUUID();await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[session,user]);await db.query('select public.customer_authorize($1,$2)',[user,session]);
  await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at) values($1,'synthetic-test-allowance','PACK',60000,now())",[user]);
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/paid allowance/);await db.exec('delete from public.customer_usage_grants');
  await db.query("insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,digest,occurred_at) values('evt_synthetic0001',$1,'payment.captured','pay_synthetic0001',$2,now())",['a'.repeat(64),'b'.repeat(64)]);
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/financial evidence/);assert.equal((await db.query('select count(*) n from cluera_billing_private.events')).rows[0].n,1);
 }finally{await db.close();}
});
test('schema/function/RLS/grant/audit drift and an expired execution window fail closed; no owner metadata is changed',async()=>{
 const db=await fixture();try{
  await db.exec('alter table cluera_billing_private.cutover_audit disable trigger immutable');await assertPinFails(db,prepareMerchantPin(evidence()).sql,/immutable audit/);
  await db.exec('alter table cluera_billing_private.cutover_audit enable always trigger immutable');
  await db.exec('alter table cluera_billing_private.events disable row level security');await assertPinFails(db,prepareMerchantPin(evidence()).sql,/table security/);
  await db.exec('alter table cluera_billing_private.events enable row level security;grant select on cluera_billing_private.events to anon');
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/table privilege/);await db.exec('revoke select on cluera_billing_private.events from anon');
  await db.exec('grant execute on function public.cluera_billing_owner(text) to anon');
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/function (?:privilege|metadata)/);await db.exec('revoke execute on function public.cluera_billing_owner(text) from anon');
  await db.exec('alter function public.cluera_billing_owner(text) security invoker');
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/function metadata/);await db.exec('alter function public.cluera_billing_owner(text) security definer');
  await db.exec("alter function public.cluera_billing_owner(text) set statement_timeout='8s'");
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/function metadata/);await db.exec("alter function public.cluera_billing_owner(text) set statement_timeout='5s'");
  await db.exec('revoke execute on function public.cluera_billing_owner(text) from service_role');
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/function metadata/);await db.exec('grant execute on function public.cluera_billing_owner(text) to service_role');
  await db.exec('grant execute on function cluera_billing_private.owns(text,text,bigint) to service_role');
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/function metadata/);await db.exec('revoke execute on function cluera_billing_private.owns(text,text,bigint) from service_role');
  await db.exec("create function cluera_billing_private.synthetic_owner_trigger() returns trigger language plpgsql as $$begin return new;end$$;create trigger synthetic_owner before update on cluera_billing_private.processing_owner for each row execute function cluera_billing_private.synthetic_owner_trigger()");
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/trigger or rule/);await db.exec('drop trigger synthetic_owner on cluera_billing_private.processing_owner;drop function cluera_billing_private.synthetic_owner_trigger()');
  await db.exec('create schema cron;create table cron.job(active boolean);insert into cron.job values(true)');
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/active scheduler/);await db.exec('drop schema cron cascade');
  const old=Date.now()-180000;await assertPinFails(db,prepareMerchantPin(evidence(old),old).sql,/expired/);
  await db.exec("create or replace function cluera_billing_private.owns(p_digest text,p_owner text,p_epoch bigint default null) returns boolean language sql security invoker set search_path='' as $$select false$$");
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/implementation mismatch/);
 }finally{await db.close();}
});
test('audit insertion failure atomically rolls back the merchant pin, without weakening existing immutable trigger',async()=>{
 const db=await fixture();try{
  await db.exec("alter table cluera_billing_private.cutover_audit add constraint synthetic_audit_failure check(reason<>'OWNER_AUTHORIZED_CLEAN_TEST_MERCHANT_PIN')");
  await assertPinFails(db,prepareMerchantPin(evidence()).sql,/synthetic_audit_failure/);
  assert.equal((await owner(db)).account_digest,null);assert.equal((await audit(db)).length,0);
 }finally{await db.close();}
});
