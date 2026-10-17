# Cluera read-only billing history schema review

October17,2026. Current target only `yhnqlfcgrmckhyjdxegg`. Proposal is NOT applied or authorized by the merchant-pin approval.

Exact [SQL](proposals/cluera-billing-history.sql), SHA-256 **49e093e16308fd68157e0e6ce4ae99991c975322128a2ae749e6f529f71e3383**. It creates only:

- `cluera_payments_history_owner`: payment owner/date/ID index.
- `cluera_subscriptions_history_owner`: subscription owner/observation/ID index.
- `public.cluera_billing_history(uuid,uuid)`: bounded STABLE SELECT-only SECURITY DEFINER function, empty search path/UTC,2s lock/5s statement bounds. Explicit PUBLIC/anon/authenticated/service_role EXECUTE revoked, then service_role alone granted. Existing tables stay RLS/private/direct-CRUD denied; no permissive policy/table/financial writer is added.

It independently requires a verified, nonanonymous, unbanned/undeleted Auth identity, exact live matching session and ACTIVE customer. Reads join intents/revisions using the same owner and canonical IDs. It exposes at most50payments and50subscriptions with explicit truncation booleans, immutable price/time snapshots and provider reference IDs; never credentials, merchant/payer/raw receipts, ciphertext, privileged audits or invoice URLs. No trial/account bootstrap, grant, provider request, reconciliation or scheduler call occurs in this function.

The HTTP handler additionally uses the existing live BFF session, exact target/origin/query/expected-owner fence, recovery denial and rate limit. Those normal Auth/rate/cookie paths can create the once-ever trial on first normal authorization, rotate a session or update counters: the entire HTTP request is not falsely described as a database read-only transaction. The financial history RPC itself is SELECT-only. Customer UUID query input is only a fence, never authority.

The React UI has no automatic read/poll, SDK, payment command or invoice link. Explicit refresh is single-flight,10s/128KiB bounded, no-store/nosniff/JSON/owner/strict-DTO validated and aborts on ownership, availability, parent verification or unmount. Disabled/missing/read failure remains unavailable, not a fake empty result. Schema-readiness flag **CLUERA_BILLING_HISTORY_ENABLED** is absent/defaultfalse and no setting was added. V2 readiness and exact Cluera target are also required; payment pause does not hide recorded history once this separate read feature is actually approved.

Before any application, independently verify exact proposal bytes, project, absence of the function/indexes, function/ACL/RLS protections and fresh complete business snapshots. Apply only through an explicitly approved atomic tracked migration with bounded locks, then verify the exact one new function/two indexes, service/browser denial, live-session/owner boundaries and preserved business rows. No current proposal was modified to loosen a guard. Existing clean source and new synthetic tests are implementation evidence, not hosted schema or real-customer acceptance.

Separate approval is required. Do not apply this SQL manually, enable its flag or infer payment/cutover/provider authority from a read-only approval. Invoice access and subscription-change commands still need their own implementation/financial authority; displaying a reference ID is not a PDF receipt or cancellation.

