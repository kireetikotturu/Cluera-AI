import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';

let db:PGlite;
const uid='00000000-0000-4000-8000-000000000701',sid='00000000-0000-4000-8000-000000000702';
const other='00000000-0000-4000-8000-000000000703',otherSid='00000000-0000-4000-8000-000000000704';
const id=(prefix:string,n:number)=>`${prefix}_${String(n).padStart(26,'0')}`;
const guard='20261011014422_account_checkout_unresolved_bound_guard';
const baselineMigrations=['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations',
 '20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle',
 '20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls','20261008100006_account_admin_catalog_controls',
 '20261009120157_account_credits_snapshot'];
async function call(name:string,args:unknown[]){return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;}
async function prepare(request=randomUUID(),owner=uid,session=sid,offer='pro_3_hours'){return call('customer_checkout_prepare',[owner,session,request,offer]);}
async function resume(owner=uid,session=sid){return call('customer_checkout_resume_read',[owner,session]);}
beforeAll(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 for(const name of [...baselineMigrations,guard])await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
},60000);
beforeEach(async()=>{
 await db.exec('truncate public.customer_accounts,auth.users,auth.sessions,public.paddle_sandbox_events cascade');
 await db.exec('update public.account_catalog_policy set enabled=true');
 for(const [u,s] of [[uid,sid],[other,otherSid]]){
  await db.query('insert into auth.users values($1,$2,now())',[u,`${u}@example.invalid`]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[s,u]);await call('customer_authorize',[u,s]);
 }
});
afterAll(async()=>db?.close());
it('reproduces the original unpaid BOUND bypass and confirms the additive guard changes no existing row',async()=>{
 const baseline=new PGlite();
 try{
  await baseline.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
  for(const name of baselineMigrations)await baseline.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
  await baseline.query('insert into auth.users values($1,$2,now())',[uid,'synthetic@example.invalid']);
  await baseline.query("insert into auth.sessions values($1,$2,null,'aal1')",[sid,uid]);
  const first=(await baseline.query<{v:any}>('select public.customer_checkout_prepare($1,$2,$3,$4) v',[uid,sid,randomUUID(),'pro_3_hours'])).rows[0].v;
  await baseline.query('select public.customer_checkout_complete($1,$2,$3,$4)',[first.intentId,first.attemptId,id('txn',1),'BOUND']);
  expect((await baseline.query<{v:any}>('select public.customer_checkout_prepare($1,$2,$3,$4) v',[uid,sid,randomUUID(),'pro_3_hours'])).rows[0].v.code).toBe('CLAIMED');
  const history=(await baseline.query('select * from public.customer_checkout_intents order by id')).rows;
  await baseline.exec(readFileSync(`../supabase/migrations/${guard}.sql`,'utf8'));
  expect((await baseline.query('select * from public.customer_checkout_intents order by id')).rows).toEqual(history);
  expect((await baseline.query('select * from public.customer_pack_purchases')).rows).toHaveLength(0);
 }finally{await baseline.close();}
},60000);
async function bound(n=1,offer='pro_3_hours'){
 const request=randomUUID(),claim=await prepare(request,uid,sid,offer);
 expect(claim.code).toBe('CLAIMED');
 expect(await call('customer_checkout_complete',[claim.intentId,claim.attemptId,id('txn',n),'BOUND'])).toBe('BOUND');
 return {...claim,request};
}
async function attribution(intent:string,n:number,state='ACTIVE',owner=uid){
 const customer=id('ctm',n);await db.query('insert into public.customer_paddle_bindings(customer_id,user_id) values($1,$2)',[customer,owner]);
 let grant:string|null=null;
 if(state==='ACTIVE')grant=(await db.query<{id:string}>("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms) values($1,$2,'PACK',10800000) returning id",[owner,`synthetic-paid:${n}`])).rows[0].id;
 await db.query('insert into public.customer_pack_purchases(transaction_id,intent_id,user_id,customer_id,state,grant_id) values($1,$2,$3,$4,$5,$6)',[id('txn',n),intent,owner,customer,state,grant]);
}
it('retains multiple October4/October10-style REJECTED histories without blocking a fresh owned claim',async()=>{
 const requests=[randomUUID(),randomUUID()];
 for(const [index,created] of ['2026-10-04T09:45:11.323192Z','2026-10-10T04:56:10.219780Z'].entries())await db.query(
  "insert into public.customer_checkout_intents(user_id,request_id,offer_code,state,created_at) values($1,$2,'pro_3_hours','REJECTED',$3)",[uid,requests[index],created]);
 const snapshot=await call('customer_credits_read',[uid,sid]);expect(snapshot.payments.map((p:any)=>p.state)).toEqual(['REJECTED','REJECTED']);
 expect(await resume()).toEqual({code:'NOT_FOUND'});
 for(const request of requests)expect((await prepare(request)).code).toBe('REJECTED');
 const fresh=await prepare();expect(fresh.code).toBe('CLAIMED');expect((await prepare()).code).toBe('PENDING');
 expect((await db.query('select state from public.customer_checkout_intents where request_id=any($1::uuid[]) order by created_at',[requests])).rows).toEqual([{state:'REJECTED'},{state:'REJECTED'}]);
 expect((await db.query('select * from public.customer_pack_purchases')).rows).toHaveLength(0);
});
it.each(['CREATING','UNCERTAIN'])('retains a real %s lock even after multiple rejected histories and with a new request ID',async state=>{
 for(let n=0;n<2;n++)await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state) values($1,$2,'pro_3_hours','REJECTED')",[uid,randomUUID()]);
 await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state) values($1,$2,'pro_3_hours',$3)",[uid,randomUUID(),state]);
 expect((await prepare()).code).toBe('PENDING');
 expect(await resume()).toEqual({code:'PENDING'});
 expect((await call('customer_credits_read',[uid,sid])).payments.some((p:any)=>p.state===state)).toBe(true);
 expect((await db.query('select * from public.customer_checkout_intents')).rows).toHaveLength(3);
});
it('an unpaid BOUND cannot be bypassed by a new request or another offer, while exact replay returns only its original transaction',async()=>{
 const claim=await bound();expect((await prepare()).code).toBe('PENDING');
 expect(await resume()).toEqual({code:'BOUND',intentId:claim.intentId,offerCode:'pro_3_hours',transactionId:id('txn',1)});
 expect((await prepare(randomUUID(),uid,sid,'enterprise_weekly')).code).toBe('PENDING');
 expect(await prepare(claim.request)).toEqual({code:'BOUND',intentId:claim.intentId,transactionId:id('txn',1)});
 expect((await call('customer_credits_read',[uid,sid])).payments[0].state).toBe('BOUND');
 expect((await db.query('select * from public.customer_checkout_intents')).rows).toHaveLength(1);
 expect((await db.query('select * from public.customer_pack_purchases')).rows).toHaveLength(0);
});
it.each(['ACTIVE','REFUNDED'])('same-owner %s paid pack attribution releases only the new-purchase guard; immutable BOUND remains and packs can stack',async state=>{
 const claim=await bound();await attribution(claim.intentId,1,state);
 expect(await resume()).toEqual({code:'NOT_FOUND'});
 expect((await call('customer_credits_read',[uid,sid])).payments[0].state).toBe(state==='ACTIVE'?'VERIFIED':'REFUNDED');
 expect((await prepare()).code).toBe('CLAIMED');expect((await prepare()).code).toBe('PENDING');
 expect((await db.query('select state,transaction_id from public.customer_checkout_intents where id=$1',[claim.intentId])).rows[0]).toEqual({state:'BOUND',transaction_id:id('txn',1)});
});
it('wrong-owner pack attribution cannot release another account lock',async()=>{
 const claim=await bound();await attribution(claim.intentId,1,'ACTIVE',other);
 expect((await prepare()).code).toBe('PENDING');
 expect((await resume()).code).toBe('BOUND');
 expect((await call('customer_credits_read',[uid,sid])).payments[0].state).toBe('BOUND');
 expect((await prepare(randomUUID(),other,otherSid)).code).toBe('CLAIMED');
});
it('same-owner recurring attribution releases a bound recurring purchase but never a wrong-owner term',async()=>{
 const claim=await bound(1,'pro_40_hours');
 for(const [number,owner] of [[1,uid],[2,other]] as const){
  await db.query('insert into public.customer_paddle_bindings(customer_id,user_id) values($1,$2)',[id('ctm',number),owner]);
  await db.query("insert into public.customer_recurring_subscriptions(subscription_id,customer_id,user_id,tier,offer_code,state,cancel_future,observed_at,paid_through) values($1,$2,$3,'PRO','pro_40_hours','ACTIVE',false,now(),now()+interval '30 days')",[id('sub',number),id('ctm',number),owner]);
 }
 await db.query("insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,state,period_start,period_end) values($1,$2,$3,'ENDED',now()-interval '30 days',now())",[id('txn',1),other,id('sub',2)]);
 expect((await prepare()).code).toBe('PENDING');
 expect((await resume()).code).toBe('BOUND');
 await db.query('update public.customer_recurring_terms set user_id=$1,subscription_id=$2 where transaction_id=$3',[uid,id('sub',1),id('txn',1)]);
 expect((await call('customer_credits_read',[uid,sid])).payments[0].state).toBe('VERIFIED');
 expect((await prepare()).code).toBe('CLAIMED');
 // The fresh CREATING request, not the settled historical term, is pending.
 expect(await resume()).toEqual({code:'PENDING'});
 expect((await db.query('select state from public.customer_checkout_intents where id=$1',[claim.intentId])).rows[0].state).toBe('BOUND');
});
it('does not allow forged/revoked sessions or disabled catalog to bypass the lock, and preserves internal function grants',async()=>{
 await bound();expect((await prepare(randomUUID(),uid,otherSid)).code).toBe('UNAUTHENTICATED');
 await db.exec("update public.account_catalog_policy set enabled=false where offer_code='pro_3_hours'");
 expect((await prepare()).code).toBe('UNAVAILABLE');
 expect(await resume()).toEqual({code:'PENDING'});
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'public.customer_checkout_prepare_core(uuid,uuid,uuid,text)','EXECUTE') ok",[role])).rows[0].ok).toBe(false);
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'public.customer_checkout_resume_read(uuid,uuid)','EXECUTE') ok",[role])).rows[0].ok).toBe(role==='service_role');
 const info=(await db.query<{prosecdef:boolean;proconfig:string[]}>("select prosecdef,proconfig from pg_proc where oid='public.customer_checkout_prepare_core(uuid,uuid,uuid,text)'::regprocedure")).rows[0];
 expect(info.prosecdef).toBe(true);expect(info.proconfig).toContain('search_path=""');expect(info.proconfig).toContain('lock_timeout=2s');expect(info.proconfig).toContain('statement_timeout=5s');
 const resumeInfo=(await db.query<{prosecdef:boolean;proconfig:string[]}>("select prosecdef,proconfig from pg_proc where oid='public.customer_checkout_resume_read(uuid,uuid)'::regprocedure")).rows[0];
 expect(resumeInfo).toEqual(info);
});
it('resume reads require a live owned session and reject suspension without another account binding',async()=>{
 await bound();expect(await resume(uid,otherSid)).toEqual({code:'UNAUTHENTICATED'});
 expect(await resume(other,otherSid)).toEqual({code:'NOT_FOUND'});
 await db.query("update public.customer_accounts set state='SUSPENDED' where user_id=$1",[uid]);
 expect(await resume()).toEqual({code:'SUSPENDED'});
 await db.query('delete from auth.sessions where id=$1',[otherSid]);expect(await resume(other,otherSid)).toEqual({code:'UNAUTHENTICATED'});
});
it('ambiguous multiple unpaid bound transactions never choose one automatically',async()=>{
 for(let n=1;n<=2;n++)await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state,transaction_id) values($1,$2,'pro_3_hours','BOUND',$3)",[uid,randomUUID(),id('txn',n)]);
 const history=(await db.query('select * from public.customer_checkout_intents order by id')).rows;
 expect(await resume()).toEqual({code:'PENDING'});expect((await prepare()).code).toBe('PENDING');
 expect((await db.query('select * from public.customer_checkout_intents order by id')).rows).toEqual(history);
 expect((await db.query('select * from public.customer_usage_grants')).rows).toHaveLength(0);
});
it('full-history resume read preserves an older real UNCERTAIN lock even when ten newer rejected rows fill the visible history',async()=>{
 await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state,created_at) values($1,$2,'pro_3_hours','UNCERTAIN',now()-interval '3 days')",[uid,randomUUID()]);
 for(let n=0;n<10;n++)await db.query("insert into public.customer_checkout_intents(user_id,request_id,offer_code,state) values($1,$2,'pro_3_hours','REJECTED')",[uid,randomUUID()]);
 const snapshot=await call('customer_credits_read',[uid,sid]);expect(snapshot.payments).toHaveLength(10);expect(snapshot.payments.every((p:any)=>p.state==='REJECTED')).toBe(true);
 expect(await resume()).toEqual({code:'PENDING'});expect((await prepare()).code).toBe('PENDING');
 expect((await db.query('select * from public.customer_checkout_intents')).rows).toHaveLength(11);
});
