-- Usage receipts for every answer provider (Gemini, ChatGPT, Claude) and every approved model.
-- Before: only gemini/deepgram were accepted, and the receipt was refused unless the model equalled the
-- provider row's single default_model, so any other approved model could never record usage (and with
-- receipts switched on, the answer itself was refused). The Admin model list decides WHICH model runs; the
-- key row only has to be the current, verified, enabled credential for that provider.
create or replace function public.cluera_provider_usage_start(p_operation uuid, p_run uuid, p_provider text, p_model text, p_credential uuid, p_revision integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
set lock_timeout to '2s'
set statement_timeout to '5s'
as $function$
declare owner_id uuid;prior cluera_private.ai_provider_usage_starts;
begin
 if p_operation is null or p_run is null or p_provider is null or p_provider not in ('gemini','deepgram','openai','anthropic')
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
  and revision=p_revision and enabled and probe_status='VERIFIED' and complete) then return jsonb_build_object('code','DENIED');end if;
 insert into cluera_private.ai_provider_usage_starts(operation_id,user_id,run_id,provider,credential_id,revision,model)
 values(p_operation,owner_id,p_run,p_provider,p_credential,p_revision,p_model) on conflict do nothing;
 select * into prior from cluera_private.ai_provider_usage_starts where operation_id=p_operation;
 if (prior.run_id,prior.provider,prior.model,prior.credential_id,prior.revision) is distinct from (p_run,p_provider,p_model,p_credential,p_revision) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','RECORDED','operationId',p_operation);
end$function$;
