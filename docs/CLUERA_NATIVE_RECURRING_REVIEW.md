# Cluera native recurring preparation

Status: implemented and locally tested preparation; not activated. Neither financial SQL proposal has been applied. `CLUERA_RECURRING_SCHEDULE_ENABLED` is absent/default false, and the new SQL `native_config.enabled` defaults false. There is no activation RPC. No merchant subscription, charge, capture, refund, plan, credential or production flag was changed by this work.

## Actual runtime path

- `reconciliation.ts` uses the existing claimed, signed receipt and canonical Razorpay adapter. For a recurring binding only, the explicit native environment flag selects `applyClueraNativeRecurringEvent`; otherwise the previous writer remains the runtime path. Legacy and pack handling remain unchanged.
- `nativeRecurring.ts` additionally requires isolated Test configuration, approved intake, the external scheduler, Razorpay, a valid configured tester allowlist and the bound customer in that allowlist. It obtains a pinned merchant/owner/epoch, asks SQL for a live schedule, computes the native policy, settles affected reservations if required, rereads live spend, then commits with an optimistic version and digest. There is no provider mutation in entitlement calculation.
- `scheduler.ts` processes the normal event, then, only under the native flag, performs one existing-command GET observation or one newly claimed cancellation command. `nativeRecurringOutbox.ts` can issue only the existing exact `cancel_at_cycle_end:true` operation. `RESCHEDULE` remains `REVIEW` and has no HTTP implementation.
- `checkout.ts` checks the native purchase policy before preparing any provider operation. The proposed SQL prepare wrapper repeats this under the same account lock as intent creation, closing the concurrent-preflight race.

**The prepared purchase policy supports a first subscription only.** It blocks every competing monthly purchase, including same-tier queues and Pro-to-Enterprise upgrades, while another funded/held term or a non-canceled subscription exists. Packs retain their independent path. The internal writer can conserve already-captured conflicting paid invoices; that is not approval to sell those conflicting subscriptions.

## Database proposals

Review/apply order for a future explicitly accepted rollout:

1. Existing clean foundation, with customer history/cancellation proposals reviewed separately.
2. `proposals/cluera-native-recurring.sql`: private RLS schedule/config/outbox/audit tables, service-only receipt snapshot/settlement/commit, pre-purchase check and durable cancellation command RPCs.
3. `proposals/cluera-native-recurring-refresh.sql`: independent SQL policy derivation, native usage refresh, old-writer exclusion and atomic purchase-policy wrappers. It preserves previous function bodies under inaccessible names.
4. `proposals/cluera-native-recurring-history.sql`: separate SELECT-only customer presentation. `CLUERA_NATIVE_RECURRING_HISTORY_ENABLED` is absent/default false; this read never enables or calls the financial writer, usage refresh or provider. It requires the already applied history migration and both native proposals as schema dependencies.

The main commit refuses to run without the companion policy bridge. SQL validates the exact current leased receipt, pinned merchant/epoch, immutable intent/revision/invoice/payment/order relationships and current live grant spend/reservations. It independently derives the **entire** permitted next schedule and compares it with the submitted plan before projecting the shared usage ledger. A STATUS receipt cannot fabricate a refund, paid-through extension, allowance or expiry.

One transaction records the grant/payment/term/subscription projection, desired commands, schedule version, immutable application/audit and processed receipt. Failure to append an audit rolls everything back. Existing grant amounts, spent/reserved counters, trial, pack and other-user rows are not rewritten. Refund-before-capture records a grantless permanent tombstone. A delayed expired first invoice records revoked paid history at its original period; it cannot pause current Pro or grant a fresh month.

The bridge preserves exact unused Pro paid wall-time and spend during Enterprise, queues funded same-tier periods, permits only one active/suspended term, and anchors delayed activation to historical paid/grace/termination boundaries. Unknown Enterprise renewal delivery holds saved Pro until independently known cancellation, fixed grace expiry or latest full refund. Grace is one fixed day after paid-through, with no new allowance and no reset on repeated events. A delayed full refund restores Pro at the independently verified receipt-processing time: current evidence has no authoritative refund-effective timestamp. That specific hold policy is deliberate and tested.

Usage refresh settles expiring reservations and rereads actual spend before projection. Turning off new processing does not send a funded native account back through the older policy. The old recurring writer refuses native accounts; unknown competing physical rows are rejected instead of silently overwritten. A proposed owner-change trigger retains native paid obligations and unresolved commands for review.

Customer history has a separately gated native schedule section. It displays actual PRESERVED/QUEUED state rather than the compatibility ENDED value, saved calendar wall-time separately from unused session allowance, live spent/reserved counters, and independently eligible spendable time. Held periods always contribute zero spendable time. Restoring saved access explicitly does not promise resumed billing. The SELECT projection requires the same verified current customer session, pinned merchant/epoch and complete immutable invoice/payment/grant provenance; it neither refreshes expiry nor settles usage. Collections are independently capped at 50 with an explicit truncation notice. The old customer history RPC/DTO remains unchanged when this read flag is absent.

Cancellation claims are never reclaimed. Expired leases become UNCERTAIN. New versions and changed operation identities cannot retry a retained command; customer-directed cancellation also checks the same retained command family. This cross-protocol fence survives disabling new native processing. An active provider response is an ACK, not proof that renewal has stopped. Only independently fetched terminal state closes the command. These records never change paid entitlement by themselves.

If the customer cancellation proposal is used, install it before the native proposal so its insert fence is present. Recheck this dependency before any later activation; installing cancellation afterward requires installing the guard as part of that reviewed change.

## Provider capability boundary

Reviewed official Razorpay documentation on 2026-10-19:

- [Update Subscription API](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/) documents `start_at`, update timing `now`/`cycle_end`, and `charge_at` as a response field. It lists restrictions for UPI and eMandate updates.
- [Subscription update guide](https://razorpay.com/docs/payments/subscriptions/update/) distinguishes method/card restrictions and changes that may produce prorated charges or refunds.
- [Subscription FAQs](https://razorpay.com/docs/payments/subscriptions/faqs/) describe method limitations, including customer-controlled UPI pause/resume constraints.

These sources do not prove that this merchant and supported mandate methods can arbitrarily defer an ACTIVE subscription's next charge while preserving every existing paid term without another charge/refund. That is an explicit unresolved capability, not an assumed `start_at`/`charge_at` PATCH. No speculative PATCH, merchant resume or automatic paid-subscription recreation exists.

## Remaining acceptance and engineering

- Obtain a supported method-specific financial design and explicit owner acceptance for queued purchases, upgrades and restoration of future Pro billing. The implemented paid-time preservation does not restart a canceled provider subscription.
- Apply and independently review the financial proposals, review actual merchant/method evidence, verify immutable plans and catalog revisions, and explicitly accept any Test payment actions before enabling the new flags. No live-payment readiness is claimed.
- The customer history section now presents native PRESERVED/QUEUED states. Compatibility terms still map preserved Pro to ENDED to satisfy the original one-active-term index; the native schedule and dedicated read projection retain and display the actual saved entitlement. This does not open additional purchase paths.
- Build a separate owner-reviewed resolution workflow for unsupported RESCHEDULE/uncertain commands and any pre-existing non-native monthly import. There is no automatic unknown-command replay or silent import.
- Native execution and the older recurring writer must not both process the same financial scope. The proposed wrappers enforce this; deploying runtime source alone does not install that database exclusion.

Local verification uses PGlite with the actual clean foundation and both unapplied proposals, synthetic raw signed webhooks and strict synthetic Razorpay HTTP. It includes the real checkout → signed worker → ledger/outbox path, unsupported purchase rejection before CREATE, no early future-budget activation, late closed history, reservation conservation, duplicate/refund ordering, malicious-plan rejection, atomic audit rollback, stale owner/claim fences, service-only ACLs, unknown-command retention and GET-only resolution. No hosted provider or financial database operation is part of these tests.

Customer presentation tests additionally load the exact applied history migration and new unapplied projection. Actual financial writer fixtures produce Pro preservation, Enterprise priority and a queued funded Pro period; a subsequent customer read preserves every Auth/account/trial/grant/reservation/payment/receipt/application/schedule/command/audit row. Browser tests verify explicit-refresh GET only, saved-window versus spendable-allowance wording and stale-owner response fencing.
