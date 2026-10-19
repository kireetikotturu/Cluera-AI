-- UNAPPLIED companion to cluera-native-recurring.sql. No financial activation.
-- Installs a default-disabled usage bridge. The existing function is preserved
-- under a private name; non-native accounts execute that exact previous body.
begin;
create function cluera_billing_private.native_action(p_schedule jsonb,p_sub text,p_at bigint)returns jsonb
language plpgsql immutable security invoker set search_path=''as $$declare actions jsonb;begin
 select coalesce(jsonb_agg(v),'[]')into actions from jsonb_array_elements(p_schedule->'actions')v where v->>'subscriptionId'<>p_sub or v->>'kind'<>'RESCHEDULE';
 actions:=actions||jsonb_build_array(jsonb_build_object('key',p_sub||':RESCHEDULE:'||p_at,'subscriptionId',p_sub,'kind','RESCHEDULE','at',p_at));
 return jsonb_set(p_schedule,'{actions}',actions);
end$$;

create function cluera_billing_private.native_stop(p_schedule jsonb,p_sub text,p_at bigint)returns jsonb
language plpgsql immutable security invoker set search_path=''as $$declare v jsonb;idx integer;actions jsonb;begin
 select value,ordinality::integer-1 into strict v,idx from jsonb_array_elements(p_schedule->'subscriptions')with ordinality where value->>'subscriptionId'=p_sub;
 v:=v||jsonb_build_object('stopRequestedAt',coalesce((v->>'stopRequestedAt')::bigint,p_at),'graceUntil',null);
 p_schedule:=jsonb_set(p_schedule,array['subscriptions',idx::text],v);
 select coalesce(jsonb_agg(x),'[]')into actions from jsonb_array_elements(p_schedule->'actions')x where x->>'subscriptionId'<>p_sub or x->>'kind'<>'RESCHEDULE';
 if not exists(select 1 from jsonb_array_elements(actions)x where x->>'key'=p_sub||':CANCEL_FUTURE:end')then
 actions:=actions||jsonb_build_array(jsonb_build_object('key',p_sub||':CANCEL_FUTURE:end','subscriptionId',p_sub,'kind','CANCEL_FUTURE','at',null));end if;
 return jsonb_set(p_schedule,'{actions}',actions);
end$$;

-- Time advancement has no new invoice, allowance or provider-state input.
-- Exact expiry/resume anchors mirror the checked native TypeScript policy.
create function cluera_billing_private.native_advance(p_user uuid,p_schedule jsonb,p_at bigint)returns jsonb
language plpgsql security invoker set search_path=''as $$
declare result jsonb:=p_schedule;v jsonb;s jsonb;last_term jsonb;row_value record;idx integer;cursor_at bigint;target bigint;
 count_value integer;hold boolean;queued boolean;g uuid;active_tier boolean;begin
 select coalesce(max((x->>'closedAt')::bigint),(p_schedule->>'at')::bigint)into cursor_at from jsonb_array_elements(result->'terms')x;
 for count_value in 0..jsonb_array_length(result->'terms')loop
 select value,ordinality::integer-1 into v,idx from jsonb_array_elements(result->'terms')with ordinality where value->>'state'in('ACTIVE','SUSPENDED');
 if v is not null then
 if(v->>'endsAt')::bigint>p_at then exit;end if;
 select x into strict s from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 if s->>'state'='PAST_DUE'and s->>'stopRequestedAt'is null and(s->>'paidThrough')::bigint=(v->>'periodEnd')::bigint
 and(s->>'graceUntil')::bigint>(v->>'endsAt')::bigint then
 v:=jsonb_set(v,'{endsAt}',s->'graceUntil');result:=jsonb_set(result,array['terms',idx::text],v);
 if(v->>'endsAt')::bigint>p_at then exit;end if;end if;
 cursor_at:=(v->>'endsAt')::bigint;
 select grant_id into g from cluera_billing_private.payments where invoice_id=v->>'invoiceId'and user_id=p_user;
 if g is not null then perform public.customer_recurring_stop_grant(p_user,g,to_timestamp(cursor_at::numeric/1000));end if;
 v:=v||jsonb_build_object('state','ENDED','closedAt',cursor_at,'remainingWallMs',null);
 result:=jsonb_set(result,array['terms',idx::text],v);
 end if;
 select value,ordinality::integer-1 into v,idx from jsonb_array_elements(result->'terms')with ordinality where value->>'state'in('QUEUED','PRESERVED')
 order by case when value->>'offerCode'='cluera_monthly_200h_v2'then 0 else 1 end,case when value->>'state'='PRESERVED'then 0 else 1 end,(value->>'sequence')::bigint limit 1;
 if v is null then exit;end if;
 if v->>'offerCode'<>'cluera_monthly_200h_v2'then
 hold:=false;
 for s in select *from jsonb_array_elements(result->'subscriptions')x where x->>'offerCode'='cluera_monthly_200h_v2'loop
 select x into last_term from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=s->>'subscriptionId'order by(x->>'periodStart')::bigint desc,(x->>'sequence')::bigint desc limit 1;
 if last_term is null then continue;end if;
 if last_term->>'state'='REFUNDED'then cursor_at:=greatest(cursor_at,(last_term->>'closedAt')::bigint);continue;end if;
 if s->>'state'in('ACTIVE','PAUSED')then hold:=true;exit;
 elsif s->>'state'='PAST_DUE'then
 if s->>'graceUntil'is null or(s->>'graceUntil')::bigint>p_at then hold:=true;exit;end if;
 cursor_at:=greatest(cursor_at,(s->>'graceUntil')::bigint);
 else cursor_at:=greatest(cursor_at,(s->>'cancellationAt')::bigint);end if;
 end loop;
 if hold then exit;end if;
 end if;
 cursor_at:=greatest(cursor_at,(v->>'periodStart')::bigint);if cursor_at>p_at then exit;end if;
 queued:=v->>'state'='QUEUED';select x into strict s from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=v->>'subscriptionId';
 target:=cursor_at+(v->>'remainingWallMs')::bigint;
 v:=v||jsonb_build_object('state',case when s->>'state'='PAUSED'then 'SUSPENDED'else 'ACTIVE'end,'startsAt',cursor_at,'endsAt',target,'remainingWallMs',null);
 result:=jsonb_set(result,array['terms',idx::text],v);
 if queued and s->>'stopRequestedAt'is null and target<>(v->>'periodEnd')::bigint then result:=cluera_billing_private.native_action(result,v->>'subscriptionId',target);end if;
 end loop;
 select x into v from jsonb_array_elements(result->'terms')x where x->>'state'in('ACTIVE','SUSPENDED');
 if v is not null then
 active_tier:=v->>'offerCode'='cluera_monthly_200h_v2';cursor_at:=(v->>'endsAt')::bigint;
 for row_value in select x from jsonb_array_elements(result->'terms')x where x->>'state'='QUEUED'and(x->>'offerCode'='cluera_monthly_200h_v2')=active_tier order by(x->>'sequence')::bigint loop
 cursor_at:=greatest(cursor_at,(row_value.x->>'periodStart')::bigint)+(row_value.x->>'remainingWallMs')::bigint;
 select x into strict s from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=row_value.x->>'subscriptionId';
 if s->>'stopRequestedAt'is null and s->>'subscriptionId'<>v->>'subscriptionId'then result:=cluera_billing_private.native_action(result,s->>'subscriptionId',cursor_at);end if;
 end loop;end if;
 return cluera_billing_private.native_live(p_user,result,to_timestamp(p_at::numeric/1000));
end$$;

-- Independent SQL implementation of the allowed canonical receipt transition.
-- Commit compares the ENTIRE proposed state with this result before writing.
create function cluera_billing_private.native_expected(p_user uuid,p_previous jsonb,p_evidence jsonb,p_revision uuid,p_at bigint)returns jsonb
language plpgsql security invoker set search_path=''as $$
declare result jsonb:=p_previous;v jsonb;s jsonb;old_term jsonb;active_term jsonb;next_term jsonb;item jsonb;
 r cluera_billing_private.catalog_revisions;subid text:=p_evidence->>'subscriptionId';invoice text:=p_evidence->>'invoiceId';action_value text:=p_evidence->>'action';
 subidx integer;termidx integer;activeidx integer;observed bigint;ps bigint;pe bigint;paid bigint;cutoff bigint;sequence_value bigint;remaining bigint;hold boolean;begin
 select *into strict r from cluera_billing_private.catalog_revisions where id=p_revision;
 observed:=floor(extract(epoch from(p_evidence->>'observedAt')::timestamptz)*1000)::bigint;
 cutoff:=floor(extract(epoch from(p_evidence->>'cancellationAt')::timestamptz)*1000)::bigint;
 select value,ordinality::integer-1 into s,subidx from jsonb_array_elements(result->'subscriptions')with ordinality where value->>'subscriptionId'=subid;
 if action_value='STATUS'then
 if p_evidence->>'subscriptionState'is null or s is null or observed<(s->>'observedAt')::bigint then return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if s->>'state'='CANCELED'and p_evidence->>'subscriptionState'<>'CANCELED'then raise exception 'Native terminal state requires review';end if;
 s:=s||jsonb_build_object('state',p_evidence->>'subscriptionState','observedAt',observed);
 if s->>'state'='CANCELED'then s:=s||jsonb_build_object('cancellationAt',least(coalesce((s->>'cancellationAt')::bigint,cutoff),cutoff),'graceUntil',null);
 elsif s->>'state'='PAST_DUE'and s->>'stopRequestedAt'is null then s:=jsonb_set(s,'{graceUntil}',to_jsonb(coalesce((s->>'graceUntil')::bigint,(s->>'paidThrough')::bigint+86400000)));
 else s:=jsonb_set(s,'{graceUntil}','null');end if;
 result:=jsonb_set(result,array['subscriptions',subidx::text],s);
 for item in select value||jsonb_build_object('_index',ordinality::integer-1)from jsonb_array_elements(result->'terms')with ordinality where value->>'subscriptionId'=subid loop
 termidx:=(item->>'_index')::integer;v:=item-'_index';
 if s->>'state'='PAUSED'and v->>'state'='ACTIVE'then
 if(v->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;v:=jsonb_set(v,'{state}','"SUSPENDED"');
 elsif s->>'state'='ACTIVE'and v->>'state'='SUSPENDED'then v:=jsonb_set(v,'{state}','"ACTIVE"');end if;
 result:=jsonb_set(result,array['terms',termidx::text],v);end loop;
 if s->>'state'='PAST_DUE'and(s->>'graceUntil')::bigint>p_at
 and not exists(select 1 from jsonb_array_elements(result->'terms')x where x->>'state'in('ACTIVE','SUSPENDED'))then
 select value,ordinality::integer-1 into v,termidx from jsonb_array_elements(result->'terms')with ordinality where value->>'subscriptionId'=subid order by(value->>'periodStart')::bigint desc,(value->>'sequence')::bigint desc limit 1;
 if v->>'state'='ENDED'and(v->>'periodEnd')::bigint=(s->>'paidThrough')::bigint then
 v:=v||jsonb_build_object('state','ACTIVE','startsAt',(v->>'periodStart')::bigint,'endsAt',(s->>'graceUntil')::bigint,'closedAt',null);
 result:=jsonb_set(result,array['terms',termidx::text],v);end if;end if;
 return cluera_billing_private.native_advance(p_user,result,p_at);
 end if;
 ps:=floor(extract(epoch from(p_evidence->>'periodStart')::timestamptz)*1000)::bigint;
 pe:=floor(extract(epoch from(p_evidence->>'periodEnd')::timestamptz)*1000)::bigint;
 paid:=floor(extract(epoch from(p_evidence->>'paidAt')::timestamptz)*1000)::bigint;
 select value,ordinality::integer-1 into v,termidx from jsonb_array_elements(result->'terms')with ordinality where value->>'invoiceId'=invoice;
 if v is not null then
 if action_value='GRANT'then return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 result:=cluera_billing_private.native_advance(p_user,result,p_at);
 select value,ordinality::integer-1 into strict v,termidx from jsonb_array_elements(result->'terms')with ordinality where value->>'invoiceId'=invoice;
 if v->>'state'='REFUNDED'then return result;end if;
 if(v->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 v:=v||jsonb_build_object('state','REFUNDED','remainingWallMs',null,'closedAt',p_at);result:=jsonb_set(result,array['terms',termidx::text],v);
 select value,ordinality::integer-1 into strict s,subidx from jsonb_array_elements(result->'subscriptions')with ordinality where value->>'subscriptionId'=subid;
 if(s->>'paidThrough')::bigint=(v->>'periodEnd')::bigint then result:=jsonb_set(result,array['subscriptions',subidx::text,'graceUntil'],'null');end if;
 return cluera_billing_private.native_advance(p_user,result,p_at);
 end if;
 select coalesce(max((x->>'sequence')::bigint),0)+1 into sequence_value from jsonb_array_elements(result->'terms')x;
 if action_value='GRANT'then
 select x into old_term from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=subid order by(x->>'periodStart')::bigint desc,(x->>'sequence')::bigint desc limit 1;
 if s is not null then
 if old_term is null or(old_term->>'periodEnd')::bigint<>ps or old_term->>'state'='PRESERVED'
 or(s->>'stopRequestedAt'is not null and paid>(s->>'stopRequestedAt')::bigint)or(s->>'cancellationAt'is not null and paid>(s->>'cancellationAt')::bigint)
 or(select count(*)from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=subid)>=r.total_count
 then raise exception 'Native renewal requires review';end if;
 end if;
 result:=cluera_billing_private.native_advance(p_user,result,p_at);
 select value,ordinality::integer-1 into active_term,activeidx from jsonb_array_elements(result->'terms')with ordinality where value->>'state'in('ACTIVE','SUSPENDED');
 if old_term is not null and active_term is not null and active_term->>'subscriptionId'<>subid and ps<p_at then raise exception 'Native renewal requires review';end if;
 end if;
 select value,ordinality::integer-1 into s,subidx from jsonb_array_elements(result->'subscriptions')with ordinality where value->>'subscriptionId'=subid;
 if s is null then
 s:=jsonb_build_object('subscriptionId',subid,'revisionId',r.id,'offerCode',r.offer_code,'state',coalesce(p_evidence->>'subscriptionState','ACTIVE'),
 'observedAt',observed,'paidThrough',pe,'graceUntil',null,'cancellationAt',cutoff,'stopRequestedAt',null);
 result:=jsonb_set(result,'{subscriptions}',result->'subscriptions'||jsonb_build_array(s));subidx:=jsonb_array_length(result->'subscriptions')-1;
 elsif action_value='GRANT'then
 s:=s||jsonb_build_object('paidThrough',pe,'graceUntil',null);
 if observed>=(s->>'observedAt')::bigint then
 s:=s||jsonb_build_object('state',p_evidence->>'subscriptionState','observedAt',observed);
 if cutoff is not null then s:=jsonb_set(s,'{cancellationAt}',to_jsonb(least(coalesce((s->>'cancellationAt')::bigint,cutoff),cutoff)));end if;end if;
 result:=jsonb_set(result,array['subscriptions',subidx::text],s);
 end if;
 next_term:=jsonb_build_object('invoiceId',invoice,'paymentId',p_evidence->>'paymentId','orderId',p_evidence->>'orderId','subscriptionId',subid,
 'revisionId',r.id,'offerCode',r.offer_code,'amountPaise',r.amount_paise,'grantedMs',r.allowance_seconds::bigint*1000,'spentMs',0,'reservedMs',0,
 'periodStart',ps,'periodEnd',pe,'paidAt',paid,'sequence',sequence_value,'state',case when action_value='REFUND'then 'REFUNDED'when pe<=p_at then 'ENDED'when ps>p_at then 'QUEUED'else 'ACTIVE'end,
 'startsAt',case when action_value='REFUND'or ps>p_at then null else ps end,'endsAt',case when action_value='REFUND'or ps>p_at then null else pe end,
 'remainingWallMs',case when action_value='GRANT'and ps>p_at then pe-ps else null end,'closedAt',case when action_value='REFUND'then p_at when pe<=p_at then pe else null end);
 if action_value='REFUND'then
 result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if old_term is null and pe<=p_at then result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if old_term is not null then
 if active_term is not null and active_term->>'subscriptionId'=subid and ps<=p_at then
 if(active_term->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 active_term:=active_term||jsonb_build_object('state','ENDED','closedAt',least(p_at,(active_term->>'endsAt')::bigint),'remainingWallMs',null);
 result:=jsonb_set(result,array['terms',activeidx::text],active_term);end if;
 result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));return cluera_billing_private.native_advance(p_user,result,p_at);end if;
 if active_term is not null and active_term->>'offerCode'<>'cluera_monthly_200h_v2'and r.offer_code='cluera_monthly_200h_v2'then
 if(active_term->>'reservedMs')::bigint<>0 then raise exception 'Native settlement required';end if;
 select x into strict item from jsonb_array_elements(result->'subscriptions')x where x->>'subscriptionId'=active_term->>'subscriptionId';
 remaining:=least((active_term->>'endsAt')::bigint,(item->>'paidThrough')::bigint)-p_at;
 if remaining>0 then active_term:=active_term||jsonb_build_object('state','PRESERVED','startsAt',null,'endsAt',null,'remainingWallMs',remaining);
 else active_term:=active_term||jsonb_build_object('state','ENDED','closedAt',p_at,'remainingWallMs',null);end if;
 result:=jsonb_set(result,array['terms',activeidx::text],active_term);
 for item in select *from jsonb_array_elements(result->'subscriptions')x where x->>'offerCode'<>'cluera_monthly_200h_v2'loop result:=cluera_billing_private.native_stop(result,item->>'subscriptionId',p_at);end loop;
 else
 hold:=false;
 if r.offer_code<>'cluera_monthly_200h_v2'then
 for item in select *from jsonb_array_elements(result->'subscriptions')x where x->>'offerCode'='cluera_monthly_200h_v2'loop
 select x into v from jsonb_array_elements(result->'terms')x where x->>'subscriptionId'=item->>'subscriptionId'order by(x->>'periodStart')::bigint desc,(x->>'sequence')::bigint desc limit 1;
 if v is null or v->>'state'='REFUNDED'then continue;end if;
 if item->>'state'in('ACTIVE','PAUSED')or(item->>'state'='PAST_DUE'and(item->>'graceUntil'is null or(item->>'graceUntil')::bigint>p_at))then hold:=true;end if;
 end loop;end if;
 if active_term is not null or hold then
 next_term:=next_term||jsonb_build_object('state','QUEUED','startsAt',null,'endsAt',null,'remainingWallMs',pe-ps);
 if r.offer_code<>'cluera_monthly_200h_v2'and(active_term is null or active_term->>'offerCode'='cluera_monthly_200h_v2')then result:=cluera_billing_private.native_stop(result,subid,p_at);
 else
 for item in select *from jsonb_array_elements(result->'subscriptions')x where(x->>'offerCode'='cluera_monthly_200h_v2')=(r.offer_code='cluera_monthly_200h_v2')and x->>'subscriptionId'<>subid loop
 result:=cluera_billing_private.native_stop(result,item->>'subscriptionId',p_at);end loop;
 end if;end if;end if;
 result:=jsonb_set(result,'{terms}',result->'terms'||jsonb_build_array(next_term));
 return cluera_billing_private.native_advance(p_user,result,p_at);
end$$;

create function cluera_billing_private.native_refresh(p_user uuid,p_at timestamptz)returns void
language plpgsql security invoker set search_path=''as $$declare s cluera_billing_private.native_schedules;previous jsonb;plan jsonb;o cluera_billing_private.processing_owner;t bigint;begin
 if p_at is null or not isfinite(p_at)or p_at>clock_timestamp()+interval '5 seconds'then raise exception 'Native clock requires review';end if;
 perform 1 from public.customer_accounts where user_id=p_user for update;
 select *into strict o from cluera_billing_private.processing_owner where singleton for share;
 if o.owner<>'cluera'or o.account_digest is null then raise exception 'Native owner requires review';end if;
 select *into strict s from cluera_billing_private.native_schedules where user_id=p_user for update;
 t:=floor(extract(epoch from p_at)*1000)::bigint;if t<(s.schedule->>'at')::bigint then raise exception 'Native clock requires review';end if;
 previous:=cluera_billing_private.native_live(p_user,s.schedule,p_at);plan:=cluera_billing_private.native_advance(p_user,previous,t);
 -- Reservation settlement can change trusted spend while advancing. Refresh
 -- both sides before validating immutable counters and projecting atomically.
 previous:=cluera_billing_private.native_live(p_user,s.schedule,p_at);
 perform cluera_billing_private.native_check(p_user,previous,plan,t,null);
 if previous-'at'is distinct from plan-'at'then
 perform cluera_billing_private.native_project(p_user,plan);
 perform cluera_billing_private.native_commands(p_user,previous,plan,s.version+1,o.account_digest,o.epoch);
 update cluera_billing_private.native_schedules set schedule=plan,version=version+1,updated_at=clock_timestamp()where user_id=p_user;
 insert into cluera_billing_private.native_audit(user_id,source,before_row,after_row)values(p_user,'usage-refresh',previous,plan);
 end if;
end$$;

alter function cluera_billing_private.refresh(uuid,timestamptz)rename to refresh_pre_native;
create function cluera_billing_private.refresh(p_user uuid,p_at timestamptz)returns void
language plpgsql security invoker set search_path=''as $$begin
 -- Pausing new financial processing must not send previously funded native
 -- schedules back through the older policy or discard preserved paid time.
 if exists(select 1 from cluera_billing_private.native_schedules where user_id=p_user)then
 perform cluera_billing_private.native_refresh(p_user,p_at);
 else perform cluera_billing_private.refresh_pre_native(p_user,p_at);end if;
end$$;

-- Once a user has native state, the previous writer can never race or overwrite
-- it, even when new native processing is paused. Pack reconciliation retains its
-- exact prior path. The runtime gate routes recurring receipts to native_commit.
alter function public.cluera_billing_apply(text,uuid,text,text,bigint,jsonb)rename to cluera_billing_apply_pre_native;
create function public.cluera_billing_apply(p_event text,p_claim uuid,p_digest text,p_account_digest text,p_epoch bigint,p_evidence jsonb)returns jsonb
language plpgsql security definer set search_path=''set timezone='UTC'set lock_timeout='2s'set statement_timeout='5s'as $$declare uid uuid;kind_value text;begin
 select i.user_id,r.kind into uid,kind_value from cluera_billing_private.intents i join cluera_billing_private.catalog_revisions r on r.id=i.revision_id where i.id::text=p_evidence->>'intentId';
 if kind_value='RECURRING'and(exists(select 1 from cluera_billing_private.native_config where singleton and enabled)
 or exists(select 1 from cluera_billing_private.native_schedules where user_id=uid))then return jsonb_build_object('code','REVIEW');end if;
 return public.cluera_billing_apply_pre_native(p_event,p_claim,p_digest,p_account_digest,p_epoch,p_evidence);
end$$;
revoke all on function public.cluera_billing_apply_pre_native(text,uuid,text,text,bigint,jsonb)from public,anon,authenticated,service_role;
revoke all on function public.cluera_billing_apply(text,uuid,text,text,bigint,jsonb)from public,anon,authenticated;
grant execute on function public.cluera_billing_apply(text,uuid,text,text,bigint,jsonb)to service_role;

-- Repeat the unsupported-purchase check under the SAME account transaction as
-- intent creation. A separate web preflight alone would permit a race.
alter function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)rename to cluera_billing_prepare_pre_native;
create function public.cluera_billing_prepare(p_user uuid,p_session uuid,p_request uuid,p_revision uuid,p_account_digest text,p_epoch bigint)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare policy text;begin
 if exists(select 1 from cluera_billing_private.catalog_revisions where id=p_revision and kind='RECURRING')
 and(exists(select 1 from cluera_billing_private.native_config where singleton and enabled)or exists(select 1 from cluera_billing_private.native_schedules where user_id=p_user))then
 policy:=public.cluera_billing_native_purchase_policy(p_user,p_session,p_revision,p_account_digest,p_epoch);
 if policy<>'ALLOWED'then return jsonb_build_object('code','REVIEW');end if;
 end if;
 return public.cluera_billing_prepare_pre_native(p_user,p_session,p_request,p_revision,p_account_digest,p_epoch);
end$$;
revoke all on function public.cluera_billing_prepare_pre_native(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated,service_role;
revoke all on function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)from public,anon,authenticated;
grant execute on function public.cluera_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)to service_role;

create function cluera_billing_private.native_owner_guard()returns trigger language plpgsql security invoker set search_path=''as $$begin
 if(new.owner is distinct from old.owner or new.account_digest is distinct from old.account_digest or new.epoch is distinct from old.epoch)
 and(exists(select 1 from cluera_billing_private.native_schedules s,jsonb_array_elements(s.schedule->'terms')t where t->>'state'in('ACTIVE','SUSPENDED','QUEUED','PRESERVED'))
 or exists(select 1 from cluera_billing_private.native_outbox where state in('PENDING','CLAIMED','UNCERTAIN','ACCEPTED','REVIEW')))then raise exception 'Native paid obligations require review';end if;
 return new;
end$$;
create trigger cluera_native_owner_guard before update on cluera_billing_private.processing_owner for each row execute function cluera_billing_private.native_owner_guard();
revoke all on function cluera_billing_private.native_owner_guard()from public,anon,authenticated,service_role;

revoke all on function cluera_billing_private.native_action(jsonb,text,bigint),cluera_billing_private.native_stop(jsonb,text,bigint),
 cluera_billing_private.native_advance(uuid,jsonb,bigint),cluera_billing_private.native_expected(uuid,jsonb,jsonb,uuid,bigint),
 cluera_billing_private.native_refresh(uuid,timestamptz),cluera_billing_private.refresh_pre_native(uuid,timestamptz),cluera_billing_private.refresh(uuid,timestamptz)
 from public,anon,authenticated,service_role;
commit;
