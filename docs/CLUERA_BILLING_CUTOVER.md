# Cluera Razorpay billing handoff - approval-required plan

October 14, 2026. **Engineering preparation, not an executed financial migration.** Cluera is the sole Account/subscription product. SigmaRoundAI License Edition is unchanged. The old Account services are temporary compatibility infrastructure.

## Current verified boundary

The retained database is `dwqltsqumiwsxtkzdoaa`. A fresh 23-table complete-row baseline at 02:19:30.013626 UTC still matches the identical-input read at 02:48:53.574043 UTC. Four customers and their original 900-second trials, five Paddle intents, three recovery audits, nine historical Paddle receipts, seven REVIEW jobs, one BOUND Razorpay intent and one Account release remain. Paid grants/packs/terms and new Razorpay receipts/applications/diagnostics remain zero. This bounded comparison does not certify incident non-abuse or every Auth/session/log row.

The active every-minute database scheduler still targets the old Account `/api/internal/billing/tick`. Its last retained dispatch at the initial read returned HTTP200. Old Test checkout/intake are enabled; Cluera's four payment approval/intake/checkout switches remain false and its pause remains true. No provider URL, subscription, secret, job, historical row or flag was changed during preparation.

Final identical-input comparison at **04:08:42.431098UTC** still matches all23 baseline digests/counts after deployment and private diagnostics. Final Cluera/old Account/License environment metadata remains unchanged. Old scheduler dispatch03:56UTC returns200/no timeout/error; neither schema nor processing owner/destination changed.

The connected Razorpay reader has no proven Test/merchant selector or webhook inspection endpoint. One read of only the database's canonical BOUND order did not return an accepted record; this is **UNVERIFIED**, not proof of absence, failure or non-payment. A reviewed protected-build GET-only diagnostic now checks the exact Test merchant, destination and that one canonical order/payment collection without logging identities, credentials or bodies. Its actual protected execution/read-back must be recorded before provider authority is accepted.

Accepted bounded private read-back at **04:05:27.624UTC**, dpl_5ZzWoWuw1VRoBmk5y5D8dWfUu4Yc: Test authentication, merchant and unchanged exact active webhook/old URL/three events pass. The owned INR₹549 order is ATTEMPTED with one **provider-reported FAILED** payment; its present international field fails the strict domestic-only check. All other checked fields pass, but canonical financial authority remains unaccepted and the audit emits no financialState. Do not weaken the adapter, retry, replace, clear BOUND or grant time. Actual signed delivery and a captured owned purchase remain separate acceptance.

## Implemented source, still disabled

- New customer checkout, callback, catalog, Admin and signed receiver routes under `/api/account/payments/cluera/`. Immutable server snapshots bind every attempt to its verified owner, merchant, revision and canonical order/subscription. Unknown creation outcomes stay locked; no automatic replacement/retry or automatic SDK opening.
- Browser callbacks verify the canonical server-resource HMAC only. They never insert a signed receipt, wake a worker or grant credits.
- Raw-byte webhook HMAC, exact Test merchant, event ID/digest and durable receipt precede independent paid-order/captured-payment verification. Recurring additionally checks the immutable monthly plan and exact paid invoice/subscription membership, full INR amount and invoice boundaries. Setup/mandate/authentication alone grants nothing.
- Future-paid monthly invoices queue an unspendable, bounded allocation instead of ending the current funded cycle. Activation at the exact boundary preserves no-rollover and one active cycle. Cancellation preserves already-funded cycles; only independently verified payments made before the provider's cancellation cutoff can fulfill afterward. Late lifecycle notifications use fresh provider state and grant nothing themselves.
- One shared processing-owner row and increasing epoch fence old/new prepare/claim/apply transactions. Independent events for one payment cannot create duplicate grants. Old canonical orders keep their original receipts, bindings, pack source keys and immutable audits; no history is copied into fake provider IDs.
- A new scheduler endpoint verifies fixed-destination HMAC, timestamp, nonce, epoch and exact empty body before claiming one event. Proofs expire after 60 seconds and are consumed once. No caller-selected financial operation is accepted.
- Cluera credits retain the shared ledger and desktop DTO, adding only the four reviewed v2 offer enums. Existing Account credits RPC/installed-client contract is unchanged. A separately versioned Cluera desktop candidate is required to distribute the new parser; existing EXEs are not overwritten or silently upgraded.

## Catalog and Admin policy

| Initial revision | Amount | Allowance | Term |
| --- | --- | --- | --- |
| `cluera_pack_3h_v2` | ₹549 / 54,900 paise | 10,800 seconds | PACK, no expiry; stacks |
| `cluera_monthly_40h_v2` | ₹5,499 / 549,900 paise | 144,000 seconds | Monthly, no rollover |
| `cluera_monthly_100h_v2` | ₹9,599 / 959,900 paise | 360,000 seconds | Monthly, no rollover |
| `cluera_monthly_200h_v2` | ₹19,549 / 1,954,900 paise | 720,000 seconds | Monthly, no rollover |

Verified Admin plus fresh authenticator reauthentication may create a new future revision and explicitly enable/disable its head, with a reason, operation UUID, expected-revision comparison and immutable audit. A new revision defaults disabled. Existing purchased price/seconds/plan snapshots do not change. Razorpay plans cannot be edited in place; a new recurring revision needs an independently verified matching Test plan before availability. [Plan documentation](https://razorpay.com/docs/payments/subscriptions/create-plans/).

The proposed recurring Test contract is finite: initially **up to 120 monthly charges**, adjustable to 1-120 only in a future revision. This is an additional policy requiring explicit owner acceptance, not a promise of indefinite billing. Competing recurring upgrades/preemption across old and new subscriptions are conservatively blocked, not silently implemented. Customer-triggered provider pause/resume/cancel and production method acceptance remain separate work. High-value ordinary UPI/RuPay is not promised; unknown high-value card network fails closed. Stripe/Live remain unavailable.

## Proposed database change - not applied

`proposals/cluera-billing.sql` creates only `cluera_billing_private` and 13 private tables:

1. `catalog_revisions` and `catalog_heads`: immutable purchase policies and current future-availability pointers.
2. `plan_verifications`: private Test-plan read evidence bound to revision/merchant.
3. `admin_audit`: immutable full before/after future-policy operations.
4. `processing_owner` and `cutover_audit`: singleton owner/epoch and immutable compare-and-swap evidence.
5. `worker_nonces`: append-only one-use scheduler replay protection.
6. `intents` and `events`: canonical new attempts and safe signed receipt projections/leases.
7. `subscriptions`, `payments` and `terms`: authoritative new recurring/payment attribution into the existing shared ledger.
8. `applications`: immutable event/application before/after evidence.

Every table has RLS and **zero policies**, with direct CRUD denied to public/anon/authenticated/service_role. Six immutable tables have ALWAYS update/delete/truncate rejection triggers. New RPCs are service-only SECURITY DEFINER with empty search paths and bounded statement/lock timeouts. The private helpers are not browser/service-executable.

Seven existing public APIs are narrowly wrapped: Razorpay prepare/claim/apply, Paddle claim/action-claim and shared usage command/balance. Their original bodies stay as denied internal bases. Old signed intake and old strict credits are retained. The owner is seeded **account/epoch1** and catalog heads disabled; applying the schema alone does not hand off processing or create an allowance. No existing financial/customer/trial row, table, provider ID or grant is rewritten. Frozen core proposal SHA-256: `473a81c727faf3448b682e70d95956fd67de4e01bd2af7914539fec7fb56e50d`. All 77 local database regressions pass, including unsafe forward/rollback and failed desired-cancel cases reproduced before the guard fix; these are synthetic SQL/security tests, not hosted multi-connection or payment acceptance.

`proposals/cluera-billing-scheduler.sql` is separately unapplied, SHA-256 `5892b0b0c76c85874d53b8d927a08692bdb91eac285321899773c744e0ed86e9`. It pins the complete old `pg_get_functiondef` MD5 before retaining it as an internal base. The reviewed definition pin is `16b84964784d66febb352cd646903404`; body-only `prosrc` is `285ac517e432a037b85903d25b6273f1`. These are different representations, not observed live-function drift. The preparatory comparison was corrected and a regression proves a changed security mode cannot pass just because body bytes match. While owner=account, the existing dispatch is preserved. After an approved CAS, the same cron job/cadence selects only the fixed Cluera endpoint. No second cron job or manual wake is added.

Supabase documents that `pg_net` queues raw request headers. Therefore the new branch queues only a short-lived one-use proof, **not** the long-lived Vault bearer. Existing old queued-header exposure is a separate containment review; no automatic worker-key rotation is performed. Synthetic SQL/Node proof comparison passes. [Supabase header exposure](https://supabase.com/docs/guides/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net-ad6357).

## Exact staged approvals and cutover

### A. Passive preparation - separate approval required first

Approve only the frozen billing schema and passive scheduler wrapper for the retained project, plus a temporary old-website credential bridge if still required. Before execution, pin complete reviewed source, verify all proposal bytes, refresh full preservation/security baselines and review the unresolved exposed-key incident. Do not expand privileged financial APIs while a known compromised credential remains an uncontrolled usable authority. New Cluera web/relay replacements do not revoke a legacy JWT; inventory and separately approved retirement remain required.

Privately provision Cluera's four existing Razorpay Test values, the same exact Test key ID/merchant and existing signer, existing sole verified tester, and the separately sealed worker secret. Never copy them through chat/tool arguments, expose them under NEXT_PUBLIC, or rotate the provider key ID accidentally: old bindings include that exact gateway digest. This is a configuration-only saving phase; keep `CLUERA_BILLING_V2_ENABLED=false`, rollout=false, checkout=false, intake=false, Paddle checkout=false and pause=true until schema/config verification passes.

Use the complete reviewed Git tree and original matching lockfile, `npm ci` and production build. Verify READY/exact SHA/project/alias and private GET-only merchant/catalog/order checks. Enable **only** the schema-selection mode after its proposal is applied and verified; it does not authorize intake, processing or checkout.

### B. Receiver handoff - separate intake/URL approval

1. Freshly re-read exact existing Test webhook ID `TmqOkUNGtvEPLz`, raw activation, merchant, current old URL and exactly three subscriptions. No guessed record or Live data is financial authority.
2. Deliberately freeze **new old-site checkout** under a separate scoped setting approval, retaining signed old intake and workers. Do not reject, retry, cancel or overwrite existing BOUND attempts. Verify actual captured/refunded/uncertain state read-only before any later purchase.
3. Enable only Cluera v2 receiver/rollout/intake, with checkout=false/pause=true and owner still account. Signed passive intake is durable but cannot grant through the new worker. Verify unsigned/wrong-content-type/malformed non-event rejections without fabricated signed payment events or replays.
4. Owner edits **only the URL on that same existing Test destination** from:

   `https://sigmaround-account-staging.vercel.app/api/payments/razorpay/test/webhook`

   to:

   `https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook`

   Keep destination ID, active state, merchant, signer and the original three events unchanged. Do not create a second destination. Private read-back must prove the literal new URL and unchanged other settings.
   The reviewed GET-only operator mode `cluera-intake` pins that literal new URL plus exact new project/Test configuration with intake=true and checkout=false/pause=true. Its wrong-target/URL/Live/flag regressions fail before provider requests; do not run it by overriding the current disabled flags. Canonical order/intent pins are independently taken from preserved SQL, never chosen by a customer.
5. Keep the old receiver serving late/retried deliveries. Both receivers use original receipt attribution for legacy orders and one financial owner. URL changes do not authorize any order, event simulation, replay or credit.

Razorpay retries failed deliveries for 24 hours, can deliver duplicates/out of order, and requires the original signer for old retries after a secret change. No signer change is proposed. A minimum 24-hour observation window is necessary, not sufficient to prove every delivery drained. [Retry policy](https://razorpay.com/docs/webhooks/best-practices/), [signature/idempotency](https://razorpay.com/docs/webhooks/validate-test/).

### C. Processing/scheduler ownership - separate approval

Refresh exact merchant digest, active leases, all pending receipts, old/new intents, old Paddle jobs/outbox/terms/subscriptions and worker config. Abort if any live old Razorpay lease, unresolved unattributed Paddle attempt, READY/RUNNING Paddle work, renewing Paddle subscription or old active/queued/paused term exists; retained REVIEW jobs and paid histories are not deleted or replayed. The current unpaid BOUND Paddle draft is a real cutover blocker, not a row to clear. Do not pay/resume it. Resolve it only through separately approved provider-authoritative closure or original financial processing; a Cluera-only Razorpay worker cannot fulfill a later payment of that draft. Under the shared owner-row lock, perform one audited CAS **account/epoch1 → cluera/epoch2** with an exact operation UUID/reason/digest. Any failed prerequisite or audit insertion rolls back.

The existing scheduler subsequently selects the new signed Cluera destination; old already-queued ticks cannot claim/apply after the CAS. New workers drain the original canonical Razorpay inbox as well as new Cluera receipts. Old Paddle new checkout must remain false: its existing creation helper is not an approved new-purchase path after this handoff. Inspect dispatch status and genuinely signed/provider-authoritative outcomes without manually waking a worker. New checkout remains disabled.

### D. Pack acceptance - separate one-purchase approval

Only after B/C read-back and incident containment, approve pack catalog availability, sole-tester Test checkout and exactly one **owner-initiated** ₹549 Cluera Test purchase. The agent never creates the order, opens the SDK or pays for the owner. Resolve the prior BOUND attempt through authoritative evidence before allowing a new attempt; any historical recovery requires its own explicit audited authority.

After the owner's result, require same owned paid order + captured full INR payment + actual raw-byte signed receipt + one immutable application and exactly one 10,800-second non-expiring shared grant. Verify original trial/balances, duplicate events/payment invariants and actual normal Windows Credits & Usage refresh. Callback/UI success is not acceptance. Failed/uncertain/incomplete: stop, no retry/replacement/manual grant.

### E. Recurring acceptance - later separate approval

Privately configure each immutable exact Test plan and independently read it. Separately approve additional subscription events on the **same** destination only after lifecycle handling and rollback review. The proposed set adds authenticated/activated/charged/pending/halted/cancelled/paused/resumed/completed/updated; original capture/order/refund events remain. No subscription is created by configuring or testing metadata. [Official event list](https://razorpay.com/docs/webhooks/subscriptions/).

Accept a genuine monthly payment/invoice, renewal/no-rollover, future-paid activation, setup-no-grant, failures/grace, cancellation, pause/resume, duplicate/refund behavior and installed-client shared usage separately. Provider configuration, approved finite-cycle policy, hosted contention and payment methods remain unaccepted. Do not enable all recurring offers merely because the first pack passes.

## Rollback and retirement

- Before ownership CAS: keep old owner/scheduler; restore the original provider URL only with explicit approval. Never turn off both receivers, recreate/rotate a destination or fabricate/replay evidence.
- After CAS but before new purchases: freeze new checkout, allow active leases to finish or expire, compare durable queues/attributions. CAS back only if its Cluera drain prerequisites pass. Do not delete receipts or undo grants.
- Once any new Cluera payment/application exists, even after refund or expiry, owner rollback to Account is forbidden: future refunds still require the new binding. Unresolved attempts, pending work and renewing subscriptions independently prevent rollback. Keep Cluera as financial owner, roll back only to a compatible reviewed Cluera runtime/configuration with a **safe replacement credential**, and request an explicit incident plan. Old code cannot process new subscriptions or their later refund events.
- Retain old native API/feed/installer trust until the separately measured installed-client transition passes. Never redirect an old trusted feed to a Cluera manifest or silently migrate encrypted refresh material. Database/customer/balance/history stays in place. License is untouched.
- No old stop/delete, shared-key revocation, JWT signing-secret rotation, Live activation or production infrastructure action is included in billing approval.

## Current next action

Review this exact staged plan and approve or decline **Phase A only**. It authorizes neither URL/owner cutover nor checkout/payment. Key containment and frozen schema-byte gates must pass before applying it. Do not pay or change Razorpay settings now. Subsequent phases each require their own explicit approval.

Complete reviewed application `1ff315fb2d56e07e3398e2eed73af8153c85f64b` is READY as `dpl_2aBjSmmaGz6hrAwKR85Trfx6N7Am` on the existing Cluera staging project and stable alias. All payment flags remain false. Full web 1,000/22-skipped, desktop 366/1-skipped, typechecks/builds/audits, hosted CI, 22 public boundaries and 16 isolated public layouts pass. Final diagnostic/scheduler-preflight selection78/78 passes separately. Diagnostic/proposal-only follow-ups change no deployed application runtime. [Dated evidence and limits](CLUERA_IMPLEMENTATION_MIGRATION.md). Preparation is not actual payment, cutover or commercial acceptance.
