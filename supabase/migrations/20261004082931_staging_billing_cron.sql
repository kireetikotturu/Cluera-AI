-- Explicit owner-approved account STAGING scheduler. Never deploy to production.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create schema if not exists billing_private;
revoke all on schema billing_private from public,anon,authenticated,service_role;
create table billing_private.worker_config (
  singleton boolean primary key default true check(singleton),
  secret_id uuid,
  enabled boolean not null default false,
  last_sent_at timestamptz,
  last_request_id bigint
);
alter table billing_private.worker_config enable row level security;
revoke all on billing_private.worker_config from public,anon,authenticated,service_role;
insert into billing_private.worker_config(singleton) values(true);

-- One-time service-side provisioning bridge. No secret getter, URL parameter,
-- overwrite/rotation, or caller-controlled cron command. Revoke after provisioning.
create function public.customer_billing_provision_worker(p_secret text,p_project_ref text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v uuid;
begin
  if p_project_ref is distinct from 'dwqltsqumiwsxtkzdoaa' or p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then return false; end if;
  perform 1 from billing_private.worker_config where singleton for update;
  if exists(select 1 from billing_private.worker_config where secret_id is not null) then return false; end if;
  v:=vault.create_secret(p_secret,'sigmaround_staging_billing_worker','Staging billing wake-up only');
  update billing_private.worker_config set secret_id=v where singleton;
  return true;
end $$;
revoke all on function public.customer_billing_provision_worker(text,text) from public,anon,authenticated;
grant execute on function public.customer_billing_provision_worker(text,text) to service_role;

-- Invoked by postgres-owned cron only. No customer data in HTTP body or logs.
create function billing_private.wake_worker() returns void language plpgsql set search_path='' as $$
declare cfg billing_private.worker_config%rowtype; credential text; request_id bigint; t timestamptz:=clock_timestamp();
begin
  select * into cfg from billing_private.worker_config where singleton for update;
  if not cfg.enabled or cfg.secret_id is null then return; end if;
  if cfg.last_sent_at is not null and cfg.last_sent_at>t-interval '55 seconds' then return; end if;
  if cfg.last_sent_at>t-interval '15 minutes'
    and not exists(select 1 from public.customer_billing_jobs where state in ('READY','RUNNING') and available_at<=t)
    and not exists(select 1 from public.customer_billing_outbox where state in ('READY','RUNNING') and available_at<=t) then return; end if;
  select decrypted_secret into credential from vault.decrypted_secrets where id=cfg.secret_id;
  if credential is null then return; end if;
  request_id:=net.http_post(url:='https://sigmaround-account-staging.vercel.app/api/internal/billing/tick',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||credential),
    body:='{}'::jsonb,timeout_milliseconds:=170000);
  update billing_private.worker_config set last_sent_at=t,last_request_id=request_id where singleton;
end $$;
revoke all on function billing_private.wake_worker() from public,anon,authenticated,service_role;
-- Newly enabled pg_net request headers must not be readable by browser roles.
revoke all on net.http_request_queue,net._http_response from public,anon,authenticated;
select cron.schedule('sigmaround-staging-billing','* * * * *','select billing_private.wake_worker();');
