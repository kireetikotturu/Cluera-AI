-- Starting texts and the recommended model for new desktop sessions, edited by the Admin.
-- A blank value means "use the built-in text", so the app always has something sensible to show.
begin;

create table if not exists public.cluera_session_defaults(
 id boolean primary key default true check(id),
 interview_context text not null default '' check(char_length(interview_context)<=4000),
 assignment_context text not null default '' check(char_length(assignment_context)<=4000),
 assignment_model text not null default '' check(assignment_model='' or assignment_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$'),
 updated_at timestamptz not null default now()
);
insert into public.cluera_session_defaults(id) values(true) on conflict(id) do nothing;
alter table public.cluera_session_defaults enable row level security;
revoke all on public.cluera_session_defaults from public,anon,authenticated;

create or replace function public.account_session_defaults_read() returns jsonb language sql security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('interviewContext',interview_context,'assignmentContext',assignment_context,'assignmentModel',assignment_model)
  from public.cluera_session_defaults where id),'{}'::jsonb);
$$;
revoke all on function public.account_session_defaults_read() from public,anon,authenticated;
grant execute on function public.account_session_defaults_read() to service_role;

create or replace function public.account_admin_session_defaults(p_actor uuid,p_session uuid,p_operation uuid,p_reason text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit%rowtype;
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_operation is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 or p_input is null
   or jsonb_typeof(p_input->'interviewContext') is distinct from 'string' or char_length(p_input->>'interviewContext')>4000
   or jsonb_typeof(p_input->'assignmentContext') is distinct from 'string' or char_length(p_input->>'assignmentContext')>4000
   or jsonb_typeof(p_input->'assignmentModel') is distinct from 'string'
   or not (p_input->>'assignmentModel'='' or p_input->>'assignmentModel' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$')
 then return jsonb_build_object('code','INVALID'); end if;
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation::text,912345));
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
   if prior.actor_id<>p_actor or prior.subject_id is not null or prior.action<>'SESSION_DEFAULTS'
     or prior.reason<>trim(p_reason) or prior.detail->'input' is distinct from p_input then return jsonb_build_object('code','CONFLICT'); end if;
   return jsonb_build_object('code','APPLIED');
 end if;
 update public.cluera_session_defaults set interview_context=trim(p_input->>'interviewContext'),assignment_context=trim(p_input->>'assignmentContext'),
   assignment_model=p_input->>'assignmentModel',updated_at=clock_timestamp() where id;
 insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
 values(p_operation,p_actor,null,'SESSION_DEFAULTS',trim(p_reason),jsonb_build_object('input',p_input));
 return jsonb_build_object('code','APPLIED');
end $$;
revoke all on function public.account_admin_session_defaults(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_admin_session_defaults(uuid,uuid,uuid,text,jsonb) to service_role;

commit;
