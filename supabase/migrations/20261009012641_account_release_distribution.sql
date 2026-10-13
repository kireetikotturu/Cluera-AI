-- Separate account TEST product only. No legacy release/financial tables changed.
create table public.account_releases (
 id uuid primary key,
 version text not null unique,
 payload jsonb not null,
 state text not null default 'DRAFT' check(state in ('DRAFT','PUBLISHED','WITHDRAWN')),
 created_at timestamptz not null default clock_timestamp(),
 published_at timestamptz,
 check(jsonb_typeof(payload)='object'),
 check(state='DRAFT' or published_at is not null)
);
create index account_releases_latest on public.account_releases(published_at desc,id) where state='PUBLISHED';
alter table public.account_releases enable row level security;
revoke all on public.account_releases from public,anon,authenticated,service_role;

create function public.account_release_latest() returns jsonb
language sql security definer set search_path='' as $$
 select payload || jsonb_build_object('id',id,'state',state,'publishedAt',published_at)
 from public.account_releases where state='PUBLISHED' order by published_at desc,id limit 1;
$$;
revoke all on function public.account_release_latest() from public,anon,authenticated;
grant execute on function public.account_release_latest() to service_role;

create function public.account_release_admin(p_actor uuid,p_session uuid,p_action text,
 p_operation uuid default null,p_reason text default null,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare prior public.account_admin_audit; r public.account_releases; latest public.account_releases;
 ident uuid; v text; minv text; result jsonb; detail jsonb;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_action='LIST' then
  return jsonb_build_object('code','ACTIVE','releases',coalesce((select jsonb_agg(x.data) from (
   select payload||jsonb_build_object('id',id,'state',state,'publishedAt',published_at) data
   from public.account_releases order by created_at desc,id limit 50) x),'[]'::jsonb));
 end if;
 if p_action not in ('DRAFT','PUBLISH','WITHDRAW') or p_operation is null or p_reason is null
  or length(trim(p_reason)) not between 10 and 500 or jsonb_typeof(p_input) is distinct from 'object'
 then return jsonb_build_object('code','INVALID'); end if;
 -- One product-wide lock serializes approvals across administrators and versions.
 perform pg_advisory_xact_lock(1936879982,1094927188);
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
  if prior.actor_id=p_actor and prior.action='RELEASE_'||p_action and prior.reason=trim(p_reason)
    and prior.detail->'input'=p_input then return jsonb_build_object('code','APPLIED','releaseId',prior.detail->'releaseId'); end if;
  return jsonb_build_object('code','CONFLICT');
 end if;
 if p_action='DRAFT' then
  if (p_input-array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])<>'{}'::jsonb
   or not(p_input ?& array['version','downloadUrl','sha256','minimumSupportedVersion','updateType','fileSizeBytes','releaseNotes'])
   then return jsonb_build_object('code','INVALID'); end if;
  v:=p_input->>'version'; minv:=p_input->>'minimumSupportedVersion';
  if v !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
   or minv !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
   or string_to_array(minv,'.')::bigint[]>string_to_array(v,'.')::bigint[]
   or p_input->>'sha256' !~ '^[a-f0-9]{64}$' or p_input->>'updateType' not in ('OPTIONAL','RECOMMENDED','REQUIRED')
   or jsonb_typeof(p_input->'fileSizeBytes')<>'number' or (p_input->>'fileSizeBytes')::bigint not between 1 and 536870912
   or jsonb_typeof(p_input->'releaseNotes')<>'string' or length(p_input->>'releaseNotes')>2000
   or p_input->>'downloadUrl' !~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/SigmaRoundAccountTestSetup-[0-9.]+\.exe$'
   or right(p_input->>'downloadUrl',length('/SigmaRoundAccountTestSetup-'||v||'.exe'))<>'/SigmaRoundAccountTestSetup-'||v||'.exe'
   or exists(select 1 from jsonb_each(p_input) e where e.value='null'::jsonb)
  then return jsonb_build_object('code','INVALID'); end if;
  if exists(select 1 from public.account_releases where version=v) then return jsonb_build_object('code','CONFLICT'); end if;
  ident:=p_operation;
  insert into public.account_releases(id,version,payload) values(ident,v,p_input);
 else
  ident:=(p_input->>'id')::uuid;
  select * into r from public.account_releases where id=ident for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if p_action='PUBLISH' then
   if (p_input-array['id','verifiedHostedSha256','verifiedFileSizeBytes','confirmedAccountInstaller'])<>'{}'::jsonb
    or p_input->>'verifiedHostedSha256' is distinct from r.payload->>'sha256'
    or p_input->'verifiedFileSizeBytes' is distinct from r.payload->'fileSizeBytes'
    or p_input->'confirmedAccountInstaller' is distinct from 'true'::jsonb or r.state<>'DRAFT'
   then return jsonb_build_object('code','INVALID'); end if;
   -- Never downgrade a previously published account version, even after withdrawal.
   select * into latest from public.account_releases where published_at is not null
    order by string_to_array(version,'.')::bigint[] desc limit 1;
   if found and string_to_array(r.version,'.')::bigint[]<=string_to_array(latest.version,'.')::bigint[]
    then return jsonb_build_object('code','CONFLICT'); end if;
   update public.account_releases set state='PUBLISHED',published_at=clock_timestamp() where id=ident;
  else
   if p_input- 'id'<>'{}'::jsonb or r.state<>'PUBLISHED' then return jsonb_build_object('code','INVALID'); end if;
   update public.account_releases set state='WITHDRAWN' where id=ident;
  end if;
 end if;
 detail:=jsonb_build_object('input',p_input,'releaseId',ident);
 insert into public.account_admin_audit(operation_id,actor_id,action,reason,detail)
  values(p_operation,p_actor,'RELEASE_'||p_action,trim(p_reason),detail);
 return jsonb_build_object('code','APPLIED','releaseId',ident);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then
 return jsonb_build_object('code','INVALID');
end $$;
revoke all on function public.account_release_admin(uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_release_admin(uuid,uuid,text,uuid,text,jsonb) to service_role;
