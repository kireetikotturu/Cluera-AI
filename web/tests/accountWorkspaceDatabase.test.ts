import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db:PGlite;
const actor=randomUUID(),customer=randomUUID(),other=randomUUID(),session=randomUUID(),customerSession=randomUUID(),otherSession=randomUUID();
async function call(name:string,args:unknown[]){return (await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;}
beforeAll(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 for(const migration of ['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations',
 '20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle',
 '20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls','20261008100014_account_context_sync'])await db.exec(readFileSync(`../supabase/migrations/${migration}.sql`,'utf8'));
 for(const [id,sid] of [[actor,session],[customer,customerSession],[other,otherSession]]){
  await db.query('insert into auth.users values($1,$2,now())',[id,`${id}@example.invalid`]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[sid,id]);await call('customer_authorize',[id,sid]);
 }
},60000);
afterAll(async()=>db?.close());
it('does not bootstrap an admin and requires verified allowlist plus AAL2',async()=>{
 expect(await call('account_admin_check',[actor,session,true])).toBe(false);
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[actor]);
 expect(await call('account_admin_check',[actor,session,false])).toBe(true);expect(await call('account_admin_check',[actor,session,true])).toBe(false);
 await db.query("update auth.sessions set aal='aal2' where id=$1",[session]);expect(await call('account_admin_check',[actor,session,true])).toBe(true);
 expect(await call('account_admin_check',[customer,session,true])).toBe(false);
});
it('keeps context owned and bounded and never returns another account documents',async()=>{
 const id=randomUUID();const doc={id,kind:'RESUME',name:'CV',body:'Synthetic resume only'};
 expect((await call('customer_workspace',[customer,customerSession,'SAVE_CONTEXT',doc])).documents).toHaveLength(1);
 expect((await call('customer_workspace',[other,otherSession,'READ',{}])).documents).toHaveLength(0);
 expect((await call('customer_workspace',[other,otherSession,'SAVE_CONTEXT',doc])).code).toBe('FORBIDDEN');
 expect((await call('customer_workspace',[customer,otherSession,'READ',{}])).code).toBe('UNAUTHENTICATED');
 expect((await call('customer_workspace',[customer,customerSession,'SAVE_CONTEXT',{...doc,body:'x'.repeat(120001)}])).code).toBe('INVALID');
});
it('grants only audited, idempotent test time; revoke stops its outstanding reservation',async()=>{
 const operation=randomUUID();const args=[actor,session,operation,customer,'GRANT_TEST','Controlled disposable staging acceptance',{minutes:60,environment:'account-staging'}];
 expect((await call('account_admin_mutate',args)).code).toBe('APPLIED');expect((await call('account_admin_mutate',args)).code).toBe('APPLIED');
 expect((await call('account_admin_mutate',[...args.slice(0,6),{minutes:61,environment:'account-staging'}])).code).toBe('CONFLICT');
 const grant=(await db.query<any>("select * from public.customer_usage_grants where source_key=$1",['admin-test:'+operation])).rows[0];
 expect(Number(grant.granted_ms)).toBe(3600000);const run=randomUUID();
 expect((await call('customer_usage_command',[customer,customerSession,run,0,'START'])).allocation).toBe('RECURRING');
 expect((await call('account_admin_mutate',[actor,session,randomUUID(),customer,'REVOKE_TEST','Acceptance is complete, removing test access',{grantId:grant.id}])).code).toBe('APPLIED');
 expect((await call('customer_usage_command',[customer,customerSession,run,1,'CHECKPOINT'])).code).toBe('DENIED');
 expect((await db.query('select * from public.account_admin_audit where operation_id=$1',[operation])).rows).toHaveLength(1);
 await expect(db.exec('update public.account_admin_audit set reason=reason')).rejects.toThrow('immutable');
 await expect(db.exec('delete from public.account_admin_audit')).rejects.toThrow('immutable');
});
it('suspends account and outstanding work without resetting its trial or deleting history',async()=>{
 const run=randomUUID();await call('customer_usage_command',[other,otherSession,run,0,'START']);
 expect((await call('account_admin_mutate',[actor,session,randomUUID(),other,'SUSPEND','Synthetic suspension acceptance',{}])).code).toBe('APPLIED');
 expect((await call('customer_usage_command',[other,otherSession,run,1,'CHECKPOINT'])).code).toBe('SUSPENDED');
 expect((await call('account_admin_mutate',[actor,session,randomUUID(),other,'REACTIVATE','Synthetic reactivation acceptance',{}])).code).toBe('APPLIED');
 expect((await db.query('select * from public.customer_trial_grants where user_id=$1',[other])).rows).toHaveLength(1);
});
it('protects roles and default routing; no browser direct access or audit mutation privileges',async()=>{
 expect((await call('account_models_read',[])).map((model:any)=>model.modelId).sort()).toEqual(['flux-general-en','gemini-3.5-flash']);
 for(const table of ['account_admin_profiles','account_admin_audit','customer_workspace_profiles','customer_context_documents','account_ai_models']){
  for(const role of ['anon','authenticated','service_role'])expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed",[role,'public.'+table])).rows[0].allowed).toBe(false);
  expect((await db.query<{enabled:boolean}>('select relrowsecurity enabled from pg_class where oid=$1::regclass',['public.'+table])).rows[0].enabled).toBe(true);
 }
 expect((await call('account_admin_mutate',[actor,session,randomUUID(),customer,'GRANT_TEST','short',{minutes:20}])).code).toBe('INVALID');
 for(const input of [{minutes:20},{minutes:20,environment:'production'}]){
  expect((await call('account_admin_mutate',[actor,session,randomUUID(),customer,'GRANT_TEST','Reject non-staging test grants',input])).code).toBe('INVALID');
 }
});
it('synchronizes owned context with replay-safe updates, deletion and no cross-account reads',async()=>{
 const id=randomUUID(),operationId=randomUUID();const input={action:'SAVE',id,operationId,name:'Context',kind:'SUPPORTING',body:'Private synthetic reference'};
 const invoke=(user:string,sid:string,input:object)=>call('customer_context_command',[user,sid,input]);
 expect((await invoke(customer,customerSession,input)).code).toBe('ACTIVE');
 expect((await invoke(customer,customerSession,input)).documents.filter((doc:any)=>doc.id===id)).toHaveLength(1);
 expect((await invoke(customer,customerSession,{...input,body:'Different retry'})).code).toBe('CONFLICT');
 expect((await invoke(other,otherSession,{action:'READ',ids:[id]})).documents).toEqual([]);
 expect((await invoke(other,otherSession,input)).code).toBe('FORBIDDEN');
 expect((await invoke(customer,otherSession,{action:'READ',ids:[id]})).code).toBe('UNAUTHENTICATED');
 expect((await invoke(customer,customerSession,{action:'LIST'})).documents.find((doc:any)=>doc.id===id).body).toBeUndefined();
 expect((await invoke(customer,customerSession,{action:'READ',ids:[id]})).documents[0].body).toBe(input.body);
 await invoke(customer,customerSession,{...input,operationId:randomUUID(),body:'Updated context'});
 expect((await invoke(customer,customerSession,{action:'READ',ids:[id]})).documents[0].body).toBe('Updated context');
 const remove={action:'DELETE',id,operationId:randomUUID()};await invoke(customer,customerSession,remove);await invoke(customer,customerSession,remove);
 expect((await invoke(customer,customerSession,input)).documents.find((doc:any)=>doc.id===id)).toBeUndefined();
 expect((await invoke(customer,customerSession,{action:'READ',ids:[id]})).documents).toEqual([]);
 const journal=(await db.query<any>('select * from public.customer_context_operations where operation_id=$1',[operationId])).rows;
 expect(journal).toHaveLength(1);expect(JSON.stringify(journal)).not.toContain(input.body);
});
it('bounds selected context and retains service-only function and journal privileges',async()=>{
 for(const input of [{action:'READ',ids:Array(9).fill(customer)},{action:'SAVE',id:randomUUID(),operationId:randomUUID(),kind:'RESUME',name:'Too big',body:'é'.repeat(60001)}]){
  expect((await call('customer_context_command',[customer,customerSession,input])).code).toBe('INVALID');
 }
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'public.customer_context_operations','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed).toBe(false);
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'public.customer_context_command(uuid,uuid,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(role==='service_role');
 const routine=(await db.query<any>("select prosecdef,proconfig from pg_proc where oid='public.customer_context_command(uuid,uuid,jsonb)'::regprocedure")).rows[0];
 expect(routine.prosecdef).toBe(true);expect(routine.proconfig).toContain('search_path=""');
});
