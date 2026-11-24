-- Admin-set label ("Recommended", "Fast", "Slow", custom text) shown next to each model in the desktop picker.
-- tag = '' means automatic, '-' means no label. Models saved without a tag keep the one they have.
begin;

alter table public.account_ai_models add column if not exists tag text not null default '';
do $$begin
 if not exists(select 1 from pg_constraint where conrelid='public.account_ai_models'::regclass and conname='account_ai_models_tag_check') then
  alter table public.account_ai_models add constraint account_ai_models_tag_check check(char_length(tag)<=24 and tag !~ '[<>]');
 end if;
end$$;

create or replace function public.account_models_read() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('modelId',model_id,'displayName',display_name,'provider',provider,
  'enabled',enabled,'isDefault',is_default,'priority',priority,'capabilities',capabilities,'health',health,'tag',tag) order by priority,model_id),'[]')
 from public.account_ai_models;
$$;
revoke all on function public.account_models_read() from public,anon,authenticated;
grant execute on function public.account_models_read() to service_role;

-- Patch account_admin_mutate in place (exact text replacements, each must match once).
do $$declare d text;
 a1 text:=$a$priority,capabilities,health)
   values(p_input->>'modelId'$a$;
 a2 text:=$a$p_input->>'health')
   on conflict(model_id) do update set display_name=excluded.display_name,$a$;
begin
 d:=pg_get_functiondef('public.account_admin_mutate(uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure);
 if (length(d)-length(replace(d,a1,'')))/length(a1)<>1 or (length(d)-length(replace(d,a2,'')))/length(a2)<>1
 then raise exception 'account_admin_mutate text changed; review before patching';end if;
 d:=replace(d,a1,$b$priority,capabilities,health,tag)
   values(p_input->>'modelId'$b$);
 d:=replace(d,a2,$b$p_input->>'health',coalesce(p_input->>'tag',''))
   on conflict(model_id) do update set tag=case when p_input ? 'tag' then excluded.tag else public.account_ai_models.tag end,display_name=excluded.display_name,$b$);
 execute d;
end$$;

commit;
