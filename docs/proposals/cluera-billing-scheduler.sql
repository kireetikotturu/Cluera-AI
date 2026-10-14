-- UNAPPLIED REVIEW PROPOSAL: requires separate scheduler-function approval.
-- Apply only AFTER the reviewed Cluera billing schema and preservation checks.
-- Applying this function preserves the existing Account dispatch while owner
-- is 'account'. Only a separately approved owner CAS selects Cluera. No extra
-- cron job, cadence change, Vault secret import/rotation or manual wake occurs.
do $$begin
 -- This pin was reviewed from the complete pg_get_functiondef output, not prosrc.
 if (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid='billing_private.wake_worker()'::regprocedure)
   is distinct from '16b84964784d66febb352cd646903404' then
   raise exception 'Reviewed Account scheduler body changed; re-review required';
 end if;
end$$;
alter function billing_private.wake_worker() rename to wake_worker_account_base;
revoke all on function billing_private.wake_worker_account_base() from public,anon,authenticated,service_role;

create function billing_private.wake_worker() returns void language plpgsql
security invoker set search_path='' set lock_timeout='2s' set statement_timeout='5s' as $$
declare owner_row cluera_billing_private.processing_owner;cfg billing_private.worker_config;
 credential text;issued bigint;nonce uuid;proof text;request_id bigint;
 destination constant text:='https://cluera-ai-staging.vercel.app/api/internal/billing/cluera/tick';
begin
 select * into strict owner_row from cluera_billing_private.processing_owner where singleton for share;
 if owner_row.owner='account' then perform billing_private.wake_worker_account_base();return;end if;
 if owner_row.owner<>'cluera' or owner_row.account_digest is null or owner_row.epoch<1 then return;end if;
 select * into cfg from billing_private.worker_config where singleton for update skip locked;
 if not found or not cfg.enabled or (cfg.last_sent_at is not null and cfg.last_sent_at>clock_timestamp()-interval '50 seconds') then return;end if;
 select decrypted_secret into credential from vault.decrypted_secrets where id=cfg.secret_id;
 if credential is null or length(credential) not between 32 and 256 then return;end if;
 issued:=floor(extract(epoch from clock_timestamp()))::bigint;nonce:=gen_random_uuid();
 proof:=encode(extensions.hmac(concat_ws(E'\n','CLUERA-BILLING-TICK','POST',destination,owner_row.epoch,issued,nonce,owner_row.account_digest,
   encode(extensions.digest('{}','sha256'),'hex')),credential,'sha256'),'hex');
 -- pg_net stores queued headers in plaintext. Only a 60-second, one-use proof
 -- enters that queue, never the long-lived Vault credential or API key.
 select net.http_post(url:=destination,body:='{}'::jsonb,params:='{}'::jsonb,
   headers:=jsonb_build_object('Content-Type','application/json','X-Cluera-Billing-Time',issued::text,
     'X-Cluera-Billing-Nonce',nonce::text,'X-Cluera-Billing-Epoch',owner_row.epoch::text,'X-Cluera-Billing-Proof',proof),
   timeout_milliseconds:=170000) into request_id;
 update billing_private.worker_config set last_sent_at=clock_timestamp(),last_request_id=request_id where singleton;
end$$;
revoke all on function billing_private.wake_worker() from public,anon,authenticated,service_role;
-- Retain the already existing job1: select billing_private.wake_worker();
-- No cron.schedule()/unschedule(), net.http_post() test or CAS is executed here.
