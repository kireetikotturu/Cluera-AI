-- Résumés used in sessions, kept for the Admin "Data" section.
-- Files are compressed by the server and kept in a private storage bucket that only the server can read. Every access
-- goes through the functions below: customers can only add their own résumé (after their sign-in is checked), and the
-- Admin (verified, with the authenticator step) can list, open and delete. Each view, download and delete is recorded
-- in the Admin history.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table public.customer_resumes(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.customer_accounts(user_id) on delete cascade,
 -- SHA-256 of the original file (or of the typed text): the same résumé used again is kept once.
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 name text not null check(char_length(name) between 1 and 200),
 kind text not null check(kind in ('PDF','DOCX','TEXT','MARKDOWN','TYPED')),
 original_bytes integer not null check(original_bytes between 1 and 20971520),
 stored_bytes integer not null default 0 check(stored_bytes between 0 and 20971520),
 storage_path text check(storage_path is null or char_length(storage_path) between 1 and 200),
 compression text not null default 'text' check(compression in ('text','original','pdf-pages','docx-repacked')),
 text_content text not null default '' check(char_length(text_content)<=100000),
 state text not null check(state in ('PENDING','STORED')),
 source text not null check(source in ('phone','windows')),
 session_refs uuid[] not null default '{}' check(cardinality(session_refs)<=200),
 created_at timestamptz not null default clock_timestamp(),
 last_used_at timestamptz not null default clock_timestamp(),
 unique(user_id,content_hash),
 constraint customer_resumes_file check(state='PENDING' or compression='text' or storage_path is not null)
);
create index customer_resumes_recent on public.customer_resumes(last_used_at desc,id desc) where state='STORED';
alter table public.customer_resumes enable row level security;
revoke all on public.customer_resumes from public,anon,authenticated,service_role;

-- A private bucket for the compressed files. No storage policy is added, so only the server's service key can reach it.
do $$begin
 if to_regclass('storage.buckets') is not null then
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('customer-resumes','customer-resumes',false,20971520,
    array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
 end if;
end$$;

-- 1. A session was created with a résumé. Text résumés are saved at once; files answer "upload" until their
-- compressed copy is stored.
create function public.customer_resume_begin(p_user uuid,p_session uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb; v_hash text; v_name text; v_kind text; v_source text; v_text text; v_ref uuid; v_bytes integer;
 entry public.customer_resumes; is_file boolean; stale jsonb:='[]'::jsonb;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' then return jsonb_build_object('code','INVALID'); end if;
 v_hash:=p_input->>'hash'; v_name:=trim(p_input->>'name'); v_kind:=p_input->>'kind'; v_source:=p_input->>'source'; v_text:=coalesce(p_input->>'text','');
 if coalesce(v_hash,'') !~ '^[a-f0-9]{64}$' or v_name is null or char_length(v_name) not between 1 and 200
   or v_kind is null or v_kind not in ('PDF','DOCX','TEXT','MARKDOWN','TYPED') or v_source is null or v_source not in ('phone','windows')
   or coalesce(p_input->>'bytes','') !~ '^[1-9][0-9]{0,7}$' or char_length(v_text)>100000 then return jsonb_build_object('code','INVALID'); end if;
 v_bytes:=(p_input->>'bytes')::integer;
 is_file:=v_kind in ('PDF','DOCX');
 if v_bytes>20971520 or (not is_file and btrim(v_text)='') then return jsonb_build_object('code','INVALID'); end if;
 if coalesce(p_input->>'sessionRef','')<>'' then v_ref:=(p_input->>'sessionRef')::uuid; end if;
 select * into entry from public.customer_resumes where user_id=p_user and content_hash=v_hash for update;
 if not found then
  -- An upload that never finished is forgotten after a day, and only the two newest unfinished ones are kept
  -- alongside this one; the server removes their leftover files.
  with dropped as (delete from public.customer_resumes where user_id=p_user and state='PENDING' and (created_at<clock_timestamp()-interval '1 day'
    or id in (select o.id from public.customer_resumes o where o.user_id=p_user and o.state='PENDING' order by o.created_at desc,o.id offset 2)) returning id)
  select coalesce(jsonb_agg(id),'[]'::jsonb) into stale from dropped;
  -- Guards for the storage space: at most 100 different résumés per account, and 40 MB of files. Past that,
  -- a new résumé is still saved, as its text.
  if (select count(*) from public.customer_resumes where user_id=p_user)>=100 then return jsonb_build_object('code','LIMIT','stale',stale); end if;
  if is_file and v_bytes+(select coalesce(sum(case when state='PENDING' then original_bytes when storage_path is not null then stored_bytes else 0 end),0)
    from public.customer_resumes where user_id=p_user)>41943040 then is_file:=false; end if;
  insert into public.customer_resumes(user_id,content_hash,name,kind,original_bytes,stored_bytes,text_content,state,source,session_refs)
  values(p_user,v_hash,v_name,v_kind,v_bytes,case when is_file then 0 else octet_length(v_text) end,v_text,
    case when is_file then 'PENDING' else 'STORED' end,v_source,case when v_ref is null then '{}'::uuid[] else array[v_ref] end)
  on conflict(user_id,content_hash) do nothing;
  select * into entry from public.customer_resumes where user_id=p_user and content_hash=v_hash for update;
 else
  update public.customer_resumes set last_used_at=clock_timestamp(),source=v_source,
    text_content=case when text_content='' then v_text else text_content end,
    session_refs=case when v_ref is null or v_ref=any(session_refs) or cardinality(session_refs)>=200 then session_refs else array_append(session_refs,v_ref) end
  where id=entry.id returning * into entry;
 end if;
 return jsonb_build_object('code','ACTIVE','id',entry.id,'upload',entry.state='PENDING','stale',stale);
exception when invalid_text_representation or check_violation or string_data_right_truncation then return jsonb_build_object('code','INVALID');
end $$;

-- 2. What the customer said they would upload, to check the received file against.
create function public.customer_resume_pending(p_user uuid,p_session uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb; entry public.customer_resumes;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 select * into entry from public.customer_resumes where id=p_id and user_id=p_user;
 if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
 if entry.state='STORED' then return jsonb_build_object('code','STORED'); end if;
 return jsonb_build_object('code','ACTIVE','hash',entry.content_hash,'bytes',entry.original_bytes,'kind',entry.kind);
end $$;

-- 3. The compressed file is stored.
create function public.customer_resume_stored(p_user uuid,p_session uuid,p_id uuid,p_path text,p_bytes integer,p_compression text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 if p_id is null or p_path is null or p_path not like p_user::text||'/'||p_id::text||'.%' or p_bytes is null or p_bytes not between 1 and 20971520
   or p_compression is null or p_compression not in ('original','pdf-pages','docx-repacked') then return jsonb_build_object('code','INVALID'); end if;
 update public.customer_resumes set storage_path=p_path,stored_bytes=p_bytes,compression=p_compression,state='STORED'
 where id=p_id and user_id=p_user and state='PENDING';
 if not found and not exists(select 1 from public.customer_resumes where id=p_id and user_id=p_user and state='STORED') then return jsonb_build_object('code','NOT_FOUND'); end if;
 return jsonb_build_object('code','ACTIVE');
end $$;

-- 4. A received file that did not match is not kept.
create function public.customer_resume_discard(p_user uuid,p_session uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare authority jsonb;
begin
 authority:=public.customer_authorize(p_user,p_session);
 if authority->>'code' is distinct from 'ACTIVE' then return authority; end if;
 delete from public.customer_resumes where id=p_id and user_id=p_user and state='PENDING';
 return jsonb_build_object('code','ACTIVE');
end $$;

-- 5. Admin: stored résumés, newest first, 50 at a time, searchable by e-mail or file name. No text in the list.
create function public.cluera_admin_resumes(p_actor uuid,p_session uuid,p_query text default '',p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare wanted text:=btrim(coalesce(p_query,'')); pattern text;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if char_length(wanted)>200 or (p_before is null)<>(p_before_id is null) then return jsonb_build_object('code','INVALID'); end if;
 pattern:='%'||replace(replace(replace(wanted,'\','\\'),'%','\%'),'_','\_')||'%';
 return jsonb_build_object('code','ACTIVE',
  'totals',(select jsonb_build_object('resumes',count(*),'customers',count(distinct user_id),
     'files',count(*) filter (where storage_path is not null),
     'fileBytes',coalesce(sum(stored_bytes) filter (where storage_path is not null),0),
     'originalFileBytes',coalesce(sum(original_bytes) filter (where storage_path is not null),0),
     'textBytes',coalesce(sum(octet_length(text_content)),0))
    from public.customer_resumes where state='STORED'),
  'rows',(select coalesce(jsonb_agg(x.item order by x.last_used_at desc,x.id desc),'[]'::jsonb) from (
    select r.id,r.last_used_at,jsonb_build_object('id',r.id,'userId',r.user_id,'email',u.email,'name',r.name,'kind',r.kind,
      'originalBytes',r.original_bytes,'storedBytes',r.stored_bytes,'compression',r.compression,'hasFile',r.storage_path is not null,
      'source',r.source,'sessions',greatest(1,cardinality(r.session_refs)),'createdAt',r.created_at,'lastUsedAt',r.last_used_at) as item
    from public.customer_resumes r left join auth.users u on u.id=r.user_id
    where r.state='STORED' and (wanted='' or r.name ilike pattern or u.email ilike pattern)
      and (p_before is null or (r.last_used_at,r.id)<(p_before,p_before_id))
    order by r.last_used_at desc,r.id desc limit 50) x));
end $$;

-- 6. Admin opens one résumé: its text, or where its file is. Viewing and downloading are recorded in History.
create function public.cluera_admin_resume_open(p_actor uuid,p_session uuid,p_id uuid,p_mode text,p_operation uuid default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare entry public.customer_resumes;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_mode is null or p_mode not in ('TEXT','FILE','PATH') or (p_mode<>'PATH' and p_operation is null) then return jsonb_build_object('code','INVALID'); end if;
 select * into entry from public.customer_resumes where id=p_id and state='STORED';
 if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
 if p_mode<>'PATH' then
  insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
  values(p_operation,p_actor,entry.user_id,case when p_mode='TEXT' then 'RESUME_VIEW' else 'RESUME_DOWNLOAD' end,
    'Opened from the Admin Data section',jsonb_build_object('resumeId',entry.id,'name',entry.name))
  on conflict(operation_id) do nothing;
  if not found then return jsonb_build_object('code','CONFLICT'); end if;
 end if;
 return jsonb_build_object('code','ACTIVE','userId',entry.user_id,'name',entry.name,'kind',entry.kind,
   'storagePath',case when p_mode='TEXT' then null else entry.storage_path end,
   'text',case when p_mode='TEXT' or (p_mode='FILE' and entry.storage_path is null) then entry.text_content end);
end $$;

-- 7. Admin deletes a résumé (the server removes its file first). Recorded in History with the reason.
create function public.cluera_admin_resume_delete(p_actor uuid,p_session uuid,p_operation uuid,p_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare entry public.customer_resumes; prior public.account_admin_audit%rowtype;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_operation is null or p_id is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 then return jsonb_build_object('code','INVALID'); end if;
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
  if prior.actor_id=p_actor and prior.action='RESUME_DELETE' and prior.detail->>'resumeId'=p_id::text then return jsonb_build_object('code','APPLIED'); end if;
  return jsonb_build_object('code','CONFLICT');
 end if;
 delete from public.customer_resumes where id=p_id returning * into entry;
 if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
 insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
 values(p_operation,p_actor,entry.user_id,'RESUME_DELETE',trim(p_reason),jsonb_build_object('resumeId',entry.id,'name',entry.name,'kind',entry.kind));
 return jsonb_build_object('code','APPLIED');
end $$;

revoke all on function public.customer_resume_begin(uuid,uuid,jsonb),public.customer_resume_pending(uuid,uuid,uuid),
 public.customer_resume_stored(uuid,uuid,uuid,text,integer,text),public.customer_resume_discard(uuid,uuid,uuid),
 public.cluera_admin_resumes(uuid,uuid,text,timestamptz,uuid),public.cluera_admin_resume_open(uuid,uuid,uuid,text,uuid),
 public.cluera_admin_resume_delete(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.customer_resume_begin(uuid,uuid,jsonb),public.customer_resume_pending(uuid,uuid,uuid),
 public.customer_resume_stored(uuid,uuid,uuid,text,integer,text),public.customer_resume_discard(uuid,uuid,uuid),
 public.cluera_admin_resumes(uuid,uuid,text,timestamptz,uuid),public.cluera_admin_resume_open(uuid,uuid,uuid,text,uuid),
 public.cluera_admin_resume_delete(uuid,uuid,uuid,uuid,text) to service_role;

commit;
