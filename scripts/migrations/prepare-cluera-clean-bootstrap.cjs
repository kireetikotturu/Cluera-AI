'use strict';
// Fixed clean-target SQL preparer. No connection, environment/credential import,
// provider call, migration execution, old project read or website switch.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),TARGET='yhnqlfcgrmckhyjdxegg';
const SOURCES=Object.freeze([
 ['20261004024730_customer_account_foundation','65baaf42f3f7389641d5cde6ec7d80fc5bac5b9ac2a51ab696b33b5ae96b4c23'],
 ['20261004025407_paddle_sandbox_inbox','726ffc2033d7881ec33d1e1dd251a0c2e46b78b5492a22a7bf68e64779230ea5'],
 ['20261004061853_paddle_simulation_receipts','9ab2afa2061ec325576320a1198a58c87924c457ba705a55dfd0718512c43f99'],
 ['20261004064105_shared_usage_reservations','1c571042be638c57624087458c309be6846705fb25ac333aff1d9a0e6d7eb8c9'],
 ['20261004070733_sandbox_checkout_intents','1c2e26897fcf53f8a9633b2f2ddd4ac4e6aff483969f62b296746d1c559c6e1f'],
 ['20261004072754_sandbox_pack_allowances','89b79a7a4480ee1affd23a3007dff5b0794111b8c45a4323bb00dddf45956a89'],
 ['20261004081006_sandbox_billing_jobs','91a238988c093dbed9894486342a05000322184855dc0ecc6544a712a6a9795b'],
 ['20261004081025_sandbox_recurring_lifecycle','22aa46dc906a34c0dcb0b3cc28639963e2185146f033bcbaed3814e0d71b21a7'],
 ['20261004081416_sandbox_refund_schedule_boundaries','8aa2020c179fc49bc597ae036c959ef1e3cda622197b25c5cb5d0ae92083790b'],
 ['20261004093908_checkout_recovery_audit','1e11028a578e2592e43348c4f4108d2afbc26f8bf0a9ea2ddd273414d725248b'],
 ['20261004141346_account_workspace_controls','4aae79ad3696657c562026fd384b73416f3cd41095090730db5937d6e93c1dee'],
 ['20261008100006_account_admin_catalog_controls','bca2bc0ab8ed20f8477c2b4886a7db7952c62c8ad1bb6addcfe28e5c841c126d'],
 ['20261008100014_account_context_sync','0e28465f587866dd9db1a862bda75439589f837f7605d02f79eb0e9732cb8fb0'],
 ['20261009012641_account_release_distribution','4f4ae13e371db40ddefff7dca845512f7fe7d9ff97d66279721d4377a1396ab4'],
 ['20261009050304_account_release_validation_fix','02a0a5e2a00ddcf0aa5bcd34bc8e9e0bb7ba293c17deaf38aca3e23080af3e4b'],
 ['20261009120157_account_credits_snapshot','b1de86c3f24e53bd3615828c050fb490209d4294cc20ca02237e3aee29f6fdeb'],
 ['20261011014422_account_checkout_unresolved_bound_guard','a522b98c79389571d182995343905e0f66deddd5b9e46fdac525376aa593d428'],
 ['20261012013828_account_gateway_test_pack','4cbc4a2d80db31390c00ab85a5a73c149efd7b95268df44f6184376608a283ba'],
 ['20261013021137_cluera_release_distribution','9ff672ca099578ffdbc7135be15b382d0981b5da4bce94b9e1c011b99a9abc3e'],
].map(([name,sha256])=>Object.freeze({file:`supabase/migrations/${name}.sql`,sha256})));
const CORE=Object.freeze({file:'docs/proposals/cluera-billing.sql',sha256:'473a81c727faf3448b682e70d95956fd67de4e01bd2af7914539fec7fb56e50d'});
const EXCLUDED=Object.freeze(['20261004082931_staging_billing_cron.sql','20261004083145_seal_staging_billing_provisioning.sql','docs/proposals/cluera-billing-scheduler.sql']);
const REVOKED=Object.freeze([
 'public.paddle_sandbox_receive(text,text,timestamptz,text,text)','public.paddle_sandbox_receive_simulation(text,text,timestamptz,text,text)',
 'public.customer_checkout_prepare(uuid,uuid,uuid,text)','public.customer_checkout_complete(uuid,uuid,text,text)',
 'public.customer_checkout_resume_read(uuid,uuid)','public.customer_pack_reconcile(text,uuid,text,text,text,text)',
 'public.customer_billing_claim(text)','public.customer_billing_finish(text,uuid,text)','public.customer_billing_bound_intent(text)',
 'public.customer_billing_apply_pack(text,uuid,text,uuid,text,text,text,text)','public.customer_billing_apply_recurring(text,uuid,text,jsonb)',
 'public.customer_billing_subscription(text)','public.customer_billing_action_claim()','public.customer_billing_action_finish(uuid,uuid,text)',
 'public.customer_billing_action_authorize(uuid,uuid)','public.account_payment_status(uuid,uuid)',
 'public.account_payment_prepare(uuid,uuid,uuid,text)','public.account_payment_bind(uuid,uuid,text,text,jsonb)',
 'public.account_payment_binding(text,text)','public.account_payment_receive(jsonb,text)','public.account_payment_claim(text)',
 'public.account_payment_retry(text,uuid)','public.account_payment_apply(text,uuid,text,text,jsonb)',
 'public.cluera_billing_legacy_apply(text,uuid,text,text,bigint,jsonb)',
]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function replaceOnce(text,from,to){if(text.split(from).length!==2)throw Error('Reviewed transform pin mismatch.');return text.replace(from,to);}
function readPinned(record,read){const bytes=Buffer.from(read(record.file));if(sha(bytes)!==record.sha256)throw Error('Reviewed source hash mismatch.');return bytes.toString('utf8').replaceAll('\r\n','\n');}
function prepare(target=TARGET,read=file=>fs.readFileSync(path.join(ROOT,file))){
 if(target!==TARGET)throw Error('Only the clean Cluera destination is allowed.');
 const sections=[`-- NEW CLEAN CLUERA FOUNDATION: target ${TARGET}, Mumbai.\n-- No identity/history import, external financial handoff, provider/payment activation or scheduler dispatch.\n-- Exactly pinned sources; old frozen proposals remain unchanged. Connector project identity MUST independently match.\n`];
 sections.push(`do $$begin
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p'))
 or to_regnamespace('billing_private') is not null or to_regnamespace('cluera_billing_private') is not null or to_regnamespace('cluera_private') is not null
 or exists(select 1 from auth.users) or exists(select 1 from auth.identities) or exists(select 1 from auth.sessions)
 then raise exception 'Clean empty destination prerequisite failed';end if;
end$$;
create schema billing_private;
revoke all on schema billing_private from public,anon,authenticated,service_role;
`);
 for(const record of SOURCES){
  let text=readPinned(record,read);
  if(record.file.includes('20261004141346_')){
   text=replaceOnce(text,"'gemini',true,true,array['text','image']","'gemini',false,false,array['text','image']");
   text=replaceOnce(text,"'deepgram',true,true,array['audio']","'deepgram',false,false,array['audio']");
  }
  if(record.file.includes('20261008100006_'))text=replaceOnce(text,'enabled boolean not null default true','enabled boolean not null default false');
  if(record.file.includes('20261012013828_')){
   const marker='-- Existing scheduler, secret and destination are retained.';
   if(text.split(marker).length!==2)throw Error('Reviewed scheduler exclusion mismatch.');text=text.split(marker)[0];
  }
  sections.push(`-- SOURCE ${record.file} SHA256 ${record.sha256}\n${text.trim()}\n`);
 }
 let core=readPinned(CORE,read);
 core=replaceOnce(core,"values(true,'account',1);","values(true,'cluera',1);");
 // A one-time pack has no provider plan to verify. Recurring revisions still
 // require the exact independently verified plan; the UI uses this distinction.
 core=replaceOnce(core,"'testPlanValidated',exists(select 1 from cluera_billing_private.plan_verifications v join cluera_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id)",
  "'testPlanValidated',(r.kind='PACK' or exists(select 1 from cluera_billing_private.plan_verifications v join cluera_billing_private.processing_owner o on o.account_digest=v.account_digest where v.revision_id=r.id))");
 sections.push(`-- SOURCE ${CORE.file} SHA256 ${CORE.sha256}\n-- Independent local standby owner only; this is NOT a cross-project financial handoff.\n${core.trim()}\n`);
 sections.push(`-- Clean compatibility structures are EMPTY; legacy financial paths are not exposed.\nrevoke all on function ${REVOKED.join(',\n ')} from public,anon,authenticated,service_role;\n`);
 sections.push(`-- Passive preparation only. No cron extension/job, Vault credential, network\n-- queue or outbound dispatch is installed. Later activation needs reviewed DDL.\ncreate table billing_private.worker_config (
 singleton boolean primary key default true check(singleton),secret_id uuid,
 enabled boolean not null default false,last_sent_at timestamptz,last_request_id bigint,
 constraint clean_worker_stays_passive check(not enabled and secret_id is null)
);
alter table billing_private.worker_config enable row level security;
revoke all on billing_private.worker_config from public,anon,authenticated,service_role;
insert into billing_private.worker_config(singleton) values(true);
create function billing_private.wake_worker() returns void language plpgsql security invoker set search_path=''
 set lock_timeout='2s' set statement_timeout='5s' as $$begin return;end$$;
revoke all on function billing_private.wake_worker() from public,anon,authenticated,service_role;
`);
 sections.push(`-- The platform's existing event-trigger helper is not a browser API.\n-- Retain the owner/event trigger; remove only browser/public EXECUTE grants.\ndo $$declare f record;begin\n for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n where n.nspname='public' and p.proname='rls_auto_enable' loop\n execute format('revoke all on function %s from public,anon,authenticated',f.signature);\n end loop;\nend$$;\n`);
 const sql=sections.join('\n');
 if(/dwqltsqumiwsxtkzdoaa|sigmaround-account-staging|cron\.schedule|net\.http_post|vault\.(?:create_secret|decrypted_secrets)|customer_billing_provision_worker/i.test(sql))throw Error('Excluded old authority or active scheduler in proposal.');
 return {sql,sha256:sha(sql),target:TARGET,activationAuthorized:false,
  seedRows:{account_ai_models:2,account_catalog_policy:4,cluera_catalog_revisions:4,cluera_catalog_heads:4,processing_owner:1,worker_config:1},
  sourcePins:[...SOURCES,CORE],excluded:[...EXCLUDED],legacyRevocations:[...REVOKED]};
}
// Read-only hosted/synthetic comparison. Bodies never leave the database;
// the platform-owned default event helper is not part of this composition.
function functionDigestSql(){return `select n.nspname as schema,p.proname as name,
 pg_get_function_identity_arguments(p.oid) as arguments,md5(p.prosrc) as body_md5,
 p.prosecdef as definer,p.proconfig as configuration
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','billing_private','cluera_billing_private') and p.prokind='f'
 and not(n.nspname='public' and p.proname='rls_auto_enable')
 order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid);`;}
module.exports={TARGET,SOURCES,CORE,EXCLUDED,REVOKED,prepare,functionDigestSql};
if(require.main===module){
 try{const output=prepare(process.argv[3]??TARGET);
  if(process.argv[2]==='--write-proposal'){
   const file=path.join(ROOT,'docs/proposals/cluera-clean-foundation.sql');
   fs.writeFileSync(file,output.sql,{encoding:'utf8',flag:'wx'});
  }else if(process.argv[2]!=='--check')throw Error('Use --check or exclusive --write-proposal.');
  const {sql,...report}=output;console.log(JSON.stringify({...report,status:'PREPARED_NOT_APPLIED'}));
 }catch{console.error('Cluera clean proposal preparation refused.');process.exitCode=1;}
}
