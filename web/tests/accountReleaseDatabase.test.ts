import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db:PGlite;const actor=randomUUID(),sid=randomUUID();
const history=['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox','20261004064105_shared_usage_reservations','20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle','20261004081416_sandbox_refund_schedule_boundaries','20261004141346_account_workspace_controls','20261008100006_account_admin_catalog_controls','20261009012641_account_release_distribution'];
async function call(action:string,input:object={},op=randomUUID(),who=actor,reason='Synthetic account release review'){return (await db.query<any>('select public.cluera_release_admin($1,$2,$3,$4,$5,$6) value',[who,sid,action,op,reason,input])).rows[0].value;}
const draft=(version='1.0.8')=>({version,minimumSupportedVersion:'1.0.0',downloadUrl:`https://github.com/test/releases/releases/download/account-test/ClueraAITestSetup-${version}.exe`,sha256:'a'.repeat(64),fileSizeBytes:123,updateType:'OPTIONAL',releaseNotes:'Synthetic test'});
const approval=(id:string)=>({id,verifiedHostedSha256:'a'.repeat(64),verifiedFileSizeBytes:123,confirmedAccountInstaller:true});
const migration=readFileSync('../supabase/migrations/20261013021137_cluera_release_distribution.sql','utf8');
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');for(const m of history)await db.exec(readFileSync(`../supabase/migrations/${m}.sql`,'utf8'));await db.exec(migration);await db.query('insert into auth.users values($1,$2,now())',[actor,'release@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[sid,actor]);await db.query('insert into public.account_admin_profiles(user_id) values($1)',[actor]);},60000);
afterAll(async()=>db?.close());
it('keeps the original release registry/function untouched and rejects both old product filenames',async()=>{
 const prior=await db.query('select * from public.account_releases');
 for(const name of ['SigmaRoundSetup','SigmaRoundAccountTestSetup'])expect((await call('DRAFT',{...draft(),downloadUrl:draft().downloadUrl.replace('ClueraAITestSetup',name)})).code).toBe('INVALID');
 await db.exec('begin');expect((await call('DRAFT',draft())).code).toBe('APPLIED');await db.exec('rollback');
 expect((await db.query('select * from public.account_releases')).rows).toEqual(prior.rows);
 expect((await db.query<any>("select has_function_privilege('service_role','public.account_release_latest()','EXECUTE') allowed")).rows[0].allowed).toBe(true);
});
it('denies non-admin, AAL1 and missing reason without inserting',async()=>{
 expect((await call('DRAFT',draft(),randomUUID(),randomUUID())).code).toBe('FORBIDDEN');
 await db.query("update auth.sessions set aal='aal1'");expect((await call('DRAFT',draft())).code).toBe('FORBIDDEN');await db.query("update auth.sessions set aal='aal2'");
 expect((await call('DRAFT',draft(),randomUUID(),actor,'')).code).toBe('INVALID');
 expect((await db.query('select * from public.cluera_releases')).rows).toHaveLength(0);
});
it('requires immutable exact metadata, rejects legacy/invalid inputs and never duplicates versions',async()=>{
 for(const patch of [{sha256:null},{fileSizeBytes:1.1},{releaseNotes:null},{downloadUrl:draft().downloadUrl.replace('ClueraAITest','SigmaRound')},{minimumSupportedVersion:'9.0.0'}])expect((await call('DRAFT',{...draft(),...patch})).code).toBe('INVALID');
 const op=randomUUID();expect((await call('DRAFT',draft(),op)).code).toBe('APPLIED');expect((await call('DRAFT',draft(),op)).code).toBe('APPLIED');expect((await call('DRAFT',{...draft(),releaseNotes:'changed'},op)).code).toBe('CONFLICT');expect((await call('DRAFT',draft())).code).toBe('CONFLICT');
 expect((await db.query('select public.cluera_release_latest() value')).rows[0]).toEqual({value:null});
});
it('publishes with explicit verification, audits replay once, withdraws and rejects downgrades',async()=>{
 const id=(await db.query<any>('select id from public.cluera_releases')).rows[0].id;
 expect((await call('PUBLISH',{...approval(id),verifiedHostedSha256:'b'.repeat(64)})).code).toBe('INVALID');
 expect((await call('PUBLISH',{...approval(id),confirmedAccountInstaller:false})).code).toBe('INVALID');
 const op=randomUUID();expect((await call('PUBLISH',approval(id),op)).code).toBe('APPLIED');expect((await call('PUBLISH',approval(id),op)).code).toBe('APPLIED');
 expect((await db.query<any>('select public.cluera_release_latest() value')).rows[0].value.version).toBe('1.0.8');
 expect((await db.query('select * from public.account_admin_audit where operation_id=$1',[op])).rows).toHaveLength(1);
 expect((await call('WITHDRAW',{id})).code).toBe('APPLIED');expect((await db.query<any>('select public.cluera_release_latest() value')).rows[0].value).toBeNull();
 const older=randomUUID();await call('DRAFT',draft('1.0.7'),older);expect((await call('PUBLISH',approval(older))).code).toBe('CONFLICT');
 await expect(db.exec('delete from public.account_admin_audit')).rejects.toThrow('immutable');
});
it('uses RLS and service-only definer functions with empty search paths',async()=>{
 expect((await db.query<any>("select relrowsecurity from pg_class where oid='public.cluera_releases'::regclass")).rows[0].relrowsecurity).toBe(true);
 for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_table_privilege($1,'public.cluera_releases','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed).toBe(false);
 for(const name of ['cluera_release_latest','cluera_release_admin']){const f=(await db.query<any>('select oid,prosecdef,proconfig from pg_proc where proname=$1',[name])).rows[0];expect(f.prosecdef).toBe(true);expect(f.proconfig).toContain('search_path=""');for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,f.oid])).rows[0].allowed).toBe(role==='service_role');}
});
