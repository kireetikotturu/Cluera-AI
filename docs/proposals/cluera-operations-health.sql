-- Additive SELECT-only operations evidence. No worker/event/provider execution.
-- Requires a tracked reviewed migration before the separate reader is enabled.
create index cluera_worker_admission_health on cluera_billing_private.worker_nonces(epoch,consumed_at desc);
create index cluera_pending_health on cluera_billing_private.events(received_at,event_id) where state='PENDING';
create index account_pending_health on billing_private.payment_events(received_at,event_id) where state='PENDING';
create index cluera_quarantine_health on cluera_billing_private.events(event_id) where state='QUARANTINED';
create index account_quarantine_health on billing_private.payment_events(event_id) where state='QUARANTINED';
create index cluera_uncertain_health on cluera_billing_private.intents(created_at,id) where state in ('CREATING','UNCERTAIN');
create index account_usage_window_health on public.customer_usage_windows(expires_at,user_id,run_id,sequence);

create function public.cluera_operations_health() returns jsonb
language sql stable security definer set search_path='' set timezone='UTC'
set lock_timeout='2s' set statement_timeout='5s' as $$
with owner_row as (select owner,epoch,account_digest from cluera_billing_private.processing_owner where singleton),
pending as (select received_at,lease_until from cluera_billing_private.events where state='PENDING' order by received_at,event_id limit 1001),
legacy as (select received_at,lease_until from billing_private.payment_events where state='PENDING' order by received_at,event_id limit 1001),
uncertain as (select created_at from cluera_billing_private.intents where state in ('CREATING','UNCERTAIN') order by created_at,id limit 1001),
quarantine as (select 1 from cluera_billing_private.events where state='QUARANTINED' limit 1001),
legacy_quarantine as (select 1 from billing_private.payment_events where state='QUARANTINED' limit 1001),
unsettled as (select 1 from public.customer_usage_windows w
 left join public.customer_usage_settlements s on (s.user_id,s.run_id,s.sequence)=(w.user_id,w.run_id,w.sequence)
 where s.user_id is null and w.expires_at<statement_timestamp()-interval '2 minutes' limit 1001)
select jsonb_build_object('version',1,'observedAt',statement_timestamp(),
 'owner',(select owner from owner_row),'epoch',(select epoch from owner_row),
 'merchantBound',coalesce((select account_digest is not null from owner_row),false),
 'lastAdmissionAt',(select max(consumed_at) from cluera_billing_private.worker_nonces where epoch=(select epoch from owner_row)),
 'pendingCount',(select count(*) from pending),'oldestPendingAt',(select min(received_at) from pending),
 'legacyPendingCount',(select count(*) from legacy),'oldestLegacyPendingAt',(select min(received_at) from legacy),
 'expiredLeaseCount',(select count(*) from pending where lease_until<statement_timestamp())+(select count(*) from legacy where lease_until<statement_timestamp()),
 'quarantineCount',(select count(*) from quarantine),'legacyQuarantineCount',(select count(*) from legacy_quarantine),
 'uncertainCount',(select count(*) from uncertain),'oldestUncertainAt',(select min(created_at) from uncertain),
 'expiredUnsettledCount',(select count(*) from unsettled),
 'countLimit',1000,'processingEvidence','NONCE_ADMISSION_ONLY');
$$;
revoke all on function public.cluera_operations_health() from public,anon,authenticated;
grant execute on function public.cluera_operations_health() to service_role;
