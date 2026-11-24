-- A later migration made usage_grants.granted_ms immutable (trigger immutable_grant_identity), so the
-- earlier "remove minutes" update could never succeed. Reducing a customer's time is now recorded as
-- consumed time (spent_ms), which the trigger and the spent+reserved<=granted check both allow.
-- Real customer usage is counted from settlements (actual session time), so admin reductions are
-- never shown as the customer's own usage.

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

 create temporary table if not exists pg_temp.usage_rows(user_id uuid,run_id uuid,provider text,model text,started_at timestamptz,
   input_tokens bigint,output_tokens bigint,thinking_tokens bigint,audio_ms bigint) on commit drop;
 truncate pg_temp.usage_rows;
 insert into pg_temp.usage_rows
 select s.user_id,s.run_id,s.provider,s.model,s.started_at,
   coalesce((f.usage_metadata->>'inputTokens')::numeric,0)::bigint,
   coalesce((f.usage_metadata->>'outputTokens')::numeric,0)::bigint,
   greatest(0,coalesce((f.usage_metadata->>'totalTokens')::numeric,0)-coalesce((f.usage_metadata->>'inputTokens')::numeric,0)
     -coalesce((f.usage_metadata->>'outputTokens')::numeric,0))::bigint,
   coalesce((f.usage_metadata->>'audioWindowMilliseconds')::numeric,0)::bigint
 from cluera_private.ai_provider_usage_starts s
 left join cluera_private.ai_provider_usage_finishes f on f.operation_id=s.operation_id
 where p_subject is null or s.user_id=p_subject;

 if p_subject is null then
   select coalesce(jsonb_agg(jsonb_build_object('userId',x.user_id,'email',x.email,'state',x.state,'createdAt',x.created_at,
       'usedMs',x.used_ms,'activeNow',x.active_now,'lastActiveAt',x.last_active,
       'usage',(select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,
           'inputTokens',a.i,'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m)),'[]')
         from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m
           from pg_temp.usage_rows u where u.user_id=x.user_id group by 1,2) a))
     order by x.active_now desc,x.used_ms desc,x.created_at desc),'[]') into customers
   from (select c.user_id,u.email,c.state,c.created_at,
       coalesce((select sum(st.spent_ms) from public.customer_usage_settlements st where st.user_id=c.user_id),0)::bigint used_ms,
       exists(select 1 from public.customer_usage_runs r where r.user_id=c.user_id and r.state='ACTIVE') active_now,
       (select max(st.created_at) from public.customer_usage_settlements st where st.user_id=c.user_id) last_active
     from public.customer_accounts c join auth.users u on u.id=c.user_id
     order by 5 desc,c.created_at desc limit 100) x;
   select jsonb_build_object('customerCount',(select count(*) from public.customer_accounts),
       'activeNow',(select count(distinct user_id) from public.customer_usage_runs where state='ACTIVE'),
       'usedMs',coalesce((select sum(spent_ms) from public.customer_usage_settlements),0)::bigint,
       'usage',(select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,
           'inputTokens',a.i,'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m)),'[]')
         from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m
           from pg_temp.usage_rows group by 1,2) a)) into overall;
   return jsonb_build_object('code','ACTIVE','overall',overall,'customers',customers);
 end if;

 select jsonb_build_object('userId',c.user_id,'email',u.email,'state',c.state,'createdAt',c.created_at,
     'usedMs',coalesce((select sum(st.spent_ms) from public.customer_usage_settlements st where st.user_id=c.user_id),0)::bigint,
     'activeNow',exists(select 1 from public.customer_usage_runs r where r.user_id=c.user_id and r.state='ACTIVE'),
     'activeSince',(select min(r.created_at) from public.customer_usage_runs r where r.user_id=c.user_id and r.state='ACTIVE'),
     'sessionCount',(select count(*) from public.customer_usage_runs r where r.user_id=c.user_id),
     'lastActiveAt',(select max(st.created_at) from public.customer_usage_settlements st where st.user_id=c.user_id))
   into detail
   from public.customer_accounts c join auth.users u on u.id=c.user_id where c.user_id=p_subject;
 if detail is null then return jsonb_build_object('code','NOT_FOUND'); end if;

 select coalesce(sum(-(a.detail->>'adjustmentMilliseconds')::bigint),0) into reduced from public.account_admin_audit a
   where a.subject_id=p_subject and a.action in ('REDUCE_MINUTES','REMOVE_MINUTES');
 select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,'inputTokens',a.i,
     'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m,'firstAt',a.first_at,'lastAt',a.last_at)),'[]') into models
   from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m,
       min(started_at) first_at,max(started_at) last_at from pg_temp.usage_rows group by 1,2) a;
 select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,'inputTokens',a.i,
     'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m)),'[]') into models30
   from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m
       from pg_temp.usage_rows where started_at>now()-interval '30 days' group by 1,2) a;
 select coalesce(jsonb_agg(jsonb_build_object('runId',r.run_id,'startedAt',r.created_at,'state',r.state,
     'usedMs',coalesce((select sum(st.spent_ms) from public.customer_usage_settlements st where st.user_id=r.user_id and st.run_id=r.run_id),0)::bigint,
     'usage',(select coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'model',a.model,'calls',a.calls,'inputTokens',a.i,
         'outputTokens',a.o,'thinkingTokens',a.t,'audioMs',a.m)),'[]')
       from (select provider,model,count(*) calls,sum(input_tokens) i,sum(output_tokens) o,sum(thinking_tokens) t,sum(audio_ms) m
         from pg_temp.usage_rows u where u.run_id=r.run_id group by 1,2) a)) order by r.created_at desc),'[]') into sessions
   from (select * from public.customer_usage_runs where user_id=p_subject order by created_at desc limit 30) r;

 return jsonb_build_object('code','ACTIVE','customer',detail,'adminReducedMs',reduced,'models',models,'models30d',models30,'sessions',sessions);
end $function$;

create or replace function public.account_admin_adjust(p_actor uuid, p_session uuid, p_operation uuid, p_subject uuid, p_action text, p_reason text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
set lock_timeout to '2s'
set statement_timeout to '5s'
as $function$
declare prior public.account_admin_audit%rowtype; g public.customer_usage_grants%rowtype; amount bigint; ident uuid; before_ms bigint; t timestamptz;
 left_ms bigint; unused_total bigint; take bigint; touched jsonb:='[]';
begin
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 if p_operation is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 or p_input is null
   or p_action is null or p_action not in ('ADD_MINUTES','REMOVE_MINUTES','REDUCE_MINUTES','CATALOG') then return jsonb_build_object('code','INVALID'); end if;
 perform 1 from public.account_admin_profiles where user_id=p_actor for update;
 perform pg_advisory_xact_lock(hashtextextended(p_operation::text,912345));
 if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
 select * into prior from public.account_admin_audit where operation_id=p_operation;
 if found then
   if prior.actor_id<>p_actor or prior.subject_id is distinct from p_subject or prior.action<>p_action
     or prior.reason<>trim(p_reason) or prior.detail->'input' is distinct from p_input then return jsonb_build_object('code','CONFLICT'); end if;
   return jsonb_build_object('code','APPLIED');
 end if;
 if p_action='CATALOG' then
   if p_subject is not null or jsonb_typeof(p_input->'name') is distinct from 'string'
     or length(trim(p_input->>'name')) not between 2 and 80
     or jsonb_typeof(p_input->'enabled') is distinct from 'boolean'
     or coalesce(p_input->>'priority','') !~ '^[0-9]{1,4}$' then return jsonb_build_object('code','INVALID'); end if;
   if (p_input->>'priority')::integer>1000 then return jsonb_build_object('code','INVALID'); end if;
   update public.account_catalog_policy set display_name=trim(p_input->>'name'),enabled=(p_input->>'enabled')::boolean,
     priority=(p_input->>'priority')::integer,updated_at=clock_timestamp() where offer_code=p_input->>'code';
   if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
 else
   if coalesce(p_input->>'minutes','') !~ '^[1-9][0-9]{0,4}$' then return jsonb_build_object('code','INVALID'); end if;
   amount:=(p_input->>'minutes')::bigint*60000;
   if amount>3600000000 then return jsonb_build_object('code','INVALID'); end if;
   perform 1 from public.customer_accounts where user_id=p_subject for update;
   if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
   t:=clock_timestamp();
   if not public.account_admin_check(p_actor,p_session,true) then return jsonb_build_object('code','FORBIDDEN'); end if;
   if p_action='ADD_MINUTES' then
     insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at)
       values(p_subject,'admin-adjustment:'||p_operation,'PACK',amount,t) returning id into ident;
   elsif p_action='REDUCE_MINUTES' then
     perform 1 from public.customer_usage_grants where user_id=p_subject and kind<>'TRIAL' and state in ('ACTIVE','PAUSED')
       and (expires_at is null or expires_at>t or state='PAUSED') order by id for update;
     select coalesce(sum(granted_ms-spent_ms-reserved_ms),0) into unused_total from public.customer_usage_grants
       where user_id=p_subject and kind<>'TRIAL' and state in ('ACTIVE','PAUSED') and (expires_at is null or expires_at>t or state='PAUSED')
       and granted_ms-spent_ms-reserved_ms>0;
     if amount>unused_total then return jsonb_build_object('code','INSUFFICIENT_UNUSED'); end if;
     left_ms:=amount;
     for g in select * from public.customer_usage_grants where user_id=p_subject and kind<>'TRIAL' and state in ('ACTIVE','PAUSED')
       and (expires_at is null or expires_at>t or state='PAUSED') and granted_ms-spent_ms-reserved_ms>0
       order by granted_ms-spent_ms-reserved_ms desc,id loop
       exit when left_ms<=0;
       take:=least(left_ms,g.granted_ms-g.spent_ms-g.reserved_ms);
       update public.customer_usage_grants set spent_ms=spent_ms+take where id=g.id;
       left_ms:=left_ms-take;
       touched:=touched||jsonb_build_object('grantId',g.id,'milliseconds',take);
     end loop;
   else
     begin ident:=(p_input->>'grantId')::uuid; exception when invalid_text_representation then return jsonb_build_object('code','INVALID'); end;
     select * into g from public.customer_usage_grants where user_id=p_subject and id=ident for update;
     if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
     if g.kind='TRIAL' or g.state not in ('ACTIVE','PAUSED') or (g.expires_at is not null and g.expires_at<=t and g.state<>'PAUSED') then return jsonb_build_object('code','INVALID'); end if;
     before_ms:=g.granted_ms;
     if amount>g.granted_ms-g.spent_ms-g.reserved_ms then return jsonb_build_object('code','INSUFFICIENT_UNUSED'); end if;
     update public.customer_usage_grants set spent_ms=spent_ms+amount where id=g.id;
   end if;
 end if;
 insert into public.account_admin_audit(operation_id,actor_id,subject_id,action,reason,detail)
 values(p_operation,p_actor,p_subject,p_action,trim(p_reason),jsonb_build_object('input',p_input,'grantId',ident,
   'adjustmentMilliseconds',case when p_action in ('REMOVE_MINUTES','REDUCE_MINUTES') then -amount else amount end,'priorGrantedMilliseconds',before_ms,
   'source','ADMIN_ADJUSTMENT','reducedGrants',case when p_action='REDUCE_MINUTES' then touched else null end));
 return jsonb_build_object('code','APPLIED');
end $function$;
