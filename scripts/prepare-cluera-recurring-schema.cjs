'use strict';
// One atomic, default-disabled installation. This performs no provider call,
// financial activation, grant, command or existing business-row modification.
const fs = require('node:fs'), path = require('node:path');
const sources = [
  'cluera-subscription-cancellation.sql', 'cluera-native-recurring.sql',
  'cluera-native-recurring-refresh.sql', 'cluera-native-recurring-history.sql',
];
function prepare(root = path.resolve(__dirname, '..')) {
  const pieces = sources.map(name => {
    const sql = fs.readFileSync(path.join(root, 'docs/proposals', name), 'utf8');
    if ((sql.match(/^begin;$/gm) || []).length !== 1 || (sql.match(/^commit;$/gm) || []).length !== 1)
      throw Error('Unexpected proposal transaction boundary.');
    return sql.replace(/^begin;$/m, '').replace(/^commit;$/m, '');
  });
  return `begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(862117,20261020);
do $$begin
 if to_regclass('cluera_billing_private.native_config') is not null
 or to_regclass('cluera_billing_private.cancellation_commands') is not null
 or to_regprocedure('public.cluera_billing_history(uuid,uuid)') is null
 then raise exception 'Recurring installation precondition requires review';end if;
end$$;
create temporary table cluera_install_preserved_rows(schema_name text,table_name text,row_count bigint,digest text) on commit drop;
do $$declare r record;n bigint;h text;begin
 for r in select n.nspname schema_name,c.relname table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in('public','billing_private','cluera_billing_private') and c.relkind='r' loop
 execute format('select count(*),md5(coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),''''))from %I.%I t',
 r.schema_name,r.table_name)into n,h;
 insert into cluera_install_preserved_rows values(r.schema_name,r.table_name,n,h);
 end loop;
end$$;
create temporary table cluera_install_preserved_functions on commit drop as
 select n.nspname schema_name,p.proname,pg_get_function_identity_arguments(p.oid) args,p.prosrc,p.proconfig,
 p.prosecdef,p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('public','billing_private','cluera_billing_private');
${pieces.join('\n')}
do $$declare r record;n bigint;h text;target_name text;begin
 for r in select *from cluera_install_preserved_rows loop
 execute format('select count(*),md5(coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),''''))from %I.%I t',
 r.schema_name,r.table_name)into n,h;
 if n<>r.row_count or h<>r.digest then raise exception 'Existing business rows changed during recurring installation';end if;
 end loop;
 for r in select *from cluera_install_preserved_functions loop
 target_name:=case when r.schema_name='public'and r.proname in('cluera_billing_apply','cluera_billing_prepare')
 then r.proname||'_pre_native' when r.schema_name='cluera_billing_private'and r.proname='refresh'
 then 'refresh_pre_native' else r.proname end;
 if not exists(select 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
 where ns.nspname=r.schema_name and p.proname=target_name and pg_get_function_identity_arguments(p.oid)=r.args
 and p.prosrc=r.prosrc and p.proconfig is not distinct from r.proconfig and p.prosecdef=r.prosecdef and p.provolatile=r.provolatile)
 then raise exception 'Existing function implementation was not preserved';end if;
 end loop;
 if(select count(*)from cluera_billing_private.native_config)<>1
 or exists(select 1 from cluera_billing_private.native_config where enabled)
 or exists(select 1 from cluera_billing_private.cancellation_commands)
 or exists(select 1 from cluera_billing_private.cancellation_audit)
 or exists(select 1 from cluera_billing_private.native_schedules)
 or exists(select 1 from cluera_billing_private.native_outbox)
 or exists(select 1 from cluera_billing_private.native_audit)
 then raise exception 'Recurring installation unexpectedly activated financial state';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='cluera_billing_private'and c.relkind='r'and(not c.relrowsecurity
 or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
 then raise exception 'Recurring table privilege boundary failed';end if;
end$$;
commit;
`;
}
module.exports = { prepare, sources };
if (require.main === module) process.stdout.write(prepare());
