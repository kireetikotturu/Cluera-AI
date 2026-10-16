'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SOURCE_REF,DESTINATION_REF,KNOWN_RELATIONS,catalogSql,countsSql,summarize}=require('../scripts/migrations/inspect-cluera-project.cjs');
const catalog=()=>({schemaVersion:1,projectRef:DESTINATION_REF,relations:[],functions:[],policies:[],extensions:[],
 knownRelations:KNOWN_RELATIONS.map(relation=>({relation,present:false,kind:null}))});
test('inventory prepares only fixed Cluera source/destination projects, not License or arbitrary targets',()=>{
 for(const ref of [SOURCE_REF,DESTINATION_REF])assert(catalogSql(ref).includes(ref));
 for(const ref of ['bzccuqforilpifhiysjk','https://foreign.invalid',DESTINATION_REF+"';drop table auth.users;--",null]){
  assert.throws(()=>catalogSql(ref),/Fixed Cluera project/);assert.throws(()=>countsSql(ref,catalog()));
 }
});
test('catalog SQL is read-only and returns definition digests, not function bodies, Auth rows or scheduler commands',()=>{
 const sql=catalogSql(DESTINATION_REF);
 assert(!/\b(create|alter|drop|insert|update|delete|truncate|copy|call|execute)\s+(table|schema|function|trigger|into|from|on|public\.)/i.test(sql));
 assert(!/vault\.|decrypted_secret|encrypted_password|raw_user_meta_data|password_hash|cron\.schedule|net\.http|pg_read_file|pg_ls_dir/i.test(sql));
 assert(sql.includes('md5(pg_catalog.pg_get_functiondef(f.oid))'));
 assert(!/\bselect\s+\*\s+from\s+(auth|storage|cron)\./i.test(sql));
 assert(sql.includes("'auth.users'")); // Presence metadata only.
});
test('an empty complete catalog produces counts SQL without references to absent tables',()=>{
 const sql=countsSql(DESTINATION_REF,catalog());assert(sql.includes("'counts',jsonb_build_object()"));
 for(const name of KNOWN_RELATIONS)assert(!sql.includes('from '+name));
});
test('only fixed present base tables are counted; no caller-selected relation or columns enter SQL',()=>{
 const c=catalog();for(const row of c.knownRelations)if(['auth.users','storage.objects','public.customer_accounts','cron.job'].includes(row.relation)){row.present=true;row.kind='r';}
 const sql=countsSql(DESTINATION_REF,c);
 for(const name of ['auth.users','storage.objects','public.customer_accounts','cron.job'])assert(sql.includes('(select count(*) from '+name+')'));
 assert(!sql.includes('from auth.identities'));assert(!sql.includes('command'));assert(!sql.includes('email'));
 c.knownRelations.push({relation:'public.customer_accounts; drop table auth.users',present:true,kind:'r'});
 assert.throws(()=>countsSql(DESTINATION_REF,c));
});
test('partial, duplicate, foreign-project and non-table catalogs fail closed before SQL preparation',()=>{
 const a=catalog();a.knownRelations.pop();assert.throws(()=>countsSql(DESTINATION_REF,a));
 const b=catalog();b.knownRelations[0]={...b.knownRelations[1]};assert.throws(()=>countsSql(DESTINATION_REF,b));
 const c=catalog();c.projectRef=SOURCE_REF;assert.throws(()=>countsSql(DESTINATION_REF,c));
 const d=catalog();d.knownRelations[0].present=true;d.knownRelations[0].kind='v';assert.throws(()=>countsSql(DESTINATION_REF,d));
});
test('redacted summary reports only fixed categories/counts, never arbitrary data, identities, errors or digests',()=>{
 const c=catalog();c.relations=[{schema:'public',name:'never-echo-customer-id',kind:'r',rls:true,grants:{anon:{select:false},authenticated:{select:false}}}];
 c.functions=[{schema:'public',name:'never-echo-function',definer:true,emptySearchPath:true,definitionDigest:'never-echo-digest',grants:{anon:false,authenticated:false}}];
 for(const row of c.knownRelations)if(row.relation==='auth.users'){row.present=true;row.kind='r';}
 const out=summarize(DESTINATION_REF,c,{schemaVersion:1,projectRef:DESTINATION_REF,counts:{'auth.users':7}});
 assert.equal(out.status,'inspected');assert.equal(out.authUsers,7);assert.equal(out.tablesWithoutRls,0);assert.equal(out.browserExecutableDefiners,0);
 assert.equal(out.backupVerified,false);assert.equal(out.securityApproval,false);assert.equal(out.identityAssurance,'requires-independent-connector-project-check');
 assert(!JSON.stringify(out).includes('never-echo'));assert(!JSON.stringify(out).includes(DESTINATION_REF));
});
test('summary does not convert missing/failed counts to zero, clearance, a backup or an empty destination',()=>{
 const c=catalog(),out=summarize(DESTINATION_REF,c);assert.equal(out.authUsers,null);assert.equal(out.schedulerJobs,null);assert.equal(out.countEvidence,'not-collected');
 for(const aggregate of [{},{schemaVersion:1,projectRef:SOURCE_REF,counts:{}},
  {schemaVersion:1,projectRef:DESTINATION_REF,counts:{'auth.users':0}},
  {schemaVersion:1,projectRef:DESTINATION_REF,counts:{'private-error':'private-body'}}])
  assert.deepEqual(summarize(DESTINATION_REF,c,aggregate),{status:'unavailable',inventoryOnly:true,backupVerified:false,securityApproval:false});
});
test('summary exposes unsafe base-table/definer metadata without inferring a security approval',()=>{
 const c=catalog();c.relations=[{schema:'public',kind:'r',rls:false,grants:{anon:{select:true}}}];
 c.functions=[{schema:'public',definer:true,emptySearchPath:false,grants:{authenticated:true}}];
 const out=summarize(DESTINATION_REF,c);assert.equal(out.tablesWithoutRls,1);assert.equal(out.browserCrudTables,1);
 assert.equal(out.browserExecutableDefiners,1);assert.equal(out.definerWithoutEmptySearchPath,1);assert.equal(out.securityApproval,false);
});
test('actual synthetic PostgreSQL catalog/counts preserve metadata-only boundaries and absent-table safety',async()=>{
 const {createRequire}=require('node:module'),path=require('node:path');
 const {PGlite}=createRequire(path.join(__dirname,'../web/package.json'))('@electric-sql/pglite');const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create schema storage;create schema cron;
   create table auth.users(id uuid primary key,encrypted_password text);create table auth.identities(user_id uuid,identity_data jsonb);
   create table storage.buckets(id text primary key);create table storage.objects(id uuid);create table cron.job(active boolean,command text);
   create table public.customer_accounts(user_id uuid primary key,state text not null default 'ACTIVE');
   alter table public.customer_accounts enable row level security;revoke all on public.customer_accounts from public,anon,authenticated,service_role;
   create function public.synthetic_private_body() returns text language sql security definer set search_path='' as $$select 'never-echo-function-body'::text$$;
   revoke all on function public.synthetic_private_body() from public,anon,authenticated;grant execute on function public.synthetic_private_body() to service_role;
   insert into auth.users values('00000000-0000-4000-8000-000000000001','never-echo-password-hash');
   insert into auth.identities values('00000000-0000-4000-8000-000000000001','{"private":"never-echo-identity-data"}');
   insert into public.customer_accounts(user_id) values('00000000-0000-4000-8000-000000000001');
   insert into cron.job values(true,'never-echo-scheduler-command');`);
  const c=(await db.query(catalogSql(DESTINATION_REF))).rows[0].inventory,text=JSON.stringify(c);
  assert(!text.includes('never-echo'));assert(!text.includes('00000000-0000-4000-8000-000000000001'));
  const definition=c.functions.find(f=>f.name==='synthetic_private_body');assert.equal(definition.definer,true);assert.equal(definition.emptySearchPath,true);
  assert.match(definition.definitionDigest,/^[a-f0-9]{32}$/);assert.equal(definition.grants.anon,false);
  assert.equal(c.knownRelations.find(row=>row.relation==='cluera_billing_private.events').present,false);
  const a=(await db.query(countsSql(DESTINATION_REF,c))).rows[0].inventory;
  assert.deepEqual(a.counts,{'auth.users':1,'auth.identities':1,'storage.buckets':0,'storage.objects':0,'cron.job':1,'public.customer_accounts':1});
  const out=summarize(DESTINATION_REF,c,a);assert.equal(out.status,'inspected');assert.equal(out.authUsers,1);assert.equal(out.authIdentities,1);assert.equal(out.schedulerJobs,1);
  assert.equal(out.mfaFactors,null);assert.equal(out.backupVerified,false);assert.equal(out.securityApproval,false);
 }finally{await db.close();}
});
