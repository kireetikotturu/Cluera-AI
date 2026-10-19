begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
-- REVIEW PROPOSAL ONLY. Not a migration and NOT applied remotely.
-- Default-off metadata telemetry; no provider request, credential or financial write.
-- Additive lookup index only: no financial rows/functions are altered.
create index customer_usage_run_id_telemetry on public.customer_usage_runs(run_id);
create table cluera_private.ai_provider_usage_starts (
 operation_id uuid primary key,user_id uuid not null,run_id uuid not null,
 provider text not null check(provider in ('gemini','deepgram')),credential_id uuid not null,
 revision integer not null check(revision>0),model text not null check(model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$'),
 started_at timestamptz not null default clock_timestamp(),
 foreign key(user_id,run_id) references public.customer_usage_runs(user_id,run_id)
);
create index ai_provider_usage_latest on cluera_private.ai_provider_usage_starts(started_at desc,operation_id);
create table cluera_private.ai_provider_usage_finishes (
 operation_id uuid primary key references cluera_private.ai_provider_usage_starts(operation_id),
 outcome text not null check(outcome in ('SUCCEEDED','FAILED','CANCELLED','STOPPED')),
 elapsed_ms integer not null check(elapsed_ms between 0 and 3600000),
 usage_metadata jsonb not null,finished_at timestamptz not null default clock_timestamp()
);
alter table cluera_private.ai_provider_usage_starts enable row level security;
alter table cluera_private.ai_provider_usage_finishes enable row level security;
revoke all on cluera_private.ai_provider_usage_starts,cluera_private.ai_provider_usage_finishes from public,anon,authenticated,service_role;
create function cluera_private.ai_provider_usage_immutable() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'Provider usage metadata is immutable';end$$;
create trigger ai_provider_usage_starts_immutable before update or delete or truncate on cluera_private.ai_provider_usage_starts
for each statement execute function cluera_private.ai_provider_usage_immutable();
create trigger ai_provider_usage_finishes_immutable before update or delete or truncate on cluera_private.ai_provider_usage_finishes
for each statement execute function cluera_private.ai_provider_usage_immutable();
alter table cluera_private.ai_provider_usage_starts enable always trigger ai_provider_usage_starts_immutable;
alter table cluera_private.ai_provider_usage_finishes enable always trigger ai_provider_usage_finishes_immutable;
revoke all on function cluera_private.ai_provider_usage_immutable() from public,anon,authenticated,service_role;

create function public.cluera_provider_usage_start(p_operation uuid,p_run uuid,p_provider text,p_model text,p_credential uuid,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare owner_id uuid;prior cluera_private.ai_provider_usage_starts;
begin
 if p_operation is null or p_run is null or p_provider is null or p_provider not in ('gemini','deepgram')
 or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$' or p_credential is null or p_revision is null or p_revision<1 then return jsonb_build_object('code','INVALID');end if;
 select * into prior from cluera_private.ai_provider_usage_starts where operation_id=p_operation;
 if found then
  if (prior.run_id,prior.provider,prior.model,prior.credential_id,prior.revision) is distinct from (p_run,p_provider,p_model,p_credential,p_revision) then return jsonb_build_object('code','CONFLICT');end if;
  return jsonb_build_object('code','RECORDED','operationId',p_operation);
 end if;
 -- The trusted server supplies a current coordinator UUID, never a browser ID.
 select r.user_id into owner_id from public.customer_usage_runs r
 join public.customer_usage_windows w on (w.user_id,w.run_id,w.sequence)=(r.user_id,r.run_id,r.sequence)
 where r.run_id=p_run and r.state='ACTIVE' and w.expires_at>clock_timestamp();
 if not found or (select count(*) from public.customer_usage_runs where run_id=p_run)<>1 then return jsonb_build_object('code','DENIED');end if;
 if not exists(select 1 from cluera_private.ai_providers where provider=p_provider and credential_id=p_credential
  and revision=p_revision and enabled and default_model=p_model and probe_status='VERIFIED' and complete) then return jsonb_build_object('code','DENIED');end if;
 insert into cluera_private.ai_provider_usage_starts(operation_id,user_id,run_id,provider,credential_id,revision,model)
 values(p_operation,owner_id,p_run,p_provider,p_credential,p_revision,p_model) on conflict do nothing;
 select * into prior from cluera_private.ai_provider_usage_starts where operation_id=p_operation;
 if (prior.run_id,prior.provider,prior.model,prior.credential_id,prior.revision) is distinct from (p_run,p_provider,p_model,p_credential,p_revision) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','RECORDED','operationId',p_operation);
end$$;
create function public.cluera_provider_usage_finish(p_operation uuid,p_outcome text,p_elapsed_ms integer,p_usage jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare entry record;prior cluera_private.ai_provider_usage_finishes;
begin
 if p_operation is null or p_outcome is null or p_outcome not in ('SUCCEEDED','FAILED','CANCELLED','STOPPED')
 or p_elapsed_ms is null or p_elapsed_ms<0 or p_elapsed_ms>3600000 or p_usage is null or jsonb_typeof(p_usage)<>'object'
 or octet_length(p_usage::text)>2048 then return jsonb_build_object('code','INVALID');end if;
 for entry in select key,value from jsonb_each(p_usage) loop
  if entry.key='requestHash' then
   if jsonb_typeof(entry.value)<>'string' or (entry.value#>>'{}')!~'^[a-f0-9]{64}$' then return jsonb_build_object('code','INVALID');end if;
  elsif entry.key in ('inputTokens','outputTokens','cachedTokens','thinkingTokens','totalTokens','audioWindowMilliseconds') then
   if jsonb_typeof(entry.value)<>'number' or (entry.value#>>'{}')!~'^(0|[1-9][0-9]{0,9})$'
    or (entry.value#>>'{}')::numeric>1000000000 then return jsonb_build_object('code','INVALID');end if;
  else return jsonb_build_object('code','INVALID');end if;
 end loop;
 if not exists(select 1 from cluera_private.ai_provider_usage_starts where operation_id=p_operation) then return jsonb_build_object('code','NOT_FOUND');end if;
 insert into cluera_private.ai_provider_usage_finishes(operation_id,outcome,elapsed_ms,usage_metadata)
 values(p_operation,p_outcome,p_elapsed_ms,p_usage) on conflict do nothing;
 select * into prior from cluera_private.ai_provider_usage_finishes where operation_id=p_operation;
 if (prior.outcome,prior.elapsed_ms,prior.usage_metadata) is distinct from (p_outcome,p_elapsed_ms,p_usage) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','RECORDED','operationId',p_operation);
end$$;
create function public.cluera_provider_usage_admin_read(p_actor uuid,p_session uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 return jsonb_build_object('code','ACTIVE','scope','LATEST_REQUESTS','limit',50,'costStatus','UNAVAILABLE','rows',coalesce((select jsonb_agg(jsonb_build_object(
  'operationId',s.operation_id,'provider',s.provider,'model',s.model,'startedAt',s.started_at,'finishedAt',f.finished_at,
  'outcome',coalesce(f.outcome,'UNCONFIRMED'),'elapsedMilliseconds',f.elapsed_ms,'requestHash',f.usage_metadata->'requestHash',
  'inputTokens',f.usage_metadata->'inputTokens','outputTokens',f.usage_metadata->'outputTokens','cachedTokens',f.usage_metadata->'cachedTokens',
  'thinkingTokens',f.usage_metadata->'thinkingTokens','totalTokens',f.usage_metadata->'totalTokens',
  'audioWindowMilliseconds',f.usage_metadata->'audioWindowMilliseconds','cost',null,'costStatus','UNAVAILABLE') order by s.started_at desc,s.operation_id)
  from (select * from cluera_private.ai_provider_usage_starts order by started_at desc,operation_id limit 50) s
  left join cluera_private.ai_provider_usage_finishes f using(operation_id)),'[]'::jsonb));
end$$;
revoke all on function public.cluera_provider_usage_start(uuid,uuid,text,text,uuid,integer),
 public.cluera_provider_usage_finish(uuid,text,integer,jsonb),public.cluera_provider_usage_admin_read(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.cluera_provider_usage_start(uuid,uuid,text,text,uuid,integer),
 public.cluera_provider_usage_finish(uuid,text,integer,jsonb),public.cluera_provider_usage_admin_read(uuid,uuid) to service_role;

commit;
