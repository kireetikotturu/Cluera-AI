import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterEach,expect,it} from 'vitest';
const {PROJECT,prepareOwnerBootstrap}=createRequire(import.meta.url)('../../scripts/admin/owner-bootstrap.cjs');
const target='00000000-0000-4000-8000-000000000001',operation='00000000-0000-4000-8000-000000000002';
async function createFixture(){
 const db=new PGlite();
 await db.exec(`set timezone='UTC';create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,created_at timestamptz default now(),deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean default false);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);`);
 await db.exec(readFileSync('../supabase/migrations/20261004024730_customer_account_foundation.sql','utf8'));
 const source=readFileSync('../supabase/migrations/20261004141346_account_workspace_controls.sql','utf8');
 await db.exec(source.slice(0,source.indexOf('create function public.customer_workspace')));
 await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'clueraaisupport@gmail.com',now());",[target]);
 await db.query('insert into public.customer_accounts(user_id) values($1)',[target]);
 await db.query('insert into public.customer_trial_grants(user_id) values($1)',[target]);
 const pinned=(await db.query<{digest:string}>(`select md5(jsonb_build_object('id',u.id,'email',u.email,'email_confirmed_at',u.email_confirmed_at,'created_at',u.created_at,'deleted_at',u.deleted_at,'banned_until',u.banned_until,'is_anonymous',u.is_anonymous,'account',to_jsonb(c))::text) digest from auth.users u join public.customer_accounts c on c.user_id=u.id where u.id=$1`,[target])).rows[0].digest;
 const input={projectRef:PROJECT,targetId:target,operationId:operation,identityDigest:pinned,evidenceAt:new Date().toISOString()};
 return {db,input,sql:prepareOwnerBootstrap(input)};
}
let currentFixture:Awaited<ReturnType<typeof createFixture>>|undefined;
async function fixture(){if(!currentFixture)throw Error('Synthetic bootstrap fixture unavailable.');return currentFixture;}
async function closeFixture(db:PGlite){if(currentFixture?.db===db)currentFixture=undefined;await db.close();}
async function rejectsAndRollsBack(db:PGlite,sql:string){await expect(db.exec(sql)).rejects.toThrow();await db.exec('rollback');expect((await db.query('select * from public.account_admin_profiles')).rows).toHaveLength(0);}
// Compile/start the WASM engine in setup, not inside the first 5s assertion.
// Each test still gets independent data, real migrations and its original bound.
beforeAll(async()=>{const warm=await createFixture();await warm.db.close();},60000);
beforeEach(async()=>{currentFixture=await createFixture();});
afterEach(async()=>{if(currentFixture)await closeFixture(currentFixture.db);});
it('grants only one audited role, truthfully records operator authority, preserves Auth/trial, and replays once',async()=>{
 const {db,input,sql}=await fixture();try{
  const existing='00000000-0000-4000-8000-000000000004',sid='00000000-0000-4000-8000-000000000005';
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'existing@example.invalid',now())",[existing]);
  await db.query('insert into public.account_admin_profiles(user_id) values($1)',[existing]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[sid,target]);
  const before=(await db.query('select to_jsonb(u) value from auth.users u')).rows;
  await db.exec(sql);await db.exec(prepareOwnerBootstrap(input));
  const profiles=(await db.query('select * from public.account_admin_profiles')).rows;expect(profiles).toHaveLength(2);
  const audits=(await db.query<any>('select * from public.account_admin_audit')).rows;expect(audits).toHaveLength(1);
  expect(audits[0].action).toBe('OWNER_AUTHORIZED_ADMIN_BOOTSTRAP');expect(audits[0].reason).toContain('not an authenticated grantor');
  expect(audits[0].detail).toMatchObject({before:null,noMfaClaim:true,noAuthenticatedSession:true,actorSemantics:'bootstrap_subject_not_authenticated_grantor',after:{user_id:target,active:true}});
  expect(audits[0].detail.scope).toBe('Clean independent Cluera project yhnqlfcgrmckhyjdxegg only; excludes old Account and License Edition');
  expect(audits[0].detail).toMatchObject({targetProjectRef:PROJECT,oldAuthorityImported:false});
  expect(audits[0].detail.authorization).toContain('October 16 2026');
  expect((await db.query('select to_jsonb(u) value from auth.users u')).rows).toEqual(before);
  expect((await db.query('select granted_seconds from public.customer_trial_grants')).rows).toEqual([{granted_seconds:900}]);
  expect((await db.query('select public.account_admin_check($1,null,true) allowed',[target])).rows[0]).toEqual({allowed:false});
  expect((await db.query('select public.account_admin_check($1,$2,true) allowed',[target,sid])).rows[0]).toEqual({allowed:false});
  expect((await db.query('select aal from auth.sessions where id=$1',[sid])).rows[0]).toEqual({aal:'aal1'});
  await expect(db.exec("update public.account_admin_audit set reason='tamper with bootstrap audit' where operation_id='"+operation+"' ")).rejects.toThrow('immutable');
 }finally{await closeFixture(db);}
});
it.each(["email_confirmed_at=null","deleted_at=now()","banned_until=now()+interval '1 hour'","is_anonymous=true","email='other@example.invalid'"])( 'refuses ineligible or changed identity (%s)',async change=>{
 const {db,sql}=await fixture();try{await db.exec('update auth.users set '+change);await rejectsAndRollsBack(db,sql);}finally{await closeFixture(db);}
});
it.each(['stale','future','digest','suspended','acl','audit','replica','unexpected-trigger'])('fails closed and never creates a role (%s)',async kind=>{
 const {db,input}=await fixture();try{
  if(kind==='stale')input.evidenceAt=new Date(Date.now()-121000).toISOString();
  if(kind==='future')input.evidenceAt=new Date(Date.now()+60000).toISOString();
  if(kind==='digest')input.identityDigest='0'.repeat(32);
  if(kind==='suspended')await db.exec("update public.customer_accounts set state='SUSPENDED'");
  if(kind==='acl')await db.exec('grant insert on public.account_admin_profiles to service_role');
  if(kind==='audit')await db.exec('alter table public.account_admin_audit disable trigger account_audit_immutable');
  if(kind==='replica')await db.exec("set session_replication_role='replica'");
  if(kind==='unexpected-trigger')await db.exec('create trigger synthetic_extra before insert on public.account_admin_profiles for each row execute function public.account_audit_immutable()');
  await rejectsAndRollsBack(db,prepareOwnerBootstrap(input));
 }finally{await closeFixture(db);}
});
it('rolls back the role on audit failure and rejects a changed-operation replay',async()=>{
 const {db,sql,input}=await fixture();try{
  await db.exec("alter table public.account_admin_audit add constraint synthetic_audit_failure check(action='never')");
  await rejectsAndRollsBack(db,sql);
  await db.exec('alter table public.account_admin_audit drop constraint synthetic_audit_failure');
  await db.exec(sql);
  await db.exec("alter table public.account_admin_audit disable trigger account_audit_immutable;update public.account_admin_audit set detail=detail-'actorSemantics';alter table public.account_admin_audit enable trigger account_audit_immutable;");
  await expect(db.exec(sql)).rejects.toThrow('replay conflict');await db.exec('rollback');
  await expect(db.exec(prepareOwnerBootstrap({...input,operationId:'00000000-0000-4000-8000-000000000003'}))).rejects.toThrow('already exists');await db.exec('rollback');
  expect((await db.query('select * from public.account_admin_audit')).rows).toHaveLength(1);
 }finally{await closeFixture(db);}
});
it('has no network executor, automatic MFA/session mutation, new function or schema capability',()=>{
 expect(()=>prepareOwnerBootstrap({projectRef:PROJECT,targetId:"';drop table auth.users;",operationId:operation,identityDigest:'0'.repeat(32),evidenceAt:new Date().toISOString()})).toThrow('Invalid');
 expect(()=>prepareOwnerBootstrap({projectRef:PROJECT,targetId:{toString:()=>target},operationId:operation,identityDigest:'0'.repeat(32),evidenceAt:new Date().toISOString()})).toThrow('Invalid');
 const text=readFileSync('../scripts/admin/owner-bootstrap.cjs','utf8');
 expect(text).not.toMatch(/create function|create table|update auth\.|insert into auth\.|https?:\/\/|fetch\(/i);
});
it('pins only the independent clean project and never prepares an old-project or unscoped grant',()=>{
 const input={projectRef:PROJECT,targetId:target,operationId:operation,identityDigest:'0'.repeat(32),evidenceAt:new Date().toISOString()};
 expect(PROJECT).toBe('yhnqlfcgrmckhyjdxegg');
 for(const projectRef of ['dwqltsqumiwsxtkzdoaa','bzccuqforilpifhiysjk','',null,undefined]){
  expect(()=>prepareOwnerBootstrap({...input,projectRef})).toThrow('Invalid bootstrap pins');
 }
 const {projectRef,...unscoped}=input;expect(()=>prepareOwnerBootstrap(unscoped)).toThrow('Invalid bootstrap pins');
 const sql=prepareOwnerBootstrap(input);
 expect(sql).toContain('Clean Cluera destination yhnqlfcgrmckhyjdxegg');
 expect(sql).not.toMatch(/Retained Account allowlist|shared by Cluera and temporary old Account|October 15 2026/);
});
