-- Source fragment. The web account and Windows relay keep using the same RPCs.
-- The database chooses their paid bank; no browser/device parameter selects it.
alter function public.customer_usage_command(uuid,uuid,uuid,integer,text)rename to customer_usage_command_pre_modes;
create function public.customer_usage_command(p_user_id uuid,p_session_id uuid,p_run_id uuid,p_sequence integer,p_action text)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare a jsonb;begin
 if cluera_billing_runtime_private.bank()='live'then
 a:=public.customer_authorize(p_user_id,p_session_id);if a->>'code'is distinct from 'ACTIVE'then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user_id for update;
 perform cluera_live_billing_private.refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
 end if;
 return public.customer_usage_command_pre_modes(p_user_id,p_session_id,p_run_id,p_sequence,p_action);
end$$;
alter function public.customer_usage_balance(uuid,uuid)rename to customer_usage_balance_pre_modes;
create function public.customer_usage_balance(p_user_id uuid,p_session_id uuid)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$declare a jsonb;begin
 if cluera_billing_runtime_private.bank()='live'then
 a:=public.customer_authorize(p_user_id,p_session_id);if a->>'code'is distinct from 'ACTIVE'then return jsonb_build_object('code',a->>'code');end if;
 perform 1 from public.customer_accounts where user_id=p_user_id for update;
 perform cluera_live_billing_private.refresh(p_user_id,date_trunc('milliseconds',clock_timestamp()));
 end if;
 return public.customer_usage_balance_pre_modes(p_user_id,p_session_id);
end$$;
alter function public.cluera_credits_read(uuid,uuid)rename to cluera_credits_read_pre_modes;
create function public.cluera_credits_read(p_user uuid,p_session uuid)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$
declare base jsonb;history jsonb;plans jsonb;begin
 if cluera_billing_runtime_private.bank()='test'then return public.cluera_credits_read_pre_modes(p_user,p_session);end if;
 base:=public.customer_credits_read_paddle_base(p_user,p_session);
 if base->>'userId'is distinct from p_user::text then return base;end if;
 select coalesce(jsonb_agg(value order by created desc),'[]')into history from(
 select jsonb_build_object('offerCode',r.offer_code,'state',i.state,'createdAt',i.created_at)value,i.created_at created
 from cluera_live_billing_private.intents i join cluera_live_billing_private.catalog_revisions r on r.id=i.revision_id
 where i.user_id=p_user order by i.created_at desc,i.id limit 10)q;
 select coalesce(jsonb_agg(value order by sort_at desc),'[]')into plans from(
 select jsonb_build_object('tier',case when r.offer_code='cluera_monthly_200h_v2'then 'ENTERPRISE'else 'PRO'end,
 'state',t.state,'paymentState',s.state,'endsAt',t.ends_at,'cancelFuture',s.cancel_future)value,t.period_start sort_at
 from cluera_live_billing_private.terms t join cluera_live_billing_private.subscriptions s using(subscription_id)
 join cluera_live_billing_private.catalog_revisions r on r.id=s.revision_id
 where t.user_id=p_user order by t.period_start desc,t.invoice_id limit 30)q;
 return jsonb_set(jsonb_set(base,'{payments}',history),'{plans}',plans);
end$$;
revoke all on function public.customer_usage_command_pre_modes(uuid,uuid,uuid,integer,text),
 public.customer_usage_balance_pre_modes(uuid,uuid),public.cluera_credits_read_pre_modes(uuid,uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.customer_usage_command(uuid,uuid,uuid,integer,text),
 public.customer_usage_balance(uuid,uuid),public.cluera_credits_read(uuid,uuid)from public,anon,authenticated;
grant execute on function public.customer_usage_command(uuid,uuid,uuid,integer,text),
 public.customer_usage_balance(uuid,uuid),public.cluera_credits_read(uuid,uuid)to service_role;
create function public.cluera_billing_credits_for_mode(p_user uuid,p_session uuid,p_mode text)returns jsonb
language plpgsql security definer set search_path=''set lock_timeout='2s'set statement_timeout='5s'as $$begin
 if p_mode is null or p_mode not in('test','live')or p_mode is distinct from cluera_billing_runtime_private.bank()
 then return jsonb_build_object('code','UNAVAILABLE');end if;
 return public.cluera_credits_read(p_user,p_session);
end$$;
revoke all on function public.cluera_billing_credits_for_mode(uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.cluera_billing_credits_for_mode(uuid,uuid,text)to service_role;
