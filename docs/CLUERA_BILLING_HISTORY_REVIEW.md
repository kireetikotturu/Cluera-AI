# Cluera read-only billing history schema review

## October 19 applied SELECT-only completion

The current owner request authorizes Cluera-only engineering and safe staging completion. The previously tested SELECT-only proposal is now tracked/applied as **20261019085323 / cluera_customer_billing_history** in only `yhnqlfcgrmckhyjdxegg`. Migration SHA-256 **7a0a066b9fd880f6ca9810a728a4048e5874e08c252c7a8f81b50022d38e1406** wraps the unchanged reviewed function/two indexes in bounded atomic DDL. Fresh existing history tests32/32 passed before application; the fixture now executes the tracked migration for final verification. This supersedes the earlier unapplied/approval-only status below.

Independent hosted read-back matches function-body digest **22d7512fcddf9b05783d024d3eb7174b**, STABLE/security-definer/empty-search-path/UTC/2s-lock/5s-statement settings, exactly two indexes, browser EXECUTE=false and service EXECUTE=true. A service-role call with missing identity returns UNAUTHENTICATED. All86 pre-existing function definitions retain digest **c8744d8d00b408a9815be5e1354d5839**. Advisor output remains intentional48RLS/no-policy INFO plus existing leaked-password-protection WARN; no permissive policy or financial writer was added.

Only non-secret **CLUERA_BILLING_HISTORY_ENABLED=true** was added to the existing Cluera Vercel Production-named staging environment. Other settings are preserved; the new value requires the next reviewed deployment before runtime availability is claimed. Customer inbox/login/history acceptance remains owner pending. No receipt, payment, entitlement, worker, provider or release mutation occurred.

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

