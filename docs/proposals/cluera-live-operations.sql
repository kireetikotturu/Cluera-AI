-- SELECT-only Live monitoring. No profile digest, identifiers or payloads leave
-- this RPC. Test receipts remain the responsibility of the separate Test reader.
create index cluera_live_worker_health on cluera_live_billing_private.worker_nonces(epoch,consumed_at desc);
create index cluera_live_pending_health on cluera_live_billing_private.events(received_at,event_id) where state='PENDING';
create index cluera_live_quarantine_health on cluera_live_billing_private.events(event_id) where state='QUARANTINED';
create index cluera_live_uncertain_health on cluera_live_billing_private.intents(created_at,id) where state in('CREATING','UNCERTAIN');
create index cluera_live_cancel_health on cluera_live_billing_private.cancellation_commands(created_at) where state<>'CONFIRMED';
create index cluera_live_command_health on cluera_live_billing_private.native_outbox(created_at) where state in('PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW');
create function public.cluera_live_billing_operations_health() returns jsonb
language sql stable security definer set search_path='' set timezone='UTC' set lock_timeout='2s' set statement_timeout='5s' as $$
with owner_row as(select owner,epoch,account_digest from cluera_live_billing_private.processing_owner where singleton),
pending as(select received_at,lease_until from cluera_live_billing_private.events where state='PENDING' order by received_at,event_id limit 1001),
uncertain as(select created_at from cluera_live_billing_private.intents where state in('CREATING','UNCERTAIN') order by created_at,id limit 1001),
quarantine as(select 1 from cluera_live_billing_private.events where state='QUARANTINED' limit 1001),
cancel as(select created_at,state from cluera_live_billing_private.cancellation_commands where state<>'CONFIRMED' order by created_at limit 1001),
commands as(select created_at,state from cluera_live_billing_private.native_outbox where state in('PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW') order by created_at limit 1001),
unsettled as(select 1 from public.customer_usage_windows w
 left join public.customer_usage_settlements s on(s.user_id,s.run_id,s.sequence)=(w.user_id,w.run_id,w.sequence)
 where s.user_id is null and w.expires_at<statement_timestamp()-interval '2 minutes' limit 1001)
select jsonb_build_object('version',1,'observedAt',statement_timestamp(),'mode','live',
 'activeBank',(select mode from cluera_billing_runtime_private.active_bank where singleton),
 'intakeEnabled',(select intake_enabled from cluera_billing_runtime_private.live_profile where singleton),
 'checkoutEnabled',(select checkout_enabled from cluera_billing_runtime_private.live_profile where singleton),
 'nativeEnabled',(select enabled from cluera_live_billing_private.native_config where singleton),
 'owner',(select owner from owner_row),'epoch',(select epoch from owner_row),
 'merchantBound',coalesce((select account_digest is not null from owner_row),false),
 'lastAdmissionAt',(select max(consumed_at) from cluera_live_billing_private.worker_nonces where epoch=(select epoch from owner_row)),
 'pendingCount',(select count(*) from pending),'oldestPendingAt',(select min(received_at) from pending),
 'legacyPendingCount',0,'oldestLegacyPendingAt',null,
 'expiredLeaseCount',(select count(*) from pending where lease_until<statement_timestamp()),
 'quarantineCount',(select count(*) from quarantine),'legacyQuarantineCount',0,
 'uncertainCount',(select count(*) from uncertain),'oldestUncertainAt',(select min(created_at) from uncertain),
 'expiredUnsettledCount',(select count(*) from unsettled),
 'cancellationCount',(select count(*) from cancel),'oldestCancellationAt',(select min(created_at) from cancel),
 'commandCount',(select count(*) from commands),'oldestCommandAt',(select min(created_at) from commands),
 'uncertainCommandCount',(select count(*) from cancel where state='UNCERTAIN')+(select count(*) from commands where state in('UNCERTAIN','REVIEW')),
 'countLimit',1000,'processingEvidence','NONCE_ADMISSION_ONLY');
$$;
revoke all on function public.cluera_live_billing_operations_health() from public,anon,authenticated;
grant execute on function public.cluera_live_billing_operations_health() to service_role;
