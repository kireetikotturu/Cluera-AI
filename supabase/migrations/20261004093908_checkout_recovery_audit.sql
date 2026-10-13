-- Private owner-operated recovery evidence. No application RPC or payment writer.
-- Filename aligned with the connected staging migration history after application.
create table billing_private.checkout_recovery_audit (
  intent_id uuid primary key references public.customer_checkout_intents(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  operator_role text not null default current_user,
  reason text not null check (length(btrim(reason)) between 20 and 1000),
  authorization_reason text not null check (length(btrim(authorization_reason)) between 20 and 1000),
  evidence jsonb not null check (jsonb_typeof(evidence)='object'),
  before_row jsonb not null check (jsonb_typeof(before_row)='object'),
  after_row jsonb not null check (jsonb_typeof(after_row)='object'),
  check (before_row->>'id' is not distinct from intent_id::text),
  check (after_row->>'id' is not distinct from intent_id::text),
  check (before_row->>'state' is not distinct from 'UNCERTAIN'),
  check (after_row->>'state' is not distinct from 'REJECTED'),
  check ((before_row-'state')=(after_row-'state'))
);
alter table billing_private.checkout_recovery_audit enable row level security;
revoke all on billing_private.checkout_recovery_audit from public,anon,authenticated,service_role;
create function billing_private.reject_checkout_audit_mutation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  raise exception 'Checkout recovery audit is append-only' using errcode='55000';
end $$;
revoke all on function billing_private.reject_checkout_audit_mutation() from public,anon,authenticated,service_role;
create trigger checkout_recovery_audit_immutable
before update or delete or truncate on billing_private.checkout_recovery_audit
for each statement execute function billing_private.reject_checkout_audit_mutation();
alter table billing_private.checkout_recovery_audit enable always trigger checkout_recovery_audit_immutable;
