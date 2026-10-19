# Cluera provider telemetry review

October 19, 2026 (IST). Cluera only. This records implementation and synthetic verification, not real provider usage, invoice reconciliation or permission to spend. The rollout status and actual migration/deployment IDs belong in [execution status](CLUERA_EXECUTION_STATUS.md) and the [final launch checklist](CLUERA_FINAL_LAUNCH_CHECKLIST.md).

## Implemented boundary

The default-off recorder operates only with the existing encrypted Admin vault adapters. A server-generated operation UUID is linked to the existing server-owned usage run, provider, model, credential UUID and revision. A durable, acknowledged START is required before Gemini transport or a Deepgram connection opens. SQL independently checks a current usage window and matching enabled provider revision/model. The browser supplies none of these authority fields. The existing shared time ledger continues to authorize and settle usage; metadata never grants or deducts credits.

Each operation has one immutable START and at most one immutable terminal receipt. Exact duplicate writes are idempotent; conflicting receipts are rejected. A failed or uncertain START prevents an upstream call. A late START commit may therefore exist without an upstream request. A crash, transport failure or uncertain terminal write leaves the recorded operation **UNCONFIRMED**. It is never replayed automatically, relabelled successful or treated as proof of zero provider usage/cost.

Gemini receipts retain only reported prompt, output, cached, thinking and total token counters when available. Deepgram retains the reported audio-window end converted to milliseconds; this is **not billed duration**. Request identifiers are SHA-256 hashes rather than raw IDs. Elapsed time measures the local adapter lifetime and is bounded to one hour. Prompts, images, transcripts, answers, headers, credentials and raw errors are excluded. The private START retains user/run UUIDs for ledger correlation; the browser report excludes those identities and credential data.

Provider cost is always `null` with `costStatus=UNAVAILABLE`. No verified rate revision, currency conversion, provider invoice or cost reconciliation is configured. Missing counters remain null. Explicit provider-reported zero counts remain distinguishable from unavailable data. Reported tokens, audio windows and elapsed time are not invoice amounts.

## Schema and read authority

[The original reviewed SQL proposal](proposals/cluera-provider-usage.sql), SHA-256 `d898ad508274a95ef4ba05cf54917bc15cc7df15ee18a2e65b4c7046364c55de`, is retained as historical review evidence. The applied tracked [migration 20261019095939](../supabase/migrations/20261019095939_cluera_provider_usage_metadata.sql) wraps that reviewed body in an atomic transaction with bounded lock/statement limits. Its original proposal comments record provenance; the current applied status is this paragraph and execution status.

The migration adds two private RLS tables, a run-ID lookup index, metadata immutability triggers and three service-only RPCs. It does not modify financial rows or replace any existing function. Independent clean-project read-back records all 89 pre-existing function digests unchanged, preserved business state, four new functions and two empty private RLS tables. Collection remains absent/off; a separate Vercel read flag may be enabled for reviewed reporting without enabling provider use. Direct browser/service table CRUD and browser RPC execution are denied. Mutation/retention through privileged database operations still requires its own reviewed operational procedure; this is not a claim that a database administrator cannot alter database objects.

The read RPC and BFF require the existing verified current customer session, live SQL Admin authorization and AAL2; recovery mode is denied. No new role or MFA enrollment is created. The strict DTO rejects duplicate operation UUIDs, terminal data on UNCONFIRMED rows, missing confirmed timestamps/elapsed time, reversed chronology, durations over one hour and unknown fields.

The Admin view reads only after a deliberate action, deduplicates concurrent clicks, and aborts/clears retained data when its parent authorization gate changes. Its fixed same-origin GET rejects redirects, unexpected JSON/cache/security headers and responses over 128 KiB. An independent eight-second deadline covers fetch and body reads, including abort-ignoring synthetic transports and non-settling cancellation. Raw error bodies are never rendered. Results are explicitly the latest 50 requests, not all-time usage, customer charges or supplier invoice totals. An empty view does not prove zero usage or cost.

## Separate activation controls

Both controls default off and are deliberately independent:

| Scope | Setting | Effect |
| --- | --- | --- |
| Cluera Vercel | `CLUERA_PROVIDER_USAGE_READ_ENABLED=true` | Allows authorized historical metadata reads after the additive schema is installed. Does not start providers or collection. |
| Cluera Render | `CLUERA_PROVIDER_TELEMETRY_ENABLED=true` | Requires durable START/terminal recording for new Admin-vault operations. Valid only with `CLUERA_AI_BOOTSTRAP_MODE=admin-vault`. |

Schema review/application and a reviewed deployment precede the read flag. Collection remains absent/off until dedicated vault-key custody, encrypted recovery escrow, disabled provider provisioning and separately approved metered provider acceptance are ready. Loading a telemetry schema or enabling historical reads grants no provider-spending approval. Keep Render in auth-only mode until its independent vault bootstrap is deliberately accepted.

Historical reads may remain enabled when collection or providers are stopped. Rollback may disable collection and return Render to auth-only without deleting receipts or making history unreadable. No automatic replay, alternative provider, guessed settlement or plaintext credential fallback exists.

## Verification

- The initial focused receipt tests used historical schema fragments. That checkpoint is superseded for clean-project compatibility; it must not be described as actual clean-foundation verification.
- The hardened **35/35** checkpoint uses exact `20261016014532_cluera_clean_foundation.sql` and `20261016015041_cluera_clean_provider_vault.sql`, with the required empty Auth tables and synthetic identities. Every pre-existing business table snapshot and every pre-existing function definition/ACL/config matches before and after proposal application; metadata operations preserve the seeded business state. Real PGlite tests cover RLS/ACLs, current run/provider checks, Admin/AAL2, immutability, idempotency, malformed/content-bearing receipts and the 50-row bound.
- The subsequent final focused suite passes **121/121 across 12 files**, including the exact-clean database tests, Gemini write-before-upstream ordering, Deepgram stop-during-START/denied-START cases, eight-second/body-size read bounds, report invariants, Admin API/UI, and existing vault/relay/ledger/coordinator regressions. These suites overlap; do not add their totals.
- Web and backend typechecks pass. No real provider request, secret change, payment, ledger replay or provider collection activation was performed by these tests.
- The post-application database regression passes **6/6**, reading the tracked `20261019095939_cluera_provider_usage_metadata.sql` itself on the exact clean foundation/vault and asserting it retains the original reviewed proposal body. Actual remote preservation evidence remains separate from synthetic test evidence.

## Remaining acceptance

After independently reviewed schema/deployment/read activation, accept the actual Admin metadata view using the existing account and MFA. After separate custody and provider-spending approval, verify a bounded real Gemini text/image request and both Deepgram channels produce durable correlated records, that cancellation/disable/outage leaves truthful terminal or UNCONFIRMED state, and that no content or credentials appear in persisted metadata. Reconcile actual provider receipts and invoices independently. Rate-card cost computation, invoice-cost reconciliation, long-term retention/archival and alert delivery require their own implementation/operational acceptance; this view does not claim them complete.

Primary provider contracts: [Gemini GenerateContentResponse and UsageMetadata](https://ai.google.dev/api/generate-content), [Deepgram Flux TurnInfo and audio windows](https://developers.deepgram.com/reference/speech-to-text/listen-flux). Database authority follows [Supabase database functions](https://supabase.com/docs/guides/database/functions).
