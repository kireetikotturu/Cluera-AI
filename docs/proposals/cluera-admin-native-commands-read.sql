-- UNAPPLIED companion read to the UNAPPLIED native recurring proposal.
-- No activation, claim, evidence update, resolution, provider call or retry.
-- BFF readiness flag CLUERA_ADMIN_NATIVE_COMMANDS_READ_ENABLED defaults false.
begin;
set local lock_timeout='2s';set local statement_timeout='10s';
create index cluera_native_command_review on cluera_billing_private.native_outbox(account_digest,epoch,created_at,id)
 where state in('PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW');
create function public.cluera_billing_admin_native_commands(p_actor uuid,p_session uuid,p_account_digest text,p_epoch bigint,
 p_subject uuid default null,p_after_created timestamptz default null,p_after_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=''set timezone='UTC'set statement_timeout='5s'as $$
declare value jsonb;page jsonb;more boolean;before_value jsonb;begin
 if public.account_admin_check(p_actor,p_session,true)is not true
 or not exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id join public.customer_accounts a on a.user_id=u.id
  where u.id=p_actor and s.id=p_session and s.aal::text='aal2'and a.state='ACTIVE'and u.email_confirmed_at is not null
  and u.deleted_at is null and not coalesce(u.is_anonymous,false)and(u.banned_until is null or u.banned_until<=now())and(s.not_after is null or s.not_after>now()))
 then return jsonb_build_object('code','FORBIDDEN');end if;
 if p_account_digest is null or p_epoch is null or not exists(select 1 from cluera_billing_private.processing_owner where singleton
  and owner='cluera'and account_digest=p_account_digest and epoch=p_epoch)then return jsonb_build_object('code','UNAVAILABLE');end if;
 if(p_after_created is null)<>(p_after_id is null)or(p_after_created is not null and(not isfinite(p_after_created)or p_after_created>statement_timestamp()+interval '5 seconds'))
 then return jsonb_build_object('code','INVALID');end if;
 select coalesce(jsonb_agg(v order by created_at,id),'[]')into value from(
  select o.created_at,o.id,jsonb_build_object('id',o.id,'userId',o.user_id,'subscriptionId',o.subscription_id,'kind',o.kind,'state',o.state,
   'createdAt',o.created_at,'effectiveAt',o.effective_at,'leaseUntil',o.lease_until,'observedAt',o.observed_at)v
  from cluera_billing_private.native_outbox o
  join cluera_billing_private.subscriptions s on s.subscription_id=o.subscription_id and s.user_id=o.user_id and s.account_digest=o.account_digest
  where o.account_digest=p_account_digest and o.epoch=p_epoch and o.state in('PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW')
   and(p_subject is null or o.user_id=p_subject)and(p_after_created is null or(o.created_at,o.id)>(p_after_created,p_after_id))
  order by o.created_at,o.id limit 51
 )q;
 more:=jsonb_array_length(value)>50;
 select coalesce(jsonb_agg(v order by ordinality),'[]')into page from jsonb_array_elements(value)with ordinality x(v,ordinality)where ordinality<=50;
 if more then before_value:=jsonb_build_object('createdAt',page->49->'createdAt','id',page->49->'id');end if;
 return jsonb_build_object('code','ACTIVE','observedAt',statement_timestamp(),'subject',p_subject,'rows',page,'hasMore',more,'before',before_value);
end$$;
revoke all on function public.cluera_billing_admin_native_commands(uuid,uuid,text,bigint,uuid,timestamptz,uuid)from public,anon,authenticated,service_role;
grant execute on function public.cluera_billing_admin_native_commands(uuid,uuid,text,bigint,uuid,timestamptz,uuid)to service_role;
commit;
