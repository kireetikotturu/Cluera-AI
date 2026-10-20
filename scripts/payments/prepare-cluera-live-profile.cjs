'use strict';
// Generates a reviewable SQL transaction from non-secret inputs. Never connects
// to a service, reads environment credentials, executes SQL or activates flags.
function prepare(input) {
  const keys=['phase','merchantDigest','origin','acceptanceDigest','operationId','expectedEpoch'];
  if(!input||Object.keys(input).sort().join()!==keys.sort().join()
    ||!['profile','intake','promote'].includes(input.phase)
    ||![input.merchantDigest,input.acceptanceDigest].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))
    ||!/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(input.origin)
    ||!Number.isSafeInteger(input.expectedEpoch)||input.expectedEpoch<1
    ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId))
    throw Error('Exact non-secret reviewed profile inputs are required.');
  const {phase,merchantDigest,origin,acceptanceDigest,operationId,expectedEpoch}=input;
  if(new URL(origin).origin!==origin||/(^|\.)(localhost|local|invalid|internal|test)$/.test(new URL(origin).hostname))
    throw Error('Exact approved HTTPS origin required.');
  const guard=`if not exists(select 1 from cluera_live_billing_private.processing_owner
 where singleton and owner='cluera'and epoch=${expectedEpoch} and account_digest='${merchantDigest}')
 or not exists(select 1 from cluera_billing_runtime_private.live_profile
 where singleton and account_digest='${merchantDigest}'and origin='${origin}')
 then raise exception 'Profile or ownership changed; stop and review';end if;`;
  const operation=phase==='profile'?`
 if exists(select 1 from cluera_live_billing_private.intents)
 or exists(select 1 from cluera_billing_runtime_private.live_profile where account_digest is not null)
 then raise exception 'Initial profile already used; stop and review';end if;
 result:=public.cluera_live_billing_cutover('${operationId}','account',${expectedEpoch},'cluera',
 '${merchantDigest}','Approved initial isolated Live profile; charging remains disabled');
 if result->>'code'is distinct from 'APPLIED'then raise exception 'Ownership precondition failed';end if;
 update cluera_billing_runtime_private.live_profile set account_digest='${merchantDigest}',origin='${origin}';
 `:phase==='intake'?`${guard}
 if exists(select 1 from cluera_billing_runtime_private.live_profile where intake_enabled or checkout_enabled)
 then raise exception 'Intake already configured; stop and review';end if;
 update cluera_billing_runtime_private.live_profile set intake_enabled=true,acceptance_digest='${acceptanceDigest}';
 `:`${guard}
 if not exists(select 1 from cluera_billing_runtime_private.live_profile
 where intake_enabled and acceptance_digest='${acceptanceDigest}'and not checkout_enabled)
 or not exists(select 1 from cluera_billing_runtime_private.active_bank where mode='test')
 or exists(select 1 from cluera_billing_private.intents where state in('CREATING','BOUND','UNCERTAIN'))
 or exists(select 1 from cluera_billing_private.events where state='PENDING')
 then raise exception 'Acceptance or Test reconciliation incomplete';end if;
 update cluera_billing_runtime_private.live_profile set checkout_enabled=true;
 update cluera_billing_runtime_private.active_bank set mode='live';
 `;
  return `-- GENERATED REVIEW PROPOSAL ONLY. Phase: ${phase}. Requires separate owner approval.
-- Acceptance digest identifies the private approved change/acceptance record, not a secret.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
select pg_advisory_xact_lock(862117,20261021);
do $$declare result jsonb;begin
 perform 1 from cluera_billing_runtime_private.active_bank where singleton for update;
 perform 1 from cluera_billing_runtime_private.live_profile where singleton for update;
 perform 1 from cluera_live_billing_private.processing_owner where singleton for update;
 ${operation}
end$$;
commit;
`;
}
module.exports={prepare};
if(require.main===module){
 try{
  const fs=require('node:fs');
  if(process.argv.length!==3)throw Error();
  process.stdout.write(prepare(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))));
 }catch{console.error('Live profile proposal unavailable. Supply the reviewed non-secret JSON input file.');process.exitCode=1;}
}
