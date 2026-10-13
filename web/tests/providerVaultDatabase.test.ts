import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db:PGlite;const actor=randomUUID(),sid=randomUUID();
const history=['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations','20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle','20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls','20261008100006_account_admin_catalog_controls'];
const proposal=readFileSync('../docs/proposals/cluera-provider-vault.sql','utf8');
const replacement=()=>({credentialId:randomUUID(),sealed:{v:1,keyId:'synthetic-key',ciphertext:'synthetic-encrypted-only'}});
async function change(action:string,revision:number,input:object,op=randomUUID(),digest='a'.repeat(64),who=actor,reauth=new Date().toISOString(),provider='gemini'){
 return (await db.query<any>('select public.cluera_provider_mutate($1,$2,$3,$4,$5,$6,$7,$8,$9) value',[who,sid,op,provider,action,revision,digest,reauth,input])).rows[0].value;
}
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');for(const name of history)await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));await db.exec(proposal);await db.query('insert into auth.users values($1,$2,now())',[actor,'vault@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[sid,actor]);await db.query('insert into public.account_admin_profiles(user_id) values($1)',[actor]);},60000);
afterAll(async()=>db?.close());
it('denies non-admin, stale reauthentication, null fields and AAL1 without writes',async()=>{
 expect((await change('REPLACE',0,replacement(),randomUUID(),'a'.repeat(64),randomUUID())).code).toBe('FORBIDDEN');
 expect((await change('REPLACE',0,replacement(),randomUUID(),'a'.repeat(64),actor,'2020-01-01T00:00:00Z')).code).toBe('FORBIDDEN');
 await db.query("update auth.sessions set aal='aal1'");expect((await change('REPLACE',0,replacement())).code).toBe('FORBIDDEN');await db.query("update auth.sessions set aal='aal2'");
 expect((await db.query('select * from cluera_private.ai_providers')).rows).toHaveLength(0);
});
it('atomically stores encrypted disabled credentials and immutable metadata-only replay audit',async()=>{
 const op=randomUUID(),input=replacement();expect((await change('REPLACE',0,input,op)).code).toBe('APPLIED');expect((await change('REPLACE',0,input,op)).code).toBe('APPLIED');
 expect((await change('REPLACE',0,input,op,'b'.repeat(64))).code).toBe('CONFLICT');
 const audits=await db.query<any>('select * from cluera_private.ai_provider_audit');expect(audits.rows).toHaveLength(1);expect(JSON.stringify(audits.rows)).not.toContain('ciphertext');
 const meta=(await db.query<any>('select public.cluera_provider_admin_read($1,$2) value',[actor,sid])).rows[0].value;
 expect(meta.providers[0].enabled).toBe(false);expect(JSON.stringify(meta)).not.toContain('sealed');
});
it('rejects NULL operation discriminators explicitly without altering credentials or audits',async()=>{
 const before=(await db.query<any>('select revision from cluera_private.ai_providers')).rows;
 const count=(await db.query<any>('select count(*)::int n from cluera_private.ai_provider_audit')).rows[0].n;
 for(const [provider,action] of [[null,'REPLACE'],['gemini',null]]){
  const value=(await db.query<any>('select public.cluera_provider_mutate($1,$2,$3,$4,$5,1,$6,now(),$7) value',[actor,sid,randomUUID(),provider,action,'a'.repeat(64),replacement()])).rows[0].value;
  expect(value.code).toBe('INVALID');
 }
 expect((await db.query<any>('select revision from cluera_private.ai_providers')).rows).toEqual(before);
 expect((await db.query<any>('select count(*)::int n from cluera_private.ai_provider_audit')).rows[0].n).toBe(count);
});
it('requires fresh complete compatible probe before enable, fences stale revisions, and resets on replacement',async()=>{
 expect((await change('CONFIGURE',1,{enabled:true,defaultModel:'gemini-3.5-flash'})).code).toBe('INVALID');
 expect((await change('TEST',1,{status:'VERIFIED',models:[{id:'gemini-3.5-flash',runtimeCompatible:true}],complete:true})).code).toBe('APPLIED');
 expect((await change('CONFIGURE',1,{enabled:true,defaultModel:'gemini-3.5-flash'})).code).toBe('CONFLICT');
 expect((await change('CONFIGURE',2,{enabled:true,defaultModel:'gemini-3.5-flash'})).code).toBe('APPLIED');
 expect((await change('REPLACE',3,replacement())).code).toBe('APPLIED');
 const row=(await db.query<any>('select * from cluera_private.ai_providers')).rows[0];expect(row.enabled).toBe(false);expect(row.probe_status).toBe('UNVERIFIED');expect(row.default_model).toBeNull();
});
it('cannot enable OpenAI/Claude or write any financial table and rolls back if audit fails',async()=>{
 for(const provider of ['openai','anthropic']){
  expect((await change('REPLACE',0,replacement(),randomUUID(),'a'.repeat(64),actor,new Date().toISOString(),provider)).code).toBe('APPLIED');
  expect((await change('TEST',1,{status:'VERIFIED',models:[{id:'future-model',runtimeCompatible:true}],complete:true},randomUUID(),'a'.repeat(64),actor,new Date().toISOString(),provider)).code).toBe('APPLIED');
  expect((await change('CONFIGURE',2,{enabled:true,defaultModel:'future-model'},randomUUID(),'a'.repeat(64),actor,new Date().toISOString(),provider)).code).toBe('INVALID');
 }
 await db.exec("create function cluera_private.fail_audit() returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end$$;create trigger fail_audit before insert on cluera_private.ai_provider_audit for each row execute function cluera_private.fail_audit();");
 await expect(change('REPLACE',4,replacement())).rejects.toThrow('synthetic failure');expect((await db.query<any>("select revision from cluera_private.ai_providers where provider='gemini'")).rows[0].revision).toBe(4);
 await db.exec('drop trigger fail_audit on cluera_private.ai_provider_audit');
 expect(proposal).not.toMatch(/(?:update|insert into|delete from) public\.(?:account_|payment_|usage_)/i);
});
it('denies direct table CRUD/trigger execution and browser RPC execution with ALWAYS audit protection',async()=>{
 for(const table of ['ai_providers','ai_provider_audit']){
  expect((await db.query<any>(`select relrowsecurity from pg_class where oid='cluera_private.${table}'::regclass`)).rows[0].relrowsecurity).toBe(true);
  for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>('select has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE\') allowed',[role,`cluera_private.${table}`])).rows[0].allowed).toBe(false);
 }
 for(const fn of ['cluera_provider_admin_read','cluera_provider_read','cluera_provider_mutate']){
  const row=(await db.query<any>('select oid,prosecdef,proconfig from pg_proc where proname=$1',[fn])).rows[0];expect(row.prosecdef).toBe(true);expect(row.proconfig).toContain('search_path=""');
  for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>('select has_function_privilege($1,$2::oid,\'EXECUTE\') allowed',[role,row.oid])).rows[0].allowed).toBe(role==='service_role');
 }
 for(const statement of ['update cluera_private.ai_provider_audit set action=\'changed\'','delete from cluera_private.ai_provider_audit','truncate cluera_private.ai_provider_audit'])await expect(db.exec(statement)).rejects.toThrow('immutable');
 expect((await db.query<any>("select tgenabled from pg_trigger where tgname='ai_provider_audit_immutable'")).rows[0].tgenabled).toBe('A');
});
