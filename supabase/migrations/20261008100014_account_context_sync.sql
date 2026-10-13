-- Account-only context synchronization; original files are never uploaded.
-- Service callers must supply the verified live user/session, never browser IDs.
create table public.customer_context_operations (
  user_id uuid not null references public.customer_accounts(user_id),
  operation_id uuid not null,
  input_hash text not null,
  created_at timestamptz not null default now(),
  primary key(user_id,operation_id)
);
alter table public.customer_context_operations enable row level security;
revoke all on public.customer_context_operations from public,anon,authenticated,service_role;

create function public.customer_context_command(p_user uuid,p_session uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb; action text:=p_input->>'action'; ident uuid; operation uuid;
 prior text; fingerprint text; documents jsonb; ids uuid[]; result jsonb;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or action is null or action not in ('LIST','READ','SAVE','DELETE') then
  return jsonb_build_object('code','INVALID'); end if;
 -- Consistent with all account usage/workspace writers: one account lock.
 perform 1 from public.customer_accounts where user_id=p_user for update;
 if (select state from public.customer_accounts where user_id=p_user) is distinct from 'ACTIVE' then return jsonb_build_object('code','SUSPENDED'); end if;
 if action in ('SAVE','DELETE') then
  if (p_input->>'id') is null or (p_input->>'operationId') is null then return jsonb_build_object('code','INVALID'); end if;
  ident:=(p_input->>'id')::uuid;operation:=(p_input->>'operationId')::uuid;
  -- Hash is replay identity only, not authentication. No context body in journal.
  fingerprint:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
  select input_hash into prior from public.customer_context_operations where user_id=p_user and operation_id=operation;
  if found then
   if prior<>fingerprint then return jsonb_build_object('code','CONFLICT'); end if;
   -- Never replay the write: a retry after later deletion must not resurrect it.
  else
   if exists(select 1 from public.customer_context_documents where id=ident and user_id<>p_user) then return jsonb_build_object('code','FORBIDDEN'); end if;
   if action='SAVE' then
    if p_input->>'kind' is null or p_input->>'kind' not in ('RESUME','JOB_DESCRIPTION','SUPPORTING','INSTRUCTIONS')
      or jsonb_typeof(p_input->'name') is distinct from 'string' or length(trim(p_input->>'name')) not between 1 and 120
      or jsonb_typeof(p_input->'body') is distinct from 'string' or octet_length(p_input->>'body') not between 1 and 120000 then
     return jsonb_build_object('code','INVALID'); end if;
    if (select count(*) from public.customer_context_documents where user_id=p_user and id<>ident)>=20 then return jsonb_build_object('code','CAPACITY'); end if;
    insert into public.customer_context_documents(id,user_id,kind,name,body) values(ident,p_user,p_input->>'kind',trim(p_input->>'name'),p_input->>'body')
     on conflict(id) do update set kind=excluded.kind,name=excluded.name,body=excluded.body,updated_at=clock_timestamp()
      where customer_context_documents.user_id=p_user;
   else
    delete from public.customer_context_documents where user_id=p_user and id=ident;
   end if;
   insert into public.customer_context_operations(user_id,operation_id,input_hash) values(p_user,operation,fingerprint);
  end if;
 elsif action='READ' then
  if jsonb_typeof(p_input->'ids') is distinct from 'array' or jsonb_array_length(p_input->'ids')>8 then return jsonb_build_object('code','INVALID'); end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_input->'ids');
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'name',name,'bytes',octet_length(body),'updatedAt',updated_at)
   ||case when action='READ' then jsonb_build_object('body',body) else '{}'::jsonb end order by updated_at desc,id),'[]')
 into documents from public.customer_context_documents where user_id=p_user and (action<>'READ' or id=any(ids));
 return jsonb_build_object('code','ACTIVE','documents',documents);
exception when invalid_text_representation then return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.customer_context_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.customer_context_command(uuid,uuid,jsonb) to service_role;
