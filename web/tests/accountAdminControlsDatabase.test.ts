import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db:PGlite;const actor=randomUUID(),customer=randomUUID(),other=randomUUID(),session=randomUUID(),customerSession=randomUUID();
const migrations=['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations','20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle','20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls','20261008100006_account_admin_catalog_controls'];
async function call(name:string,args:unknown[]){return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;}
const adjust=(action:string,input:object,op=randomUUID(),subject:string|null=customer)=>call('account_admin_adjust',[actor,session,op,subject,action,'Synthetic audited account adjustment',input]);
beforeAll(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 for(const m of migrations)await db.exec(readFileSync(`../supabase/migrations/${m}.sql`,'utf8'));
 for(const [id,sid] of [[actor,session],[customer,customerSession],[other,randomUUID()]]){
  await db.query('insert into auth.users values($1,$2,now())',[id,`${id}@example.invalid`]);await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[sid,id]);await call('customer_authorize',[id,sid]);
 }
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[actor]);
},60000);
afterAll(async()=>db?.close());
it('rejects unknown admins, mismatched sessions, expired sessions and AAL1',async()=>{
 expect((await call('account_admin_adjust',[customer,customerSession,randomUUID(),customer,'ADD_MINUTES','Forbidden manual adjustment',{minutes:60}])).code).toBe('FORBIDDEN');
 expect((await call('account_admin_read_v2',[actor,customerSession])).code).toBe('FORBIDDEN');
 await db.query("update auth.sessions set aal='aal1' where id=$1",[session]);expect((await adjust('ADD_MINUTES',{minutes:60})).code).toBe('FORBIDDEN');
 await db.query("update auth.sessions set aal='aal2',not_after=now()-interval '1 minute' where id=$1",[session]);expect((await adjust('ADD_MINUTES',{minutes:60})).code).toBe('FORBIDDEN');
 await db.query('update auth.sessions set not_after=null where id=$1',[session]);
});
it('adds idempotent non-paid grants and records an immutable reason/input',async()=>{
 const op=randomUUID();expect((await adjust('ADD_MINUTES',{minutes:70},op)).code).toBe('APPLIED');expect((await adjust('ADD_MINUTES',{minutes:70},op)).code).toBe('APPLIED');
 expect((await adjust('ADD_MINUTES',{minutes:71},op)).code).toBe('CONFLICT');
 const rows=(await db.query<any>('select * from public.customer_usage_grants where source_key=$1',['admin-adjustment:'+op])).rows;expect(rows).toHaveLength(1);expect(Number(rows[0].granted_ms)).toBe(4200000);expect(rows[0].expires_at).toBeNull();
 expect((await db.query('select * from public.customer_pack_purchases')).rows).toHaveLength(0);
 expect((await db.query('select * from public.customer_recurring_subscriptions')).rows).toHaveLength(0);
 expect((await db.query('select * from public.account_admin_audit where operation_id=$1',[op])).rows).toHaveLength(1);
 await expect(db.exec('delete from public.account_admin_audit')).rejects.toThrow('immutable');
});
it('removes only unused unreserved minutes without negative balances or another owner grants',async()=>{
 const op=randomUUID();await adjust('ADD_MINUTES',{minutes:3},op);const g=(await db.query<any>('select * from public.customer_usage_grants where source_key=$1',['admin-adjustment:'+op])).rows[0];
 await db.query('update public.customer_usage_grants set spent_ms=30000,reserved_ms=30000 where id=$1',[g.id]);
 expect((await adjust('REMOVE_MINUTES',{grantId:g.id,minutes:3})).code).toBe('INSUFFICIENT_UNUSED');
 expect((await adjust('REMOVE_MINUTES',{grantId:g.id,minutes:1},randomUUID(),other)).code).toBe('NOT_FOUND');
 const remove=randomUUID();expect((await adjust('REMOVE_MINUTES',{grantId:g.id,minutes:2},remove)).code).toBe('APPLIED');expect((await adjust('REMOVE_MINUTES',{grantId:g.id,minutes:2},remove)).code).toBe('APPLIED');
 const row=(await db.query<any>('select * from public.customer_usage_grants where id=$1',[g.id])).rows[0];expect(Number(row.granted_ms)).toBe(60000);expect(Number(row.spent_ms)+Number(row.reserved_ms)).toBe(60000);
 expect((await adjust('REMOVE_MINUTES',{grantId:g.id,minutes:1})).code).toBe('INSUFFICIENT_UNUSED');
});
it('fully removes an unused grant durably while preserving attribution and trial invariants',async()=>{
 const op=randomUUID();await adjust('ADD_MINUTES',{minutes:1},op);const g=(await db.query<any>('select * from public.customer_usage_grants where source_key=$1',['admin-adjustment:'+op])).rows[0];
 expect((await adjust('REMOVE_MINUTES',{grantId:g.id,minutes:1})).code).toBe('APPLIED');
 const row=(await db.query<any>('select * from public.customer_usage_grants where id=$1',[g.id])).rows[0];expect(Number(row.granted_ms)).toBe(0);
 await db.query("update public.customer_usage_grants set state='PAUSED' where id=$1",[g.id]);await db.query("update public.customer_usage_grants set state='ACTIVE' where id=$1",[g.id]);
 expect(Number((await db.query<any>('select granted_ms from public.customer_usage_grants where id=$1',[g.id])).rows[0].granted_ms)).toBe(0);
 await call('customer_usage_command',[customer,customerSession,randomUUID(),0,'START']);const trial=(await db.query<any>("select id from public.customer_usage_grants where user_id=$1 and kind='TRIAL'",[customer])).rows[0];
 expect((await adjust('REMOVE_MINUTES',{grantId:trial.id,minutes:1})).code).toBe('INVALID');
});
it('serializes simultaneous submitted removals; only one can spend the last unused allowance',async()=>{
 const op=randomUUID();await adjust('ADD_MINUTES',{minutes:1},op);const g=(await db.query<any>('select id from public.customer_usage_grants where source_key=$1',['admin-adjustment:'+op])).rows[0];
 const outcomes=await Promise.all([adjust('REMOVE_MINUTES',{grantId:g.id,minutes:1}),adjust('REMOVE_MINUTES',{grantId:g.id,minutes:1})]);
 expect(outcomes.filter(r=>r.code==='APPLIED')).toHaveLength(1); // PGlite queues SQL; real multi-connection acceptance remains separate.
});
it('does not resurrect removed Pro minutes when the real paused-plan scheduler resumes it',async()=>{
 const grant=randomUUID(),ctm='ctm_'+'a'.repeat(26),sub='sub_'+'a'.repeat(26),txn='txn_'+'a'.repeat(26);
 await db.query('insert into public.customer_paddle_bindings(customer_id,user_id) values($1,$2)',[ctm,other]);
 await db.query("insert into public.customer_usage_grants(id,user_id,source_key,kind,granted_ms,state,starts_at,expires_at) values($1,$2,$3,'RECURRING',60000,'PAUSED',now()-interval '2 days',now()-interval '1 day')",[grant,other,'synthetic-paused-pro']);
 await db.query("insert into public.customer_recurring_subscriptions(subscription_id,user_id,customer_id,offer_code,tier,state,observed_at,paid_through,cancel_future) values($1,$2,$3,'pro_40_hours','PRO','CANCELED',now(),now()-interval '1 day',true)",[sub,other,ctm]);
 await db.query("insert into public.customer_recurring_terms(transaction_id,user_id,subscription_id,grant_id,state,period_start,period_end,remaining_ms) values($1,$2,$3,$4,'PAUSED',now()-interval '2 days',now()-interval '1 day',3600000)",[txn,other,sub,grant]);
 expect((await adjust('REMOVE_MINUTES',{grantId:grant,minutes:1},randomUUID(),other)).code).toBe('APPLIED');
 await db.query('select public.customer_recurring_refresh($1,clock_timestamp())',[other]);
 const resumed=(await db.query<any>('select state,granted_ms from public.customer_usage_grants where id=$1',[grant])).rows[0];
 expect(resumed.state).toBe('ACTIVE');expect(Number(resumed.granted_ms)).toBe(0);
});
it('searches exact email/UUID, returns bounded details, catalog, trial and no raw auth session tokens',async()=>{
 const result=await call('account_admin_read_v2',[actor,session,null,`${customer}@example.invalid`,null,null]);expect(result.users.map((u:any)=>u.userId)).toEqual([customer]);expect(result.users[0].emailVerified).toBe(true);
 const detail=await call('account_admin_read_v2',[actor,session,customer]);expect(detail.trial.registered).toBe(true);expect(detail.grants.length).toBeLessThanOrEqual(100);expect(detail.catalog).toHaveLength(4);expect(JSON.stringify(detail)).not.toContain(customerSession);
 const empty=await call('account_admin_read_v2',[actor,session,null,'not-a-user',null,null]);expect(empty.users).toEqual([]);
});
it('catalog disable denies new checkout without changing existing intents or paid records',async()=>{
 const request=randomUUID();const initial=await call('customer_checkout_prepare',[customer,customerSession,request,'pro_3_hours']);expect(initial.code).toBe('CLAIMED');
 expect((await adjust('CATALOG',{code:'pro_3_hours',name:'SigmaPro 3 Hours',enabled:false,priority:10},randomUUID(),null)).code).toBe('APPLIED');
 expect((await call('customer_checkout_prepare',[customer,customerSession,randomUUID(),'pro_3_hours'])).code).toBe('UNAVAILABLE');
 expect((await call('customer_checkout_prepare',[customer,customerSession,request,'pro_3_hours'])).code).toBe('PENDING');
 expect((await adjust('CATALOG',{code:'pro_100',name:'Not offered',enabled:true,priority:10},randomUUID(),null)).code).toBe('NOT_FOUND');
});
it('new tables and RPCs are service-only with RLS, empty search paths and no callable internal checkout',async()=>{
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_table_privilege($1,'public.account_catalog_policy','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed).toBe(false);
 for(const name of ['account_admin_adjust','account_admin_read_v2','account_catalog_read']){
  const row=(await db.query<any>("select oid,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname=$1",[name])).rows[0];expect(row.prosecdef).toBe(true);expect(row.proconfig).toContain('search_path=""');
  for(const role of ['anon','authenticated'])expect((await db.query<any>("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,row.oid])).rows[0].allowed).toBe(false);
 }
 expect((await db.query<any>("select has_function_privilege('service_role','public.customer_checkout_prepare_core(uuid,uuid,uuid,text)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});
