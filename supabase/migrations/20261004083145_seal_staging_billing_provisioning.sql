-- Provisioning completed privately in staging. No API caller can read, replace,
-- or reprovision the worker credential. Rotation is an explicit owner operation.
revoke all on function public.customer_billing_provision_worker(text,text) from public,anon,authenticated,service_role;
