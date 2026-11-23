-- Simple Admin AI models: Gemini, ChatGPT (openai), Claude (anthropic) and Deepgram Flux.
-- * account_ai_models accepts openai/anthropic answer models and any Deepgram flux-* model.
-- * Admin MODEL keeps one answer default across all answer providers; MODEL_DELETE removes a model.
-- * Enabling a provider key no longer requires the model to appear in the provider's model
--   list (Deepgram never lists Flux there); the Admin model list decides which models run.
begin;

do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='public.account_ai_models'::regclass and contype='c'
  and pg_get_constraintdef(oid) like '%deepgram%' loop
  execute format('alter table public.account_ai_models drop constraint %I',c.conname);
 end loop;
end$$;
alter table public.account_ai_models add constraint account_ai_models_provider_check
 check(provider in('gemini','openai','anthropic','deepgram'));
alter table public.account_ai_models add constraint account_ai_models_provider_capabilities_check
 check((provider in('gemini','openai','anthropic') and 'text'=any(capabilities) and capabilities<@array['text','image'])
  or (provider='deepgram' and capabilities=array['audio'] and model_id ~ '^flux-[a-z0-9-]{1,60}$'));

do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='cluera_private.ai_provider_usage_starts'::regclass and contype='c'
  and pg_get_constraintdef(oid) like '%deepgram%' loop
  execute format('alter table cluera_private.ai_provider_usage_starts drop constraint %I',c.conname);
 end loop;
end$$;
alter table cluera_private.ai_provider_usage_starts add constraint ai_provider_usage_starts_provider_check
 check(provider in('gemini','deepgram','openai','anthropic'));

-- Patch account_admin_mutate in place (exact text replacements, each must match once).
do $$declare d text;
 a1 text:='p_input->>''provider'' not in (''gemini'',''deepgram'')';
 a2 text:='p_input->>''provider''=''deepgram'' and p_input->>''modelId''<>''flux-general-en''';
 a3 text:='update public.account_ai_models set is_default=false where provider=p_input->>''provider'';';
 a4 text:=' else
   perform 1 from public.customer_accounts where user_id=p_subject for update;';
begin
 d:=pg_get_functiondef('public.account_admin_mutate(uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure);
 if (length(d)-length(replace(d,a1,'')))/length(a1)<>1 or (length(d)-length(replace(d,a2,'')))/length(a2)<>1
  or (length(d)-length(replace(d,a3,'')))/length(a3)<>1 or (length(d)-length(replace(d,a4,'')))/length(a4)<>1
 then raise exception 'account_admin_mutate text changed; review before patching';end if;
 d:=replace(d,a1,'p_input->>''provider'' not in (''gemini'',''openai'',''anthropic'',''deepgram'')');
 d:=replace(d,a2,'p_input->>''provider''=''deepgram'' and p_input->>''modelId'' !~ ''^flux-[a-z0-9-]{1,60}$''');
 d:=replace(d,a3,'update public.account_ai_models set is_default=false where case when p_input->>''provider''=''deepgram'' then provider=''deepgram'' else provider in (''gemini'',''openai'',''anthropic'') end;');
 d:=replace(d,a4,' elsif p_action=''MODEL_DELETE'' then
   if p_subject is not null or coalesce(p_input->>''modelId'','''') !~ ''^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$'' then return jsonb_build_object(''code'',''INVALID''); end if;
   perform pg_advisory_xact_lock(7918201);
   delete from public.account_ai_models where model_id=p_input->>''modelId'';
   if not found then return jsonb_build_object(''code'',''NOT_FOUND''); end if;
 else
   perform 1 from public.customer_accounts where user_id=p_subject for update;');
 execute d;
end$$;

-- Provider enablement: any of the four providers, key must be verified recently; no model-list check.
do $$declare d text;
 a1 text:='(p_provider not in (''gemini'',''deepgram'') or r.probe_status';
 a2 text:='
   or not exists(select 1 from jsonb_array_elements(r.models) m where m->>''id''=p_input->>''defaultModel'' and m->''runtimeCompatible''=''true'')';
begin
 d:=pg_get_functiondef('public.cluera_provider_mutate(uuid,uuid,uuid,text,text,integer,text,timestamptz,jsonb)'::regprocedure);
 if (length(d)-length(replace(d,a1,'')))/length(a1)<>1 or (length(d)-length(replace(d,a2,'')))/length(a2)<>1
 then raise exception 'cluera_provider_mutate text changed; review before patching';end if;
 d:=replace(d,a1,'(r.probe_status');
 d:=replace(d,a2,'
   or p_input->>''defaultModel'' !~ ''^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$''');
 execute d;
end$$;

commit;
