import {readFileSync} from 'node:fs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterEach,afterAll,it,expect} from 'vitest';
import {vaultKeyring} from '../lib/aiProviders/vault';

const {prepare,TARGET}=createRequire(import.meta.url)('../../scripts/migrations/prepare-cluera-clean-bootstrap.cjs');
const proposal=readFileSync('../docs/proposals/cluera-provider-vault.sql','utf8');
const prepared=prepare();
const owner=randomUUID(),session=randomUUID(),aal1=randomUUID(),expired=randomUUID();
const customer=randomUUID(),customerSession=randomUUID(),unverified=randomUUID(),unverifiedSession=randomUUID();
const tables=['public.customer_accounts','public.customer_trial_grants','public.customer_usage_grants',
  'public.account_admin_profiles','public.account_admin_audit','public.cluera_releases',
  'cluera_private.ai_providers','cluera_private.ai_provider_audit'];
let db:PGlite,pristine:Record<string,number>;
const count=async(table:string)=>(await db.query<{n:number}>(`select count(*)::int n from ${table}`)).rows[0].n;
const fresh=()=>new Date().toISOString();
const synthetic=()=>({credentialId:randomUUID(),sealed:{v:1,keyId:'synthetic-only',ciphertext:'synthetic-envelope'}});
async function mutate(action:string,revision:number,input:object,options:{provider?:string;operation?:string;digest?:string;actor?:string;sid?:string;at?:string}={}){
  return (await db.query<any>('select public.cluera_provider_mutate($1,$2,$3,$4,$5,$6,$7,$8,$9) value',[
    options.actor??owner,options.sid??session,options.operation??randomUUID(),options.provider??'gemini',action,revision,
    options.digest??'a'.repeat(64),options.at??fresh(),input,
  ])).rows[0].value;
}
const draft=(version='1.0.3')=>({version,minimumSupportedVersion:'1.0.0',
  downloadUrl:`https://github.com/synthetic/release-test/releases/download/cluera-test/ClueraAITestSetup-${version}.exe`,
  sha256:'a'.repeat(64),fileSizeBytes:123,updateType:'OPTIONAL',releaseNotes:'Synthetic clean-project acceptance only'});
async function release(action:string,input:object={},options:{actor?:string;sid?:string;operation?:string}={}){
  return (await db.query<any>('select public.cluera_release_admin($1,$2,$3,$4,$5,$6) value',[
    options.actor??owner,options.sid??session,action,options.operation??randomUUID(),'Synthetic clean Cluera release review',input,
  ])).rows[0].value;
}
async function denied(statement:string){
  await db.exec('savepoint expected_denial');
  await expect(db.exec(statement)).rejects.toThrow();
  await db.exec('rollback to savepoint expected_denial;release savepoint expected_denial');
}

beforeAll(async()=>{
  db=new PGlite();await db.waitReady;
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table auth.identities(user_id uuid);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);`);
  await db.exec(prepared.sql);await db.exec(proposal);
  pristine={};for(const table of tables)pristine[table]=await count(table);
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now()),($5,$6,null)',[
    owner,'clean-owner@example.invalid',customer,'clean-customer@example.invalid',unverified,'unverified@example.invalid',
  ]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2'),($3,$2,null,'aal1'),($4,$2,now()-interval '1 minute','aal2'),($5,$6,null,'aal2'),($7,$8,null,'aal2')",[
    session,owner,aal1,expired,customerSession,customer,unverifiedSession,unverified,
  ]);
  await db.query('insert into public.account_admin_profiles(user_id) values($1),($2)',[owner,unverified]);
},60000);
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});
afterAll(async()=>{await db?.close();});

it('uses exact frozen vault and generated clean foundation, without imported identities/roles/credentials or release approval',async()=>{
  expect(TARGET).toBe('yhnqlfcgrmckhyjdxegg');
  expect(createHash('sha256').update(proposal).digest('hex')).toBe('72e1fdf4b02924ffc35af19fe3392749b024e9d948e5d00c7ca13f104f294cf9');
  expect(readFileSync('../docs/proposals/cluera-clean-foundation.sql','utf8')).toBe(prepared.sql);
  expect(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8')).toBe(prepared.sql);
  expect(readFileSync('../supabase/migrations/20261016015041_cluera_clean_provider_vault.sql','utf8')).toBe(proposal);
  for(const table of tables)expect(pristine[table]).toBe(0);
  expect((await db.query<any>('select public.cluera_release_latest() value')).rows[0].value).toBeNull();
  expect((await db.query<any>('select public.cluera_provider_read($1) value',['gemini'])).rows[0].value).toBeNull();
  expect(await count('public.customer_usage_grants')).toBe(0);
});

it('requires a destination verified explicit Admin with a current live AAL2 session for vault and releases',async()=>{
  for(const [actor,sid] of [[customer,customerSession],[unverified,unverifiedSession],[owner,aal1],[owner,expired],[owner,randomUUID()],[randomUUID(),session]]){
    expect((await mutate('REPLACE',0,synthetic(),{actor,sid})).code).toBe('FORBIDDEN');
    expect((await release('DRAFT',draft(),{actor,sid})).code).toBe('FORBIDDEN');
    expect((await db.query<any>('select public.cluera_provider_admin_read($1,$2) value',[actor,sid])).rows[0].value.code).toBe('FORBIDDEN');
  }
  expect(await count('cluera_private.ai_providers')).toBe(0);expect(await count('public.cluera_releases')).toBe(0);
});

it('stores only a disabled encrypted record and opens it after canonical UUID database read-back',async()=>{
  const credentialId=randomUUID(),value='synthetic-provider-only-'+randomUUID();
  const keyring=vaultKeyring({CLUERA_PROVIDER_VAULT_KEYRING_BASE64:Buffer.from(JSON.stringify({active:'clean-test',keys:{'clean-test':randomBytes(32).toString('base64')}})).toString('base64')});
  const sealed=keyring.seal(value,{provider:'gemini',credentialId:credentialId.toUpperCase()});
  expect((await mutate('REPLACE',0,{credentialId,sealed})).code).toBe('APPLIED');
  const row=(await db.query<any>('select public.cluera_provider_read($1) value',['gemini'])).rows[0].value;
  expect(row).toMatchObject({credential_id:credentialId,enabled:false,probe_status:'UNVERIFIED',default_model:null});
  expect(keyring.open(row.sealed,{provider:'gemini',credentialId:row.credential_id})).toBe(value);
  const metadata=(await db.query<any>('select public.cluera_provider_admin_read($1,$2) value',[owner,session])).rows[0].value;
  const audit=(await db.query<any>('select before_metadata,after_metadata from cluera_private.ai_provider_audit')).rows;
  for(const output of [metadata,audit]){expect(JSON.stringify(output)).not.toContain(value);expect(JSON.stringify(output)).not.toMatch(/sealed|ciphertext|wrappedKey/);}
  expect(await count('public.customer_usage_grants')).toBe(0);expect(await count('public.customer_trial_grants')).toBe(0);
});

it('enforces fresh step-up, revision and exact operation replay without duplicate audit entries',async()=>{
  const input=synthetic(),operation=randomUUID();
  for(const at of ['2020-01-01T00:00:00.000Z',new Date(Date.now()+60000).toISOString()]){
    expect((await mutate('REPLACE',0,input,{at})).code).toBe('FORBIDDEN');
  }
  expect((await mutate('REPLACE',0,input,{operation})).code).toBe('APPLIED');
  expect((await mutate('REPLACE',0,input,{operation})).code).toBe('APPLIED');
  expect((await mutate('REPLACE',0,input,{operation,digest:'b'.repeat(64)})).code).toBe('CONFLICT');
  expect((await mutate('REPLACE',0,synthetic())).code).toBe('CONFLICT');
  expect(await count('cluera_private.ai_provider_audit')).toBe(1);
});

it.each(['gemini','deepgram'])('requires a fresh complete compatible probe for %s and replacement invalidates approval',async provider=>{
  const opts={provider},model='synthetic-compatible-model';
  expect((await mutate('REPLACE',0,synthetic(),opts)).code).toBe('APPLIED');
  expect((await mutate('CONFIGURE',1,{enabled:true,defaultModel:model},opts)).code).toBe('INVALID');
  expect((await mutate('TEST',1,{status:'VERIFIED',models:[{id:model,runtimeCompatible:true}],complete:true},opts)).code).toBe('APPLIED');
  expect((await mutate('CONFIGURE',2,{enabled:true,defaultModel:model},opts)).code).toBe('APPLIED');
  expect((await mutate('REPLACE',3,synthetic(),opts)).code).toBe('APPLIED');
  const row=(await db.query<any>('select public.cluera_provider_read($1) value',[provider])).rows[0].value;
  expect(row).toMatchObject({enabled:false,probe_status:'UNVERIFIED',default_model:null,complete:false});
  expect(await count('public.customer_usage_grants')).toBe(0);
});

it.each(['openai','anthropic'])('cannot enable unimplemented %s generation even with synthetic verified metadata',async provider=>{
  const opts={provider},model='synthetic-future-model';
  expect((await mutate('REPLACE',0,synthetic(),opts)).code).toBe('APPLIED');
  expect((await mutate('TEST',1,{status:'VERIFIED',models:[{id:model,runtimeCompatible:true}],complete:true},opts)).code).toBe('APPLIED');
  expect((await mutate('CONFIGURE',2,{enabled:true,defaultModel:model},opts)).code).toBe('INVALID');
  expect((await db.query<any>('select public.cluera_provider_read($1) value',[provider])).rows[0].value.enabled).toBe(false);
});

it('keeps private vault/release tables denied directly and RPCs service-only with fixed search paths',async()=>{
  for(const table of ['cluera_private.ai_providers','cluera_private.ai_provider_audit','public.cluera_releases']){
    expect((await db.query<any>('select relrowsecurity from pg_class where oid=$1::regclass',[table])).rows[0].relrowsecurity).toBe(true);
    expect((await db.query<any>('select count(*)::int n from pg_policy where polrelid=$1::regclass',[table])).rows[0].n).toBe(0);
    for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed",[role,table])).rows[0].allowed).toBe(false);
  }
  for(const name of ['cluera_provider_admin_read','cluera_provider_read','cluera_provider_mutate','cluera_release_latest','cluera_release_admin']){
    const fn=(await db.query<any>('select oid,prosecdef,proconfig from pg_proc where proname=$1',[name])).rows[0];
    expect(fn.prosecdef).toBe(true);expect(fn.proconfig).toContain('search_path=""');
    for(const role of ['anon','authenticated','service_role'])expect((await db.query<any>("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,fn.oid])).rows[0].allowed).toBe(role==='service_role');
  }
});

it('keeps provider audits immutable even in replica mode and rolls back mutation if audit insertion fails',async()=>{
  expect((await mutate('REPLACE',0,synthetic())).code).toBe('APPLIED');
  expect((await db.query<any>("select tgenabled from pg_trigger where tgname='ai_provider_audit_immutable'")).rows[0].tgenabled).toBe('A');
  await db.exec("set local session_replication_role='replica'");
  for(const statement of ["update cluera_private.ai_provider_audit set action='changed'",'delete from cluera_private.ai_provider_audit','truncate cluera_private.ai_provider_audit'])await denied(statement);
  await db.exec("set local session_replication_role='origin';alter table cluera_private.ai_provider_audit add constraint synthetic_failure check(action='NEVER') not valid");
  await db.exec('savepoint audit_failure');await expect(mutate('REPLACE',1,synthetic())).rejects.toThrow();
  await db.exec('rollback to savepoint audit_failure;release savepoint audit_failure');
  expect((await db.query<any>("select revision from cluera_private.ai_providers where provider='gemini'")).rows[0].revision).toBe(1);
  expect(await count('cluera_private.ai_provider_audit')).toBe(1);
});

it('starts release feed empty and requires exact independently verified Cluera bytes before explicit publication',async()=>{
  const operation=randomUUID();
  for(const filename of ['SigmaRoundSetup','SigmaRoundAccountTestSetup'])expect((await release('DRAFT',{...draft(),downloadUrl:draft().downloadUrl.replace('ClueraAITestSetup',filename)})).code).toBe('INVALID');
  expect((await release('DRAFT',draft(),{operation})).code).toBe('APPLIED');
  expect((await release('DRAFT',draft(),{operation})).code).toBe('APPLIED');
  expect((await db.query<any>('select public.cluera_release_latest() value')).rows[0].value).toBeNull();
  const approval={id:operation,verifiedHostedSha256:'a'.repeat(64),verifiedFileSizeBytes:123,confirmedAccountInstaller:true};
  expect((await release('PUBLISH',{...approval,verifiedHostedSha256:'b'.repeat(64)})).code).toBe('INVALID');
  expect((await release('PUBLISH',{...approval,confirmedAccountInstaller:false})).code).toBe('INVALID');
  expect((await release('PUBLISH',approval)).code).toBe('APPLIED');
  expect((await db.query<any>('select public.cluera_release_latest() value')).rows[0].value.version).toBe('1.0.3');
  expect(await count('public.customer_usage_grants')).toBe(0);expect(await count('public.customer_trial_grants')).toBe(0);
});
