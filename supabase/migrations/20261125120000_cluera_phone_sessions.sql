-- History of live sessions run from the website on a phone, so the Windows app can show them too.
-- Only the signed-in owner can read or change a row: every access goes through the function below, which first
-- checks the live user/session exactly like the account context functions. The table itself is closed to every role.
begin;

create table public.customer_phone_sessions(
 id uuid primary key,
 user_id uuid not null references public.customer_accounts(user_id) on delete cascade,
 kind text not null check(kind in ('interview','assignment')),
 title text not null check(char_length(title) between 1 and 160),
 role text not null default '' check(char_length(role)<=160),
 company text not null default '' check(char_length(company)<=160),
 model text not null default '' check(char_length(model)<=100),
 setup jsonb not null default '{}'::jsonb check(jsonb_typeof(setup)='object' and octet_length(setup::text)<=20000),
 turns jsonb not null default '[]'::jsonb check(jsonb_typeof(turns)='array' and jsonb_array_length(turns)<=300 and octet_length(turns::text)<=500000),
 started_at timestamptz not null,
 ended_at timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);
create index customer_phone_sessions_owner on public.customer_phone_sessions(user_id,updated_at desc,id);
alter table public.customer_phone_sessions enable row level security;
revoke all on public.customer_phone_sessions from public,anon,authenticated,service_role;

create function public.customer_phone_session_command(p_user uuid,p_session uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb; action text; ident uuid; found_row jsonb; listing jsonb;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' then return jsonb_build_object('code','INVALID'); end if;
 action:=p_input->>'action';
 if action is null or action not in ('LIST','READ','SAVE','DELETE') then return jsonb_build_object('code','INVALID'); end if;
 if action in ('READ','SAVE','DELETE') then
  if (p_input->>'id') is null then return jsonb_build_object('code','INVALID'); end if;
  ident:=(p_input->>'id')::uuid;
 end if;
 if action='SAVE' then
  if exists(select 1 from public.customer_phone_sessions where id=ident and user_id<>p_user) then return jsonb_build_object('code','FORBIDDEN'); end if;
  insert into public.customer_phone_sessions(id,user_id,kind,title,role,company,model,setup,turns,started_at,ended_at)
  values(ident,p_user,p_input->>'kind',trim(p_input->>'title'),coalesce(trim(p_input->>'role'),''),coalesce(trim(p_input->>'company'),''),
   coalesce(p_input->>'model',''),coalesce(p_input->'setup','{}'::jsonb),coalesce(p_input->'turns','[]'::jsonb),
   (p_input->>'startedAt')::timestamptz,nullif(p_input->>'endedAt','')::timestamptz)
  on conflict(id) do update set kind=excluded.kind,title=excluded.title,role=excluded.role,company=excluded.company,model=excluded.model,
   setup=excluded.setup,turns=excluded.turns,ended_at=excluded.ended_at,updated_at=clock_timestamp()
   where customer_phone_sessions.user_id=p_user;
  -- Only the newest 50 sessions are kept for each account.
  delete from public.customer_phone_sessions where user_id=p_user and id in (
   select id from public.customer_phone_sessions where user_id=p_user order by updated_at desc,id offset 50);
 elsif action='DELETE' then
  delete from public.customer_phone_sessions where user_id=p_user and id=ident;
 elsif action='READ' then
  select jsonb_build_object('id',id,'kind',kind,'title',title,'role',role,'company',company,'model',model,'setup',setup,'turns',turns,
   'startedAt',started_at,'endedAt',ended_at,'updatedAt',updated_at) into found_row
  from public.customer_phone_sessions where user_id=p_user and id=ident;
  if found_row is null then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('code','ACTIVE','session',found_row);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'title',title,'role',role,'company',company,'model',model,
   'startedAt',started_at,'endedAt',ended_at,'updatedAt',updated_at,'questionCount',jsonb_array_length(turns)) order by updated_at desc,id),'[]'::jsonb)
 into listing from public.customer_phone_sessions where user_id=p_user;
 return jsonb_build_object('code','ACTIVE','sessions',listing);
exception when invalid_text_representation or check_violation or not_null_violation or string_data_right_truncation
 or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.customer_phone_session_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.customer_phone_session_command(uuid,uuid,jsonb) to service_role;

commit;
