-- AI cost tracking from the providers' own usage reports.
-- The relay records what each provider says it used (input, cached and output tokens, audio sent and the model that
-- actually answered). Each request is priced here with the providers' published prices, and both Admin screens read
-- the same priced rows. Safety monitoring only: nothing here limits or charges a customer, and no prompt, answer,
-- transcript or file is ever stored. Only requests recorded with a device (written by the updated relay) are
-- reported, because older rows lack the details a correct cost needs.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- 1. Where each request came from.
alter table cluera_private.ai_provider_usage_starts
  add column device text constraint ai_provider_usage_starts_device check (device in ('windows','web')),
  add column session_ref uuid;
create index ai_provider_usage_tracked_time on cluera_private.ai_provider_usage_starts(started_at desc) where device is not null;
create index ai_provider_usage_tracked_run on cluera_private.ai_provider_usage_starts(user_id,run_id) where device is not null;

-- 2. Audio of a live stream so far, saved about once a minute, so a running or interrupted stream still counts.
create table cluera_private.ai_provider_usage_progress (
  operation_id uuid primary key references cluera_private.ai_provider_usage_starts(operation_id),
  audio_ms integer not null check (audio_ms between 0 and 3600000),
  updated_at timestamptz not null default clock_timestamp()
);
alter table cluera_private.ai_provider_usage_progress enable row level security;
revoke all on cluera_private.ai_provider_usage_progress from public,anon,authenticated,service_role;

-- 3. Published prices in US dollars: per one million tokens, or per audio minute. A new price is a new row with its
-- start date (UTC), so past requests keep the price of their own day.
create table cluera_private.ai_price_book (
  provider text not null check (provider in ('gemini','deepgram','openai','anthropic')),
  model text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$'),
  effective_from date not null,
  long_above integer check (long_above > 0),
  input numeric(12,6) check (input >= 0),
  cached numeric(12,6) check (cached >= 0),
  cache_write numeric(12,6) check (cache_write >= 0),
  cache_write_long_ttl numeric(12,6) check (cache_write_long_ttl >= 0),
  output numeric(12,6) check (output >= 0),
  long_input numeric(12,6) check (long_input >= 0),
  long_cached numeric(12,6) check (long_cached >= 0),
  long_cache_write numeric(12,6) check (long_cache_write >= 0),
  long_cache_write_long_ttl numeric(12,6) check (long_cache_write_long_ttl >= 0),
  long_output numeric(12,6) check (long_output >= 0),
  audio_minute numeric(12,6) check (audio_minute >= 0),
  note text not null default '' check (char_length(note) <= 300),
  primary key (provider, model, effective_from),
  constraint ai_price_book_kind check ((audio_minute is not null) <> (input is not null and output is not null)),
  constraint ai_price_book_long check (long_above is null or (long_input is not null and long_output is not null))
);
alter table cluera_private.ai_price_book enable row level security;
revoke all on cluera_private.ai_price_book from public,anon,authenticated,service_role;

-- Providers' published prices, checked on 25 November 2026.
insert into cluera_private.ai_price_book(provider,model,effective_from,input,cached,output,note) values
 ('gemini','gemini-3.6-flash','2026-01-01',0.75,0.075,3.75,''),
 ('gemini','gemini-3.6-flash','2027-01-01',1.50,0.15,7.50,'Announced Google price from 1 January 2027'),
 ('gemini','gemini-3.8-flash','2026-01-01',0.75,0.075,3.75,''),
 ('gemini','gemini-3.8-flash','2027-01-01',1.50,0.15,7.50,'Announced Google price from 1 January 2027'),
 ('gemini','gemini-3.5-flash','2026-01-01',0.75,0.075,3.75,'Google routes 3.5 Flash to 3.6 Flash and gives no separate price, so it is priced as 3.6 Flash'),
 ('gemini','gemini-3.5-flash','2027-01-01',1.50,0.15,7.50,'Priced as 3.6 Flash'),
 ('gemini','gemini-3.5-flash-lite','2026-01-01',0.30,0.03,2.50,''),
 ('gemini','gemini-4-argon','2026-01-01',2.00,0.10,10.00,''),
 ('gemini','gemini-4-argon','2026-12-01',4.00,0.20,20.00,'Announced Google price from 1 December 2026');
insert into cluera_private.ai_price_book(provider,model,effective_from,long_above,input,cached,cache_write,cache_write_long_ttl,output,
  long_input,long_cached,long_cache_write,long_cache_write_long_ttl,long_output,note) values
 ('openai','gpt-6-luna','2026-01-01',272000,0.10,0.01,0.125,0.25,0.50,0.20,0.02,0.25,0.50,0.75,''),
 ('openai','gpt-6.1-terra','2026-01-01',272000,1.00,0.05,1.25,null,5.00,2.00,0.10,2.50,null,7.50,''),
 ('openai','gpt-5.6-terra','2026-01-01',272000,2.00,0.20,2.50,null,12.00,4.00,0.40,5.00,null,18.00,''),
 ('anthropic','claude-haiku-5-5','2026-01-01',100000,0.10,0.01,0.125,0.20,0.50,0.50,0.05,0.625,1.00,2.50,'US-only processing costs 10% more');
insert into cluera_private.ai_price_book(provider,model,effective_from,audio_minute,note) values
 ('deepgram','flux-general-en','2026-01-01',0.0065,'Deepgram promotional price; the list price was $0.0077'),
 ('deepgram','flux-general-multi','2026-01-01',0.0078,'');

-- A provider may answer with a numbered or dated version of a model ("-001", "-2026-09-15"). Only such endings count
-- as the same model, so "flash-lite" is never priced as "flash".
create function cluera_private.ai_price_model_matches(p_served text,p_model text) returns boolean
language sql immutable set search_path='' as $$
 select p_served=p_model or (pg_catalog.starts_with(p_served,p_model)
   and pg_catalog.substr(p_served,pg_catalog.length(p_model)+1) ~ '^-([0-9]{3}|[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2}|preview([-0-9]+)?|latest)$')
$$;
revoke all on function cluera_private.ai_price_model_matches(text,text) from public,anon,authenticated,service_role;

-- 4. One priced row per provider request. Both Admin screens read only this.
create view cluera_private.ai_usage_costed as
select s.operation_id,s.user_id,s.run_id,s.provider,s.model as requested_model,u.served_model,s.device,s.session_ref,s.started_at,
  f.finished_at,coalesce(f.outcome,'UNFINISHED') as outcome,u.input_tokens,u.cached_tokens,u.cache_write_tokens,
  u.cache_write_long_tokens,u.output_tokens,u.thinking_tokens,u.audio_ms,u.estimated,
  case when p.model is null then null else round((
    case when p.audio_minute is not null then u.audio_ms/60000.0*p.audio_minute else 0 end
    + case when p.input is null then 0 else (
        greatest(0,u.input_tokens-u.cached_tokens-u.cache_write_tokens)
          *(case when p.long_above is not null and u.input_tokens>p.long_above then p.long_input else p.input end)
        + u.cached_tokens*(case when p.long_above is not null and u.input_tokens>p.long_above
            then coalesce(p.long_cached,p.long_input) else coalesce(p.cached,p.input) end)
        + greatest(0,u.cache_write_tokens-u.cache_write_long_tokens)*(case when p.long_above is not null and u.input_tokens>p.long_above
            then coalesce(p.long_cache_write,p.long_input) else coalesce(p.cache_write,p.input) end)
        + least(u.cache_write_long_tokens,u.cache_write_tokens)*(case when p.long_above is not null and u.input_tokens>p.long_above
            then coalesce(p.long_cache_write_long_ttl,p.long_cache_write,p.long_input) else coalesce(p.cache_write_long_ttl,p.cache_write,p.input) end)
        + (u.output_tokens+u.thinking_tokens)*(case when p.long_above is not null and u.input_tokens>p.long_above then p.long_output else p.output end)
      )/1000000.0 end
   )*(case when s.provider='anthropic' and u.region='us' then 1.1 else 1 end),8) end as cost_usd
from cluera_private.ai_provider_usage_starts s
left join cluera_private.ai_provider_usage_finishes f on f.operation_id=s.operation_id
left join cluera_private.ai_provider_usage_progress g on g.operation_id=s.operation_id
cross join lateral (
  select coalesce(f.usage_metadata->>'servedModel',s.model) as served_model,
    coalesce((f.usage_metadata->>'inputTokens')::bigint,0) as input_tokens,
    coalesce((f.usage_metadata->>'cachedTokens')::bigint,0) as cached_tokens,
    coalesce((f.usage_metadata->>'cacheWriteTokens')::bigint,0) as cache_write_tokens,
    coalesce((f.usage_metadata->>'cacheWrite1hTokens')::bigint,0) as cache_write_long_tokens,
    coalesce((f.usage_metadata->>'outputTokens')::bigint,0) as output_tokens,
    -- Older receipts have no separate thinking count: it is what the total leaves over.
    coalesce((f.usage_metadata->>'thinkingTokens')::bigint,
      greatest(0,coalesce((f.usage_metadata->>'totalTokens')::bigint,0)-coalesce((f.usage_metadata->>'inputTokens')::bigint,0)
        -coalesce((f.usage_metadata->>'outputTokens')::bigint,0))) as thinking_tokens,
    -- Deepgram bills the audio it receives: what the relay sent, else the last saved progress, else what Deepgram reported.
    case when s.provider='deepgram' then coalesce((f.usage_metadata->>'audioSentMilliseconds')::bigint,g.audio_ms::bigint,
      (f.usage_metadata->>'audioWindowMilliseconds')::bigint,0) else 0 end as audio_ms,
    coalesce((f.usage_metadata->>'estimated')::boolean,false) as estimated,
    coalesce(f.usage_metadata->>'region','') as region
) u
left join lateral (
  select b.* from cluera_private.ai_price_book b
  where b.provider=s.provider and cluera_private.ai_price_model_matches(u.served_model,b.model)
    and b.effective_from<=(s.started_at at time zone 'UTC')::date
  order by length(b.model) desc,b.effective_from desc limit 1
) p on true
where s.device is not null;
revoke all on cluera_private.ai_usage_costed from public,anon,authenticated,service_role;

-- 5. Recording. The relay now records alongside the answer (never delaying or blocking it), so a retried write may
-- arrive a moment after the work ended: the run must belong to the customer and have been live in the last 10 minutes.
drop function public.cluera_provider_usage_start(uuid,uuid,text,text,uuid,integer);
create function public.cluera_provider_usage_start(p_operation uuid,p_run uuid,p_provider text,p_model text,p_credential uuid,p_revision integer,
  p_device text default null,p_session_ref uuid default null,p_started_ms_ago integer default 0)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare owner_id uuid;prior cluera_private.ai_provider_usage_starts;
begin
 if p_operation is null or p_run is null or p_provider is null or p_provider not in ('gemini','deepgram','openai','anthropic')
  or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$' or p_credential is null or p_revision is null or p_revision<1
  or (p_device is not null and p_device not in ('windows','web')) or p_started_ms_ago is null or p_started_ms_ago not between 0 and 3600000
  then return jsonb_build_object('code','INVALID');end if;
 select * into prior from cluera_private.ai_provider_usage_starts where operation_id=p_operation;
 if found then
  if (prior.run_id,prior.provider,prior.model,prior.credential_id,prior.revision) is distinct from (p_run,p_provider,p_model,p_credential,p_revision) then return jsonb_build_object('code','CONFLICT');end if;
  return jsonb_build_object('code','RECORDED','operationId',p_operation);
 end if;
 -- The trusted server supplies a coordinator UUID, never a browser ID.
 select r.user_id into owner_id from public.customer_usage_runs r where r.run_id=p_run and exists(
   select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id and w.expires_at>clock_timestamp()-interval '10 minutes');
 if not found or (select count(*) from public.customer_usage_runs where run_id=p_run)<>1 then return jsonb_build_object('code','DENIED');end if;
 insert into cluera_private.ai_provider_usage_starts(operation_id,user_id,run_id,provider,credential_id,revision,model,device,session_ref,started_at)
 values(p_operation,owner_id,p_run,p_provider,p_credential,p_revision,p_model,p_device,p_session_ref,
   clock_timestamp()-p_started_ms_ago*interval '1 millisecond') on conflict do nothing;
 select * into prior from cluera_private.ai_provider_usage_starts where operation_id=p_operation;
 if (prior.run_id,prior.provider,prior.model,prior.credential_id,prior.revision) is distinct from (p_run,p_provider,p_model,p_credential,p_revision) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','RECORDED','operationId',p_operation);
end$$;
revoke all on function public.cluera_provider_usage_start(uuid,uuid,text,text,uuid,integer,text,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.cluera_provider_usage_start(uuid,uuid,text,text,uuid,integer,text,uuid,integer) to service_role;

-- The finish receipt may carry the extra facts the providers report. Only these fields, only numbers and short names.
create or replace function public.cluera_provider_usage_finish(p_operation uuid,p_outcome text,p_elapsed_ms integer,p_usage jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare entry record;prior cluera_private.ai_provider_usage_finishes;
begin
 if p_operation is null or p_outcome is null or p_outcome not in ('SUCCEEDED','FAILED','CANCELLED','STOPPED')
 or p_elapsed_ms is null or p_elapsed_ms<0 or p_elapsed_ms>3600000 or p_usage is null or jsonb_typeof(p_usage)<>'object'
 or octet_length(p_usage::text)>2048 then return jsonb_build_object('code','INVALID');end if;
 for entry in select key,value from jsonb_each(p_usage) loop
  if entry.key='requestHash' then
   if jsonb_typeof(entry.value)<>'string' or (entry.value#>>'{}')!~'^[a-f0-9]{64}$' then return jsonb_build_object('code','INVALID');end if;
  elsif entry.key in ('inputTokens','outputTokens','cachedTokens','thinkingTokens','totalTokens','audioWindowMilliseconds',
    'audioSentMilliseconds','cacheWriteTokens','cacheWrite1hTokens') then
   if jsonb_typeof(entry.value)<>'number' or (entry.value#>>'{}')!~'^(0|[1-9][0-9]{0,9})$'
    or (entry.value#>>'{}')::numeric>1000000000 then return jsonb_build_object('code','INVALID');end if;
  elsif entry.key='servedModel' then
   if jsonb_typeof(entry.value)<>'string' or (entry.value#>>'{}')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$' then return jsonb_build_object('code','INVALID');end if;
  elsif entry.key in ('serviceTier','region') then
   if jsonb_typeof(entry.value)<>'string' or (entry.value#>>'{}')!~'^[A-Za-z0-9_-]{1,40}$' then return jsonb_build_object('code','INVALID');end if;
  elsif entry.key='estimated' then
   if jsonb_typeof(entry.value)<>'boolean' then return jsonb_build_object('code','INVALID');end if;
  else return jsonb_build_object('code','INVALID');end if;
 end loop;
 if not exists(select 1 from cluera_private.ai_provider_usage_starts where operation_id=p_operation) then return jsonb_build_object('code','NOT_FOUND');end if;
 insert into cluera_private.ai_provider_usage_finishes(operation_id,outcome,elapsed_ms,usage_metadata)
 values(p_operation,p_outcome,p_elapsed_ms,p_usage) on conflict do nothing;
 select * into prior from cluera_private.ai_provider_usage_finishes where operation_id=p_operation;
 if (prior.outcome,prior.elapsed_ms,prior.usage_metadata) is distinct from (p_outcome,p_elapsed_ms,p_usage) then return jsonb_build_object('code','CONFLICT');end if;
 return jsonb_build_object('code','RECORDED','operationId',p_operation);
end$$;

create function public.cluera_provider_usage_progress(p_operation uuid,p_audio_ms integer)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
begin
 if p_operation is null or p_audio_ms is null or p_audio_ms not between 0 and 3600000 then return jsonb_build_object('code','INVALID');end if;
 if not exists(select 1 from cluera_private.ai_provider_usage_starts where operation_id=p_operation and provider='deepgram') then return jsonb_build_object('code','NOT_FOUND');end if;
 if exists(select 1 from cluera_private.ai_provider_usage_finishes where operation_id=p_operation) then return jsonb_build_object('code','FINISHED');end if;
 insert into cluera_private.ai_provider_usage_progress as g(operation_id,audio_ms) values(p_operation,p_audio_ms)
 on conflict(operation_id) do update set audio_ms=greatest(g.audio_ms,excluded.audio_ms),updated_at=clock_timestamp();
 return jsonb_build_object('code','RECORDED','operationId',p_operation);
end$$;
revoke all on function public.cluera_provider_usage_progress(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.cluera_provider_usage_progress(uuid,integer) to service_role;

-- 6. The AI costs page: totals, each model, each customer, sessions (start, end, still running), days and the
-- price list. A session is a customer's consecutive connections from one device: a new one starts after a 5 minute
-- gap (30 minutes when the app says it is the same app session), or at once when the app session changes.
create function public.cluera_admin_ai_costs(p_actor uuid,p_session uuid,p_from timestamptz default null,p_to timestamptz default null,p_tz text default 'UTC')
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare report_zone text:='UTC'; since timestamptz:=coalesce(p_from,'-infinity'::timestamptz); upto timestamptz:=coalesce(p_to,'infinity'::timestamptz); report jsonb;
begin
 if public.account_admin_check(p_actor,p_session,true) is not true then return jsonb_build_object('code','FORBIDDEN');end if;
 if upto<=since then return jsonb_build_object('code','INVALID');end if;
 if p_tz is not null and char_length(p_tz)<=64 then
  begin
   perform now() at time zone p_tz; report_zone:=p_tz;
  exception when invalid_parameter_value then report_zone:='UTC';
  end;
 end if;

 with usage_rows as (
  select c.*,(c.cost_usd is null and c.input_tokens+c.output_tokens+c.thinking_tokens+c.audio_ms>0) as unpriced
  from cluera_private.ai_usage_costed c where c.started_at>=since and c.started_at<upto
 ),
 runs as (
  select r.user_id,r.run_id,r.created_at as started_at,min(s.device) as device,min(s.session_ref::text) as session_ref,
   r.state='ACTIVE' and exists(select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id
     and w.expires_at>now()-interval '60 seconds') as running,
   greatest(r.created_at,(select max(t.created_at) from public.customer_usage_settlements t where t.user_id=r.user_id and t.run_id=r.run_id),
     max(f.finished_at)) as last_at,
   coalesce((select sum(t.spent_ms) from public.customer_usage_settlements t where t.user_id=r.user_id and t.run_id=r.run_id),0)::bigint as billed_ms
  from cluera_private.ai_provider_usage_starts s
  join public.customer_usage_runs r on r.user_id=s.user_id and r.run_id=s.run_id
  left join cluera_private.ai_provider_usage_finishes f on f.operation_id=s.operation_id
  where s.device is not null and s.started_at>=since-interval '1 day' and s.started_at<upto+interval '1 day'
  group by r.user_id,r.run_id,r.created_at,r.state
 ),
 ordered as (
  select runs.*,lag(runs.last_at) over w as previous_last,lag(runs.session_ref) over w as previous_ref,lag(runs.running) over w as previous_running
  from runs window w as (partition by runs.user_id,runs.device order by runs.started_at,runs.run_id)
 ),
 marked as (
  select ordered.*,case
    when previous_last is null then 1
    when session_ref is not null and previous_ref is not null and session_ref<>previous_ref then 1
    when previous_running then 0
    when started_at-previous_last>(case when session_ref is not null and session_ref=previous_ref then interval '30 minutes' else interval '5 minutes' end) then 1
    else 0 end as new_session
  from ordered
 ),
 numbered as (
  select marked.*,sum(new_session) over (partition by user_id,device order by started_at,run_id) as session_number from marked
 ),
 sessions as (
  select user_id,device,session_number,min(started_at) as started_at,max(last_at) as last_at,bool_or(running) as running,sum(billed_ms)::bigint as billed_ms
  from numbered group by user_id,device,session_number
  having min(started_at)>=since and min(started_at)<upto
 ),
 session_usage as (
  select n.user_id,n.device,n.session_number,coalesce(sum(c.cost_usd),0) as cost_usd,
   count(*) filter (where c.provider<>'deepgram' and c.outcome='SUCCEEDED') as answers,coalesce(sum(c.audio_ms),0)::bigint as audio_ms,
   count(*) filter (where c.cost_usd is null and c.input_tokens+c.output_tokens+c.thinking_tokens+c.audio_ms>0) as unpriced,
   jsonb_agg(distinct c.served_model) as models
  from numbered n join cluera_private.ai_usage_costed c on c.user_id=n.user_id and c.run_id=n.run_id
  group by n.user_id,n.device,n.session_number
 ),
 session_rows as (
  select s.user_id,s.device,s.started_at,s.last_at,s.running,s.billed_ms,coalesce(u.cost_usd,0) as cost_usd,coalesce(u.answers,0) as answers,
   coalesce(u.audio_ms,0) as audio_ms,coalesce(u.unpriced,0) as unpriced,coalesce(u.models,'[]'::jsonb) as models,a.email
  from sessions s
  left join session_usage u on u.user_id=s.user_id and u.device=s.device and u.session_number=s.session_number
  left join auth.users a on a.id=s.user_id
 ),
 customer_usage as (
  select user_id,coalesce(sum(cost_usd),0) as cost_usd,count(*) filter (where provider<>'deepgram' and outcome='SUCCEEDED') as answers,
   coalesce(sum(audio_ms),0)::bigint as audio_ms,count(*) filter (where unpriced) as unpriced
  from usage_rows group by user_id
 ),
 customer_sessions as (
  select user_id,count(*) as sessions,coalesce(sum(billed_ms),0)::bigint as billed_ms,bool_or(running) as running,
   coalesce(sum(cost_usd),0) as cost_usd,max(started_at) as last_started
  from session_rows group by user_id
 ),
 customer_rows as (
  select ids.user_id,a.email,coalesce(u.cost_usd,0) as cost_usd,coalesce(u.answers,0) as answers,coalesce(u.audio_ms,0) as audio_ms,
   coalesce(u.unpriced,0) as unpriced,coalesce(s.sessions,0) as sessions,coalesce(s.billed_ms,0) as billed_ms,
   coalesce(s.cost_usd,0) as session_cost_usd,coalesce(s.running,false) as running,s.last_started
  from (select user_id from customer_usage union select user_id from customer_sessions) ids
  left join customer_usage u on u.user_id=ids.user_id
  left join customer_sessions s on s.user_id=ids.user_id
  left join auth.users a on a.id=ids.user_id
  order by coalesce(u.cost_usd,0) desc,a.email limit 100
 ),
 model_rows as (
  select provider,served_model,coalesce(jsonb_agg(distinct requested_model) filter (where requested_model<>served_model),'[]'::jsonb) as requested_as,
   count(*) as requests,count(*) filter (where provider<>'deepgram' and outcome='SUCCEEDED') as answers,
   count(*) filter (where provider<>'deepgram' and outcome<>'SUCCEEDED') as other_requests,
   sum(input_tokens)::bigint as input_tokens,sum(cached_tokens)::bigint as cached_tokens,sum(cache_write_tokens)::bigint as cache_write_tokens,
   sum(output_tokens+thinking_tokens)::bigint as output_tokens,sum(thinking_tokens)::bigint as thinking_tokens,sum(audio_ms)::bigint as audio_ms,
   coalesce(sum(cost_usd),0) as cost_usd,count(*) filter (where unpriced) as unpriced,count(*) filter (where estimated) as estimated
  from usage_rows group by provider,served_model
 ),
 day_rows as (
  select (started_at at time zone report_zone)::date as day,coalesce(sum(cost_usd),0) as cost_usd,
   count(*) filter (where provider<>'deepgram' and outcome='SUCCEEDED') as answers,sum(audio_ms)::bigint as audio_ms
  from usage_rows group by 1 order by 1 desc limit 62
 ),
 provider_day_rows as (
  select (started_at at time zone 'UTC')::date as day,provider,count(*) as requests,sum(input_tokens)::bigint as input_tokens,
   sum(cached_tokens)::bigint as cached_tokens,sum(output_tokens+thinking_tokens)::bigint as output_tokens,sum(audio_ms)::bigint as audio_ms,
   coalesce(sum(cost_usd),0) as cost_usd
  from usage_rows where started_at>now()-interval '14 days' group by 1,2
 )
 select jsonb_build_object(
  'code','ACTIVE','timeZone',report_zone,
  'trackingSince',(select min(started_at) from cluera_private.ai_provider_usage_starts where device is not null),
  'totals',jsonb_build_object(
    'costUsd',coalesce((select sum(cost_usd) from usage_rows),0),
    'answers',(select count(*) from usage_rows where provider<>'deepgram' and outcome='SUCCEEDED'),
    'otherRequests',(select count(*) from usage_rows where provider<>'deepgram' and outcome<>'SUCCEEDED'),
    'audioMs',coalesce((select sum(audio_ms) from usage_rows),0),
    'unpriced',(select count(*) from usage_rows where unpriced),
    'estimated',(select count(*) from usage_rows where estimated),
    'customers',(select count(distinct user_id) from usage_rows),
    'sessions',(select count(*) from session_rows),
    'sessionMs',coalesce((select sum(billed_ms) from session_rows),0),
    'sessionCostUsd',coalesce((select sum(cost_usd) from session_rows),0),
    'liveNow',(select count(distinct r.user_id) from public.customer_usage_runs r where r.state='ACTIVE' and exists(
      select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id and w.expires_at>now()-interval '60 seconds'))),
  'models',(select coalesce(jsonb_agg(jsonb_build_object('provider',m.provider,'model',m.served_model,'requestedAs',m.requested_as,
      'requests',m.requests,'answers',m.answers,'otherRequests',m.other_requests,'inputTokens',m.input_tokens,'cachedTokens',m.cached_tokens,
      'cacheWriteTokens',m.cache_write_tokens,'outputTokens',m.output_tokens,'thinkingTokens',m.thinking_tokens,'audioMs',m.audio_ms,
      'costUsd',m.cost_usd,'unpriced',m.unpriced,'estimated',m.estimated) order by m.cost_usd desc,m.requests desc),'[]'::jsonb) from model_rows m),
  'customers',(select coalesce(jsonb_agg(jsonb_build_object('userId',c.user_id,'email',c.email,'costUsd',c.cost_usd,'answers',c.answers,
      'audioMs',c.audio_ms,'unpriced',c.unpriced,'sessions',c.sessions,'sessionMs',c.billed_ms,'sessionCostUsd',c.session_cost_usd,
      'running',c.running,'lastSessionAt',c.last_started) order by c.cost_usd desc,c.email),'[]'::jsonb) from customer_rows c),
  'sessions',(select coalesce(jsonb_agg(x.item order by x.running desc,x.started_at desc),'[]'::jsonb) from (
      select s.running,s.started_at,jsonb_build_object('userId',s.user_id,'email',s.email,'device',s.device,'startedAt',s.started_at,
        'endedAt',case when s.running then null else s.last_at end,'running',s.running,'sessionMs',s.billed_ms,'costUsd',s.cost_usd,
        'answers',s.answers,'audioMs',s.audio_ms,'unpriced',s.unpriced,'models',s.models) as item
      from session_rows s order by s.running desc,s.started_at desc limit 100) x),
  'days',(select coalesce(jsonb_agg(jsonb_build_object('day',d.day,'costUsd',d.cost_usd,'answers',d.answers,'audioMs',d.audio_ms)
      order by d.day),'[]'::jsonb) from day_rows d),
  'providerDays',(select coalesce(jsonb_agg(jsonb_build_object('day',q.day,'provider',q.provider,'requests',q.requests,
      'inputTokens',q.input_tokens,'cachedTokens',q.cached_tokens,'outputTokens',q.output_tokens,'audioMs',q.audio_ms,'costUsd',q.cost_usd)
      order by q.day desc,q.provider),'[]'::jsonb) from provider_day_rows q),
  -- Today's price for each model, plus announced changes.
  'prices',(select coalesce(jsonb_agg(jsonb_build_object('provider',b.provider,'model',b.model,'from',b.effective_from,'longAbove',b.long_above,
      'input',b.input,'cached',b.cached,'cacheWrite',b.cache_write,'output',b.output,'longInput',b.long_input,'longOutput',b.long_output,
      'audioMinute',b.audio_minute,'note',b.note) order by b.provider,b.model,b.effective_from),'[]'::jsonb)
    from cluera_private.ai_price_book b
    where b.effective_from>(now() at time zone 'UTC')::date or not exists(select 1 from cluera_private.ai_price_book n
      where n.provider=b.provider and n.model=b.model and n.effective_from>b.effective_from and n.effective_from<=(now() at time zone 'UTC')::date))
 ) into report;
 return report;
end$$;
revoke all on function public.cluera_admin_ai_costs(uuid,uuid,timestamptz,timestamptz,text) from public,anon,authenticated;
grant execute on function public.cluera_admin_ai_costs(uuid,uuid,timestamptz,timestamptz,text) to service_role;

-- 7. The Customers tab uses the same priced rows, so both screens always agree. This is the report from
-- 20261124191500 (real use counted from settlements, time the Admin removed shown apart) with only the cost
-- source changed and "live now" requiring unexpired reserved time.
create or replace function public.cluera_admin_usage_report(p_actor uuid, p_session uuid, p_subject uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
set statement_timeout to '5s'
as $function$
declare customers jsonb:='[]'; overall jsonb; detail jsonb:='null'; models jsonb:='[]'; models30 jsonb:='[]'; sessions jsonb:='[]'; reduced bigint:=0;
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;

 -- One row per priced provider request (the same rows as the AI costs page).
 create temporary table if not exists pg_temp.priced_usage(user_id uuid,run_id uuid,provider text,model text,started_at timestamptz,
   input_tokens bigint,output_tokens bigint,thinking_tokens bigint,audio_ms bigint,cost_usd numeric,unpriced integer) on commit drop;
 truncate pg_temp.priced_usage;
 insert into pg_temp.priced_usage
 select c.user_id,c.run_id,c.provider,c.served_model,c.started_at,c.input_tokens,c.output_tokens,c.thinking_tokens,c.audio_ms,
   coalesce(c.cost_usd,0),case when c.cost_usd is null and c.input_tokens+c.output_tokens+c.thinking_tokens+c.audio_ms>0 then 1 else 0 end
 from cluera_private.ai_usage_costed c where p_subject is null or c.user_id=p_subject;

 if p_subject is null then
   select coalesce(jsonb_agg(jsonb_build_object('userId',x.user_id,'email',x.email,'state',x.state,'createdAt',x.created_at,
       'usedMs',x.used_ms,'activeNow',x.active_now,'lastActiveAt',x.last_active,
       'usage',(select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,
           'inputTokens',a.i,'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m,'costUsd',a.cost,'unpriced',a.missing)),'[]')
         from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m,sum(cost_usd) cost,sum(unpriced) missing
           from pg_temp.priced_usage u where u.user_id=x.user_id group by 1,2) a))
     order by x.active_now desc,x.used_ms desc,x.created_at desc),'[]') into customers
   from (select c.user_id,u.email,c.state,c.created_at,
       coalesce((select sum(st.spent_ms) from public.customer_usage_settlements st where st.user_id=c.user_id),0)::bigint used_ms,
       exists(select 1 from public.customer_usage_runs r where r.user_id=c.user_id and r.state='ACTIVE' and exists(select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id and w.expires_at>now()-interval '60 seconds')) active_now,
       (select max(st.created_at) from public.customer_usage_settlements st where st.user_id=c.user_id) last_active
     from public.customer_accounts c join auth.users u on u.id=c.user_id
     order by 5 desc,c.created_at desc limit 100) x;
   select jsonb_build_object('customerCount',(select count(*) from public.customer_accounts),
       'activeNow',(select count(distinct r.user_id) from public.customer_usage_runs r where r.state='ACTIVE' and exists(select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id and w.expires_at>now()-interval '60 seconds')),
       'usedMs',coalesce((select sum(spent_ms) from public.customer_usage_settlements),0)::bigint,
       'usage',(select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,
           'inputTokens',a.i,'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m,'costUsd',a.cost,'unpriced',a.missing)),'[]')
         from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m,sum(cost_usd) cost,sum(unpriced) missing
           from pg_temp.priced_usage group by 1,2) a)) into overall;
   return jsonb_build_object('code','ACTIVE','overall',overall,'customers',customers);
 end if;

 select jsonb_build_object('userId',c.user_id,'email',u.email,'state',c.state,'createdAt',c.created_at,
     'usedMs',coalesce((select sum(st.spent_ms) from public.customer_usage_settlements st where st.user_id=c.user_id),0)::bigint,
     'activeNow',exists(select 1 from public.customer_usage_runs r where r.user_id=c.user_id and r.state='ACTIVE' and exists(select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id and w.expires_at>now()-interval '60 seconds')),
     'activeSince',(select min(r.created_at) from public.customer_usage_runs r where r.user_id=c.user_id and r.state='ACTIVE' and exists(select 1 from public.customer_usage_windows w where w.user_id=r.user_id and w.run_id=r.run_id and w.expires_at>now()-interval '60 seconds')),
     'sessionCount',(select count(*) from public.customer_usage_runs r where r.user_id=c.user_id),
     'lastActiveAt',(select max(st.created_at) from public.customer_usage_settlements st where st.user_id=c.user_id))
   into detail
   from public.customer_accounts c join auth.users u on u.id=c.user_id where c.user_id=p_subject;
 if detail is null then return jsonb_build_object('code','NOT_FOUND'); end if;

 select coalesce(sum(-(a.detail->>'adjustmentMilliseconds')::bigint),0) into reduced from public.account_admin_audit a
   where a.subject_id=p_subject and a.action in ('REDUCE_MINUTES','REMOVE_MINUTES');
 select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,'inputTokens',a.i,
     'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m,'costUsd',a.cost,'unpriced',a.missing,'firstAt',a.first_at,'lastAt',a.last_at)),'[]') into models
   from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m,sum(cost_usd) cost,sum(unpriced) missing,
       min(started_at) first_at,max(started_at) last_at from pg_temp.priced_usage group by 1,2) a;
 select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,'inputTokens',a.i,
     'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m,'costUsd',a.cost,'unpriced',a.missing)),'[]') into models30
   from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m,sum(cost_usd) cost,sum(unpriced) missing
       from pg_temp.priced_usage where started_at>now()-interval '30 days' group by 1,2) a;
 select coalesce(jsonb_agg(jsonb_build_object('runId',r.run_id,'startedAt',r.created_at,'state',r.state,
     'usedMs',coalesce((select sum(st.spent_ms) from public.customer_usage_settlements st where st.user_id=r.user_id and st.run_id=r.run_id),0)::bigint,
     'usage',(select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,'inputTokens',a.i,
         'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m,'costUsd',a.cost,'unpriced',a.missing)),'[]')
       from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m,sum(cost_usd) cost,sum(unpriced) missing
         from pg_temp.priced_usage u where u.run_id=r.run_id group by 1,2) a)) order by r.created_at desc),'[]') into sessions
   from (select * from public.customer_usage_runs where user_id=p_subject order by created_at desc limit 30) r;

 return jsonb_build_object('code','ACTIVE','customer',detail,'adminReducedMs',reduced,'models',models,'models30d',models30,'sessions',sessions);
end $function$;

revoke all on function public.cluera_admin_usage_report(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.cluera_admin_usage_report(uuid,uuid,uuid) to service_role;

commit;
