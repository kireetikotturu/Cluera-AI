'use strict';
// Operator-only SQL preparation and redacted summaries. No network, keys,
// environment loading, DDL, application RPC invocation or migration execution.
const SOURCE_REF='dwqltsqumiwsxtkzdoaa',DESTINATION_REF='yhnqlfcgrmckhyjdxegg';
const SCHEMAS=['public','billing_private','cluera_billing_private','cluera_private'];
const APPLICATION_RELATIONS=[
 'public.customer_accounts','public.customer_trial_grants','public.customer_request_limits',
 'public.paddle_sandbox_events','public.paddle_sandbox_simulations','public.customer_checkout_intents',
 'public.customer_usage_grants','public.customer_usage_runs','public.customer_usage_windows','public.customer_usage_settlements',
 'public.customer_paddle_bindings','public.customer_pack_purchases','public.customer_pack_applications',
 'public.customer_billing_jobs','public.customer_billing_outbox','public.customer_recurring_subscriptions',
 'public.customer_recurring_terms','public.customer_recurring_applications','public.account_admin_profiles',
 'public.account_admin_audit','public.customer_workspace_profiles','public.customer_context_documents',
 'public.account_ai_models','public.account_catalog_policy','public.customer_context_operations',
 'public.account_releases','public.cluera_releases','billing_private.worker_config',
 'billing_private.checkout_recovery_audit','billing_private.payment_intents','billing_private.payment_events',
 'billing_private.payment_applications','billing_private.payment_diagnostics',
 ...['catalog_revisions','catalog_heads','plan_verifications','admin_audit','processing_owner','cutover_audit',
  'worker_nonces','intents','events','subscriptions','payments','terms','applications'].map(name=>'cluera_billing_private.'+name),
 'cluera_private.ai_providers','cluera_private.ai_provider_audit',
];
const PLATFORM_RELATIONS=['auth.users','auth.identities','auth.mfa_factors','auth.sessions',
 'storage.buckets','storage.objects','cron.job','supabase_migrations.schema_migrations'];
const KNOWN_RELATIONS=Object.freeze([...APPLICATION_RELATIONS,...PLATFORM_RELATIONS]);
const known=new Set(KNOWN_RELATIONS);
function project(ref){if(![SOURCE_REF,DESTINATION_REF].includes(ref))throw Error('Fixed Cluera project required.');return ref;}
const quote=value=>"'"+value.replaceAll("'","''")+"'";

/** Catalog names and definition DIGESTS only. Auth/storage data are not read here.
 * The requested ref labels the query; independent connector project selection
 * must establish identity. SQL cannot authenticate a supplied project label. */
function catalogSql(ref){
 project(ref);
 return `with scoped as (
 select c.oid,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,n.nspname
 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname in (${SCHEMAS.map(quote).join(',')}) and c.relkind in ('r','p')
), functions as (
 select p.*,n.nspname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 where n.nspname in (${SCHEMAS.map(quote).join(',')}) and p.prokind='f'
)
select jsonb_build_object(
 'schemaVersion',1,'projectRef',${quote(ref)},'checkedAt',clock_timestamp(),
 'schemas',coalesce((select jsonb_agg(nspname order by nspname) from pg_catalog.pg_namespace where nspname in (${SCHEMAS.map(quote).join(',')})),'[]'::jsonb),
 'relations',coalesce((select jsonb_agg(jsonb_build_object('schema',nspname,'name',relname,'kind',relkind,'rls',relrowsecurity,'forceRls',relforcerowsecurity,
  'columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
   'nullable',not a.attnotnull,'defaultPresent',a.atthasdef,'identity',a.attidentity,'generated',a.attgenerated) order by a.attnum),'[]'::jsonb)
   from pg_catalog.pg_attribute a where a.attrelid=s.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',c.conname,'kind',c.contype,'validated',c.convalidated,
   'deferrable',c.condeferrable,'definitionDigest',md5(pg_catalog.pg_get_constraintdef(c.oid))) order by c.conname),'[]'::jsonb)
   from pg_catalog.pg_constraint c where c.conrelid=s.oid),
  'indexes',(select coalesce(jsonb_agg(jsonb_build_object('name',i.relname,'unique',x.indisunique,'primary',x.indisprimary,
   'valid',x.indisvalid,'definitionDigest',md5(pg_catalog.pg_get_indexdef(x.indexrelid))) order by i.relname),'[]'::jsonb)
   from pg_catalog.pg_index x join pg_catalog.pg_class i on i.oid=x.indexrelid where x.indrelid=s.oid),
  'triggers',(select coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
   'definitionDigest',md5(pg_catalog.pg_get_triggerdef(t.oid))) order by t.tgname),'[]'::jsonb)
   from pg_catalog.pg_trigger t where t.tgrelid=s.oid and not t.tgisinternal),
  'grants',(select jsonb_object_agg(role_name,jsonb_build_object('select',has_table_privilege(role_name,s.oid,'SELECT'),
   'insert',has_table_privilege(role_name,s.oid,'INSERT'),'update',has_table_privilege(role_name,s.oid,'UPDATE'),
   'delete',has_table_privilege(role_name,s.oid,'DELETE'),'truncate',has_table_privilege(role_name,s.oid,'TRUNCATE')))
   from (values('anon'),('authenticated'),('service_role')) roles(role_name))) order by nspname,relname) from scoped s),'[]'::jsonb),
 'policies',coalesce((select jsonb_agg(jsonb_build_object('schema',s.nspname,'table',s.relname,'name',p.polname,
  'command',p.polcmd,'permissive',p.polpermissive,'roleCount',cardinality(p.polroles),
  'usingPresent',p.polqual is not null,'checkPresent',p.polwithcheck is not null) order by s.nspname,s.relname,p.polname)
  from pg_catalog.pg_policy p join scoped s on s.oid=p.polrelid),'[]'::jsonb),
 'functions',coalesce((select jsonb_agg(jsonb_build_object('schema',f.nspname,'name',f.proname,
  'arguments',pg_catalog.pg_get_function_identity_arguments(f.oid),'definer',f.prosecdef,
  'emptySearchPath',coalesce(f.proconfig @> array['search_path=""']::text[] or f.proconfig @> array['search_path=']::text[],false),
  'definitionDigest',md5(pg_catalog.pg_get_functiondef(f.oid)),
  'grants',jsonb_build_object('anon',has_function_privilege('anon',f.oid,'EXECUTE'),
   'authenticated',has_function_privilege('authenticated',f.oid,'EXECUTE'),'service_role',has_function_privilege('service_role',f.oid,'EXECUTE')))
  order by f.nspname,f.proname,pg_catalog.pg_get_function_identity_arguments(f.oid)) from functions f),'[]'::jsonb),
 'extensions',coalesce((select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname) order by e.extname)
  from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace),'[]'::jsonb),
 'knownRelations',coalesce((select jsonb_agg(jsonb_build_object('relation',v.name,'present',c.oid is not null,'kind',c.relkind) order by v.name)
  from (values ${KNOWN_RELATIONS.map(name=>'('+quote(name)+')').join(',')}) v(name)
  left join pg_catalog.pg_namespace n on n.nspname=split_part(v.name,'.',1)
  left join pg_catalog.pg_class c on c.relnamespace=n.oid and c.relname=split_part(v.name,'.',2)),'[]'::jsonb)
) inventory;`;
}
function validateCatalog(ref,catalog){
 project(ref);
 if(!catalog||catalog.schemaVersion!==1||catalog.projectRef!==ref||!Array.isArray(catalog.knownRelations)
  ||catalog.knownRelations.length>KNOWN_RELATIONS.length||!Array.isArray(catalog.relations)||catalog.relations.length>5000
  ||!Array.isArray(catalog.functions)||catalog.functions.length>10000||!Array.isArray(catalog.policies)
  ||!Array.isArray(catalog.extensions))throw Error('Verified catalog result required.');
 const seen=new Set();
 for(const row of catalog.knownRelations){
  if(!row||!known.has(row.relation)||seen.has(row.relation)||typeof row.present!=='boolean'
   ||(row.present&&!['r','p'].includes(row.kind)))throw Error('Known relation catalog mismatch.');
  seen.add(row.relation);
 }
 // Omissions cannot silently turn a partial/truncated query into an empty DB.
 if(seen.size!==KNOWN_RELATIONS.length)throw Error('Complete relation catalog required.');
 return new Set(catalog.knownRelations.filter(row=>row.present).map(row=>row.relation));
}

/** Prepare COUNTs only AFTER catalog presence checks. No dynamic identifiers,
 * missing-relation SQL, financial RPC, queue command or Auth row is read. */
function countsSql(ref,catalog){
 const present=validateCatalog(ref,catalog);
 const pairs=KNOWN_RELATIONS.filter(name=>present.has(name)).map(name=>`(${quote(name)},(select count(*) from ${name}))`);
 const counts=pairs.length?`(select jsonb_object_agg(relation,row_count) from (values ${pairs.join(',')}) c(relation,row_count))`:'jsonb_build_object()';
 return `select jsonb_build_object('schemaVersion',1,'projectRef',${quote(ref)},'checkedAt',clock_timestamp(),
 'counts',${counts}) inventory;`;
}
function summarize(ref,catalog,aggregate){
 try{
  const present=validateCatalog(ref,catalog),rowCount=Object.create(null);
  if(aggregate!==undefined){
   if(!aggregate||aggregate.schemaVersion!==1||aggregate.projectRef!==ref||!aggregate.counts||Array.isArray(aggregate.counts)
    ||Object.keys(aggregate.counts).length!==present.size)throw Error('Count result mismatch.');
   for(const [relation,value] of Object.entries(aggregate.counts)){
    if(!present.has(relation)||!Number.isSafeInteger(value)||value<0)throw Error('Count result mismatch.');
    rowCount[relation]=value;
   }
  }
  const tableRows=catalog.relations.filter(row=>row&&SCHEMAS.includes(row.schema)&&['r','p'].includes(row.kind));
  const f=catalog.functions.filter(row=>row&&SCHEMAS.includes(row.schema));
  const total=names=>names.every(name=>Object.hasOwn(rowCount,name))?names.reduce((n,name)=>n+rowCount[name],0):null;
  return {status:'inspected',project:ref===SOURCE_REF?'source':'destination',
   identityAssurance:'requires-independent-connector-project-check',inventoryOnly:true,backupVerified:false,securityApproval:false,
   applicationTables:tableRows.length,tablesWithoutRls:tableRows.filter(row=>row.rls!==true).length,
   browserCrudTables:tableRows.filter(row=>['anon','authenticated'].some(role=>Object.values(row.grants?.[role]??{}).some(value=>value===true))).length,
   functions:f.length,definerFunctions:f.filter(row=>row.definer===true).length,
   browserExecutableDefiners:f.filter(row=>row.definer===true&&(row.grants?.anon===true||row.grants?.authenticated===true)).length,
   definerWithoutEmptySearchPath:f.filter(row=>row.definer===true&&row.emptySearchPath!==true).length,
   policies:catalog.policies.length,extensions:catalog.extensions.length,knownRelationsPresent:present.size,
   countEvidence:aggregate===undefined?'not-collected':'collected',
   authUsers:total(['auth.users']),authIdentities:total(['auth.identities']),mfaFactors:total(['auth.mfa_factors']),
   authSessions:total(['auth.sessions']),storageBuckets:total(['storage.buckets']),storageObjects:total(['storage.objects']),
   schedulerJobs:total(['cron.job']),migrationRecords:total(['supabase_migrations.schema_migrations'])};
 }catch{return {status:'unavailable',inventoryOnly:true,backupVerified:false,securityApproval:false};}
}
module.exports={SOURCE_REF,DESTINATION_REF,KNOWN_RELATIONS,catalogSql,countsSql,summarize};
if(require.main===module){
 try{
  const [command,ref]=process.argv.slice(2);project(ref);
  if(command==='catalog-sql'&&process.argv.length===4)console.log(catalogSql(ref));
  else if(['counts-sql','summarize'].includes(command)&&process.argv.length===4){
   const bytes=require('node:fs').readFileSync(0);if(bytes.length>8*1024*1024)throw Error('Bounded input required.');
   const input=JSON.parse(bytes.toString('utf8'));
   if(command==='counts-sql')console.log(countsSql(ref,input));
   else console.log(JSON.stringify(summarize(ref,input.catalog,input.aggregate)));
  }else throw Error('Invalid command.');
 }catch{console.error('Cluera read-only inventory unavailable.');process.exitCode=1;}
}
