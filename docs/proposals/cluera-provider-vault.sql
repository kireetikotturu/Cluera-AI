-- REVIEW PROPOSAL ONLY: no migration history entry and NOT applied remotely.
-- Requires explicit owner schema approval, CLI-generated migration and normal review.
create schema if not exists cluera_private;
revoke all on schema cluera_private from public,anon,authenticated,service_role;
create table cluera_private.ai_providers (
 provider text primary key check(provider in ('gemini','deepgram','openai','anthropic')),
 revision integer not null check(revision>0),credential_id uuid not null,
 sealed jsonb not null check(jsonb_typeof(sealed)='object'),
 enabled boolean not null default false,default_model text,
 probe_status text not null default 'UNVERIFIED' check(probe_status in ('UNVERIFIED','VERIFIED','REJECTED','UNAVAILABLE')),
 probe_at timestamptz,models jsonb not null default '[]',complete boolean not null default false,
 updated_at timestamptz not null default now()
);
create table cluera_private.ai_provider_audit (
 operation_id uuid primary key,actor_id uuid not null,session_id uuid not null,
 provider text not null,action text not null,input_digest text not null check(input_digest ~ '^[a-f0-9]{64}$'),
 before_metadata jsonb,after_metadata jsonb not null,created_at timestamptz not null default now()
);
alter table cluera_private.ai_providers enable row level security;
alter table cluera_private.ai_provider_audit enable row level security;
revoke all on cluera_private.ai_providers,cluera_private.ai_provider_audit from public,anon,authenticated,service_role;
create function cluera_private.ai_provider_audit_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$begin raise exception 'Provider audit is immutable';end$$;
create trigger ai_provider_audit_immutable before update or delete or truncate on cluera_private.ai_provider_audit
for each statement execute function cluera_private.ai_provider_audit_immutable();
alter table cluera_private.ai_provider_audit enable always trigger ai_provider_audit_immutable;
revoke all on function cluera_private.ai_provider_audit_immutable() from public,anon,authenticated,service_role;

create function cluera_private.ai_provider_metadata(r cluera_private.ai_providers) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('provider',r.provider,'revision',r.revision,'credentialPresent',true,
 'enabled',r.enabled,'defaultModel',r.default_model,'probeStatus',r.probe_status,
 'probeAt',r.probe_at,'models',r.models,'complete',r.complete,'updatedAt',r.updated_at)
$$;
revoke all on function cluera_private.ai_provider_metadata(cluera_private.ai_providers) from public,anon,authenticated,service_role;

create function public.cluera_provider_admin_read(p_actor uuid,p_session uuid,p_operation uuid default null) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is not null then
  return coalesce((select jsonb_build_object('code','APPLIED','provider',provider,'metadata',after_metadata)
    from cluera_private.ai_provider_audit where operation_id=p_operation and actor_id=p_actor),jsonb_build_object('code','NOT_FOUND'));
 end if;
 return jsonb_build_object('code','ACTIVE','providers',coalesce((select jsonb_agg(cluera_private.ai_provider_metadata(r) order by r.provider) from cluera_private.ai_providers r),'[]'::jsonb));
end$$;

-- Authenticated server only. Ciphertext-only response; no plaintext exists in SQL.
create function public.cluera_provider_read(p_provider text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 if p_provider not in ('gemini','deepgram','openai','anthropic') then return null;end if;
 return (select to_jsonb(r) from cluera_private.ai_providers r where provider=p_provider);
end$$;

create function public.cluera_provider_mutate(p_actor uuid,p_session uuid,p_operation uuid,p_provider text,
 p_action text,p_revision integer,p_digest text,p_reauthenticated_at timestamptz,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare r cluera_private.ai_providers;prior cluera_private.ai_provider_audit;before_value jsonb;after_value jsonb;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true or p_reauthenticated_at is null
 or p_reauthenticated_at<now()-interval '2 minutes' or p_reauthenticated_at>now()+interval '5 seconds' then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_operation is null or p_provider not in ('gemini','deepgram','openai','anthropic') or p_action not in ('REPLACE','TEST','CONFIGURE')
 or p_revision is null or p_revision<0 or p_digest is null or p_digest!~'^[a-f0-9]{64}$' or p_input is null or jsonb_typeof(p_input)!='object' then return jsonb_build_object('code','INVALID');end if;
 perform pg_catalog.pg_advisory_xact_lock(862103,pg_catalog.hashtext(p_provider));
 select * into prior from cluera_private.ai_provider_audit where operation_id=p_operation;
 if found then
  if prior.actor_id!=p_actor or prior.provider!=p_provider or prior.action!=p_action or prior.input_digest!=p_digest then return jsonb_build_object('code','CONFLICT');end if;
  return jsonb_build_object('code','APPLIED','metadata',prior.after_metadata);
 end if;
 select * into r from cluera_private.ai_providers where provider=p_provider for update;
 if coalesce(r.revision,0)!=p_revision then return jsonb_build_object('code','CONFLICT');end if;
 before_value=case when r.provider is null then null else cluera_private.ai_provider_metadata(r) end;
 if p_action='REPLACE' then
  if p_input-'sealed'-'credentialId'!='{}'::jsonb or jsonb_typeof(p_input->'sealed')!='object' or coalesce(p_input->>'credentialId','')!~'^[a-f0-9-]{36}$'
  or p_input->'sealed'->>'v' is distinct from '1' then return jsonb_build_object('code','INVALID');end if;
  insert into cluera_private.ai_providers(provider,revision,credential_id,sealed) values(p_provider,p_revision+1,(p_input->>'credentialId')::uuid,p_input->'sealed')
  on conflict(provider) do update set revision=excluded.revision,credential_id=excluded.credential_id,sealed=excluded.sealed,
   enabled=false,default_model=null,probe_status='UNVERIFIED',probe_at=null,models='[]',complete=false,updated_at=now();
 elsif p_action='TEST' then
  if r.provider is null or p_input-'status'-'models'-'complete'!='{}'::jsonb or p_input->>'status' not in ('VERIFIED','REJECTED','UNAVAILABLE')
   or jsonb_typeof(p_input->'models') is distinct from 'array' or jsonb_array_length(p_input->'models')>1000
   or jsonb_typeof(p_input->'complete') is distinct from 'boolean' then return jsonb_build_object('code','INVALID');end if;
  update cluera_private.ai_providers set revision=revision+1,probe_status=p_input->>'status',probe_at=now(),models=p_input->'models',
   complete=(p_input->>'complete')::boolean,enabled=enabled and p_input->>'status'='VERIFIED',updated_at=now() where provider=p_provider;
 else
  if r.provider is null or p_input-'enabled'-'defaultModel'!='{}'::jsonb or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
   or not(p_input?'defaultModel') then return jsonb_build_object('code','INVALID');end if;
  if (p_input->>'enabled')::boolean and (p_provider not in ('gemini','deepgram') or r.probe_status!='VERIFIED' or not r.complete
   or r.probe_at<now()-interval '15 minutes' or p_input->>'defaultModel' is null
   or not exists(select 1 from jsonb_array_elements(r.models) m where m->>'id'=p_input->>'defaultModel' and m->'runtimeCompatible'='true')) then return jsonb_build_object('code','INVALID');end if;
  update cluera_private.ai_providers set revision=revision+1,enabled=(p_input->>'enabled')::boolean,default_model=p_input->>'defaultModel',updated_at=now() where provider=p_provider;
 end if;
 select * into r from cluera_private.ai_providers where provider=p_provider;
 after_value=cluera_private.ai_provider_metadata(r);
 insert into cluera_private.ai_provider_audit(operation_id,actor_id,session_id,provider,action,input_digest,before_metadata,after_metadata)
 values(p_operation,p_actor,p_session,p_provider,p_action,p_digest,before_value,after_value);
 return jsonb_build_object('code','APPLIED','metadata',after_value);
end$$;
revoke all on function public.cluera_provider_admin_read(uuid,uuid,uuid),public.cluera_provider_read(text),
 public.cluera_provider_mutate(uuid,uuid,uuid,text,text,integer,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.cluera_provider_admin_read(uuid,uuid,uuid),public.cluera_provider_read(text),
 public.cluera_provider_mutate(uuid,uuid,uuid,text,text,integer,text,timestamptz,jsonb) to service_role;
