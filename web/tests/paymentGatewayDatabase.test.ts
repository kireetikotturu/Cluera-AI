import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';

const uid='00000000-0000-4000-8000-000000000801', sid='00000000-0000-4000-8000-000000000802';
const other='00000000-0000-4000-8000-000000000803', otherSid='00000000-0000-4000-8000-000000000804';
const accountDigest='a'.repeat(64), eventDigest='b'.repeat(64);
const migration='20261012013828_account_gateway_test_pack';
const baseline=['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations',
 '20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs',
 '20261004081025_sandbox_recurring_lifecycle','20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls',
 '20261008100006_account_admin_catalog_controls','20261009120157_account_credits_snapshot','20261011014422_account_checkout_unresolved_bound_guard'];
let db:PGlite;
async function rpc(name:string,args:unknown[]){return (await db.query<{value:any}>(`select public.${name}(${args.map((_,n)=>'$'+(n+1)).join(',')}) value`,args)).rows[0].value;}
beforeAll(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 for(const name of baseline)await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
 await db.exec('create schema if not exists billing_private;create table billing_private.worker_config(singleton boolean primary key,secret_id uuid,enabled boolean,last_sent_at timestamptz,last_request_id bigint);');
 await db.exec(readFileSync('../supabase/migrations/20261004093908_checkout_recovery_audit.sql','utf8'));
 await db.exec(readFileSync(`../supabase/migrations/${migration}.sql`,'utf8'));
},60000);
beforeEach(async()=>{
 // These are isolated synthetic test databases, NEVER hosted financial rows.
 await db.exec('alter table billing_private.payment_applications disable trigger payment_applications_immutable;alter table billing_private.payment_diagnostics disable trigger payment_diagnostics_immutable;alter table billing_private.checkout_recovery_audit disable trigger checkout_recovery_audit_immutable;truncate public.customer_accounts,auth.users,auth.sessions,public.paddle_sandbox_events,billing_private.payment_events cascade;alter table billing_private.payment_applications enable always trigger payment_applications_immutable;alter table billing_private.payment_diagnostics enable always trigger payment_diagnostics_immutable;alter table billing_private.checkout_recovery_audit enable always trigger checkout_recovery_audit_immutable;update public.account_catalog_policy set enabled=true;');
 for(const [u,s] of [[uid,sid],[other,otherSid]]){
  await db.query('insert into auth.users values($1,$2,now())',[u,`${u}@example.invalid`]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[s,u]);await rpc('customer_authorize',[u,s]);
 }
});
afterAll(async()=>db?.close());
const order=(n=1)=>`order_synthetic000${n}`,payment=(n=1)=>`pay_synthetic000${n}`;
async function prepare(request=randomUUID(),user=uid,session=sid){return rpc('account_payment_prepare',[user,session,request,accountDigest]);}
async function bound(n=1){const i=await prepare();expect(i.code).toBe('CLAIMED');expect(await rpc('account_payment_bind',[i.intentId,i.attemptId,accountDigest,order(n)])).toBe('BOUND');return i;}
async function receive(n=1,type='payment.captured',refund=false){
 return rpc('account_payment_receive',[{eventId:`evt_synthetic000${n}`,eventType:type,resourceId:refund?'rfnd_synthetic0001':type==='order.paid'?order():payment(),
 paymentId:payment(),orderId:refund?null:order(),digest:eventDigest,occurredAt:'2026-10-12T00:00:00Z'},accountDigest]);
}
async function apply(i:any,n=1,action='GRANT',overrides:Record<string,unknown>={}){
 const claim=await rpc('account_payment_claim',[accountDigest]);expect(claim.code).toBe('CLAIMED');
 return rpc('account_payment_apply',[`evt_synthetic000${n}`,claim.claimId,eventDigest,accountDigest,{action,intentId:i.intentId,orderId:order(),paymentId:payment(),amount:54900,currency:'INR',observedAt:new Date().toISOString(),refundId:action==='REFUND'?'rfnd_synthetic0001':null,...overrides}]);
}
const rows=async(table:string)=>(await db.query(`select * from ${table}`)).rows;
it('preserves old REJECTED histories and the unpaid Paddle BOUND without financial migration or deletion',async()=>{
 for(const state of ['REJECTED','REJECTED','BOUND'])await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state,transaction_id) values($1,$2,'pro_3_hours',$3,$4)",[uid,randomUUID(),state,state==='BOUND'?'txn_00000000000000000000000001':null]);
 const before=await rows('public.customer_checkout_intents');expect((await prepare()).code).toBe('CLAIMED');
 expect(await rows('public.customer_checkout_intents')).toEqual(before);expect(await rows('public.customer_pack_purchases')).toHaveLength(0);
});
it('single account lock and unique unresolved index prevent concurrent new operation UUIDs',async()=>{
 const results=await Promise.all(Array.from({length:8},()=>prepare()));
 expect(results.filter(x=>x.code==='CLAIMED')).toHaveLength(1);expect(results.filter(x=>x.code==='PENDING')).toHaveLength(7);
 expect(await rows('billing_private.payment_intents')).toHaveLength(1);
});
it('unknown creation stays UNCERTAIN and request replay cannot issue a second claim or cross account',async()=>{
 const request=randomUUID(),i=await prepare(request);
 expect(await rpc('account_payment_bind',[i.intentId,i.attemptId,accountDigest,null])).toBe('UNCERTAIN');
 expect((await prepare(request)).code).toBe('UNCERTAIN');expect((await prepare()).code).toBe('PENDING');
 expect((await prepare(randomUUID(),other,otherSid)).code).toBe('CLAIMED');
});
it('rejects invalid sessions, disabled catalog and mismatched attempt/key identity',async()=>{
 expect((await prepare(randomUUID(),uid,otherSid)).code).toBe('UNAUTHENTICATED');
 await db.exec("update public.account_catalog_policy set enabled=false where offer_code='pro_3_hours'");expect((await prepare()).code).toBe('DISABLED');
 await db.exec("update public.account_catalog_policy set enabled=true where offer_code='pro_3_hours'");const i=await prepare();
 expect(await rpc('account_payment_bind',[i.intentId,randomUUID(),accountDigest,order()])).toBe('CONFLICT');
 expect(await rpc('account_payment_bind',[i.intentId,i.attemptId,'c'.repeat(64),order()])).toBe('CONFLICT');
 expect((await rows('billing_private.payment_intents'))[0].state).toBe('CREATING');
});
it('signed receipt and fresh verified evidence provision exactly10800 non-expiring seconds once across both capture events',async()=>{
 const i=await bound();await receive(1);expect((await apply(i)).code).toBe('VERIFIED');
 expect(await receive(1)).toBe('DUPLICATE');await receive(2,'order.paid');expect((await apply(i,2)).code).toBe('VERIFIED');
 const grants=(await rows('public.customer_usage_grants')).filter((x:any)=>x.kind==='PACK');expect(grants).toHaveLength(1);
 expect(grants[0]).toMatchObject({granted_ms:10800000,expires_at:null,state:'ACTIVE'});
 expect(await rows('billing_private.payment_applications')).toHaveLength(2);
 const credits=await rpc('customer_credits_read',[uid,sid]);expect(credits.availableMilliseconds).toBe(11700000);
 expect(credits.payments[0].state).toBe('VERIFIED');expect((await prepare()).code).toBe('CLAIMED');
});
it.each([{amount:54899},{currency:'USD'},{paymentId:payment(2)},{orderId:order(2)},{intentId:randomUUID()},
 {observedAt:'2000-01-01T00:00:00Z'},{observedAt:null},{action:'BROWSER_SUCCESS'},{refundId:'rfnd_synthetic0001'}])('invalid authoritative projection never grants: %j',async overrides=>{
 const i=await bound();await receive();expect((await apply(i,1,'GRANT',overrides)).code).not.toBe('VERIFIED');
 expect((await rows('public.customer_usage_grants')).filter((x:any)=>x.kind==='PACK')).toHaveLength(0);
 expect((await rows('billing_private.payment_intents'))[0].state).toBe('BOUND');
});
it('unclaimed event, null proof and expired lease cannot grant',async()=>{
 const i=await bound();await receive();const evidence={action:'GRANT',intentId:i.intentId,orderId:order(),paymentId:payment(),amount:54900,currency:'INR',observedAt:new Date().toISOString(),refundId:null};
 expect((await rpc('account_payment_apply',['evt_synthetic0001',null,null,null,evidence])).code).toBe('INVALID');
 const claim=await rpc('account_payment_claim',[accountDigest]);await db.exec("update billing_private.payment_events set lease_until=now()-interval '1 second'");
 expect((await rpc('account_payment_apply',['evt_synthetic0001',claim.claimId,eventDigest,accountDigest,evidence])).code).toBe('CONFLICT');
 expect((await rows('public.customer_usage_grants')).filter((x:any)=>x.kind==='PACK')).toHaveLength(0);
});
it('conflicting duplicate is quarantined, never upgraded to signed financial authority',async()=>{
 const i=await bound();await receive();await rpc('account_payment_receive',[{eventId:'evt_synthetic0001',eventType:'payment.captured',resourceId:payment(),paymentId:payment(),orderId:order(),digest:'c'.repeat(64),occurredAt:new Date().toISOString()},accountDigest]);
 expect((await rpc('account_payment_claim',[accountDigest])).code).toBe('EMPTY');expect((await rows('billing_private.payment_intents'))[0].state).toBe('BOUND');
});
it('full refund before grant leaves a permanent tombstone; late capture cannot resurrect credit',async()=>{
 const i=await bound();await receive(1,'refund.processed',true);expect((await apply(i,1,'REFUND')).code).toBe('REFUNDED');
 await receive(2);expect((await apply(i,2)).code).toBe('REFUNDED');
 expect((await rows('public.customer_usage_grants')).filter((x:any)=>x.kind==='PACK')).toHaveLength(0);
});
it('refund revokes only attributable unspent time, retains original grant/history and does not reset trial',async()=>{
 const i=await bound();await receive(1);await apply(i);
 await db.exec("update public.customer_usage_grants set spent_ms=60000 where kind='PACK'");
 const trial=await rows('public.customer_trial_grants');await receive(2,'refund.processed',true);await apply(i,2,'REFUND');
 const grant=(await rows('public.customer_usage_grants')).find((x:any)=>x.kind==='PACK');expect(grant).toMatchObject({state:'REVOKED',spent_ms:60000,granted_ms:10800000});
 expect((await rows('billing_private.payment_applications'))[1].removed_ms).toBe(10740000);expect(await rows('public.customer_trial_grants')).toEqual(trial);
});
it('audit failure rolls back ledger, intent and event atomically; application audits reject mutation',async()=>{
 const i=await bound();await receive();await db.exec("create function billing_private.fail_application() returns trigger language plpgsql as $$ begin raise exception 'Synthetic audit failure'; end $$;create trigger fail_application before insert on billing_private.payment_applications for each row execute function billing_private.fail_application();");
 await expect(apply(i)).rejects.toThrow();expect((await rows('public.customer_usage_grants')).filter((x:any)=>x.kind==='PACK')).toHaveLength(0);
 expect((await rows('billing_private.payment_intents'))[0].state).toBe('BOUND');await db.exec('drop trigger fail_application on billing_private.payment_applications;drop function billing_private.fail_application();');
 await expect(db.exec('delete from billing_private.payment_applications')).rejects.toThrow(/append-only/);
});
it('browser/service direct CRUD denied, definer RPCs have empty search paths and browser execution is denied',async()=>{
 for(const table of ['payment_intents','payment_events','payment_applications','payment_diagnostics'])for(const role of ['anon','authenticated','service_role'])
  expect((await db.query<{ok:boolean}>(`select has_table_privilege('${role}','billing_private.${table}','SELECT,INSERT,UPDATE,DELETE') ok`)).rows[0].ok).toBe(false);
 for(const role of ['anon','authenticated'])expect((await db.query<{ok:boolean}>(`select has_function_privilege('${role}','public.account_payment_apply(text,uuid,text,text,jsonb)','EXECUTE') ok`)).rows[0].ok).toBe(false);
 expect((await db.query<{ok:boolean}>("select has_function_privilege('service_role','public.account_payment_apply(text,uuid,text,text,jsonb)','EXECUTE') ok")).rows[0].ok).toBe(true);
 expect((await db.query<{proconfig:string[]}>("select proconfig from pg_proc where oid='public.account_payment_apply(text,uuid,text,text,jsonb)'::regprocedure")).rows[0].proconfig).toContain('search_path=""');
});
