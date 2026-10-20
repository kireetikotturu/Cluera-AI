# Cluera billing: final setup and acceptance

Updated October 20, 2026 (IST). **Test remains active. Live charging is disabled. Commercial release is not accepted.** This guide supersedes older billing setup instructions where they conflict. It does not authorize a payment, refund, replay, new mandate, Live activation or installer publication.

Use the existing [Cluera website](https://cluera-ai-staging.vercel.app/account), [Supabase project](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg), Cluera Vercel project and Cluera Render relay. Existing users, Google OAuth, SMTP and Admin/MFA stay in place; do not repeat their setup. Remote Desktop remains excluded. The Windows installer is a separate next step.

## Implemented behavior

| Area | Result and boundary |
| --- | --- |
| Customer checkout | Sign in, choose a plan, explicitly buy/subscribe, official Razorpay Checkout, signed callback acknowledgement, durable webhook verification, automatic status/balance/history refresh. A page visit never creates an order. A callback alone never grants credits. |
| Payment methods | Official Checkout displays methods supported by the actual merchant, mode and offer, including eligible UPI/QR, cards and Netbanking. Cluera does not generate a separate QR or promise every method for subscriptions. |
| Packs | Exact ₹549 / 54,900 paise, 10,800 seconds, no expiry, stackable. One claimed intent can send one CREATE. Unknown outcomes remain locked. Same-order recovery independently verifies the original untouched binding before opening Checkout. |
| Monthly tiers | Exact ₹5,499 / 144,000 seconds, ₹9,599 / 360,000 seconds, ₹19,549 / 720,000 seconds. Canonical paid invoices fund one allowance per period; renewal, no rollover, fixed one-day grace without new hours, failures, cancellation, full-refund revocation and history are implemented behind acceptance gates. |
| Changes of plan | First eligible subscription only. Active/queued/preserved subscriptions block a competing mandate before CREATE. The supported change is confirmed cancellation, completion of the paid term, then a fresh explicit eligible checkout. Mid-period proration, automatic upgrades, mandate rescheduling and automatic future Pro recreation are not offered. |
| Cancellation | One durable end-of-cycle command. A timeout does not repeat the POST. An accepted request is not proof of terminal cancellation. Already funded access follows its paid cutoff; independent canonical observation determines the provider outcome. |
| Security and accounting | Verified sessions and account ownership, exact revision/merchant binding, raw webhook HMAC, independent canonical provider reads, immutable receipts, transactional deduplication, account locks, bounded transport/body sizes and durable unknown outcomes. Partial or ambiguous refunds require review; the application does not manufacture a full refund. |
| Website and Windows | One account identity and database reservation/settlement ledger. Eligible recurring time precedes packs. The lifetime 900-second trial is never duplicated by a device or billing-mode change. Real concurrent-device exhaustion still needs acceptance. |
| Test/Live isolation | Separate credentials, receipt endpoints, worker signers/audiences, financial schemas/RPCs, plan mappings and paid-grant provenance. Live has independent environment and database gates. A server-owned active spending bank excludes Test-paid time from Live and vice versa; the original trial remains shared. No request parameter chooses a bank. |
| Administration | Existing protected Admin plus fresh MFA controls immutable catalog revisions. Separate Test and Live reports/cursors and catalog controls prevent accidental mixed reporting. Reports show validated local records, not settlement proof or tax invoices. |
| Dispatch | Existing Test dispatch remains intact. A separate default-off Render Live dispatcher sends bounded signed ticks with no overlap or immediate retry. A reliable always-running scheduler, alerting and recovery drill remain operational prerequisites. |

Razorpay does not support updating UPI/eMandate subscriptions through its subscription-update API. Enterprise must not promise universal unattended ₹19,549 UPI renewal. Higher-value card and merchant-specific method restrictions need actual acceptance. See [subscription updates](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/) and [subscription FAQs](https://razorpay.com/docs/payments/subscriptions/faqs/).

## The retained order is verified

The protected, GET-only application diagnostic at **2026-10-20T07:57:30.895Z** used the actual configured Test credentials and verified:

- The pinned merchant and current processing owner.
- The original user, intent, catalog revision, order notes and receipt binding.
- `order_TpRplT79SeFnTp`: ₹549, Created, zero attempts, numeric paid amount zero, due 54,900 paise, no payments.
- A second binding/merchant read after the provider reads.

It made **two provider GET requests and zero financial mutations**. Result: `SAME_ORDER_ELIGIBLE_AT_OBSERVATION`. Evidence: source `ecf431523067f7fb4c7572ac62189159cf8f9d04`, protected diagnostic `dpl_23XEiqLwurZMFXyCcmdF8JtwwGAD`. The diagnostic deliberately produced no website artifact or alias.

That observation is time-bound. The application rechecks before resuming. Do not create a replacement if it now reports pending/attempted/unknown. The separate Razorpay connector's earlier “ID does not exist” result did not establish the same merchant and does not override this configured-merchant check.

## Database installation and remaining gates

Migration **`20261020080539_cluera_recurring_dependencies_disabled`** is applied. It installs cancellation, native recurring, usage-refresh and native history dependencies atomically. Its transaction compared all prior business rows and retained function implementations before committing. Native processing remains disabled; no plans, commands, payments or grants were created.

The subsequent read-only database check still showed **2 customers, 2 trials, 0 payments, 0 events, 0 subscriptions, 0 cancellation/native commands**, and the original order **BOUND**. Do not repeat this migration.

The generated [Live proposal](proposals/cluera-live-billing.sql) is **unapplied**. It includes the separate financial schema, default-Test spending bank, immutable grant provenance, private profile/configuration audit and mode-aware usage readers. Installing it is distinct from approving Live intake or charging. Because it changes shared usage functions, its installation requires a preserved-state review and rollback plan at the later Live change window.

No monthly catalog, runtime flag, real mandate, Live credential, Live profile, paid infrastructure or Windows release was activated by this work.

## Short owner checklist for Test

1. **Confirm the existing account privately.** Sign in, reload, check the same identity/trial and sign out. Google is configured; complete real consent/account switching only if not already accepted. Do not send credentials or email links in chat.
2. **Accept the retained pack once.** Open [the selected ₹549 pack](https://cluera-ai-staging.vercel.app/account/checkout?offer=cluera_pack_3h_v2) with the existing approved purchaser. Use the application's same-order continuation only when offered. Accept captured ₹549, the same paid order, genuine signed webhook, exactly one 10,800-second non-expiring grant and the original trial intact. Confirm automatic history/balance and Windows balance. Stop on any uncertain result.
3. **Accept the monthly policy and Test mappings.** Use first-subscription-only and end-of-term plan changes, or obtain a separately reviewed financial design before expanding them. In the correct Test merchant, prepare monthly interval-1 plans at **549900, 959900, 1954900 paise**, with the intended finite charge count. Through existing fresh-MFA Admin, create immutable catalog revisions with those plan IDs and verify them. Do not modify existing paid snapshots.
4. **Approve a bounded monthly acceptance window.** A named operator must enable the installed native database gate and the existing Test recurring/scheduler/cancellation gates together, with durable receipt processing working. Enterprise has a separate acceptance gate. Test each enabled tier/method: invoice, renewal, failure/grace, cancellation, full refund, duplicate/out-of-order receipt and concurrent-device exhaustion. No real attempt was performed by the automated tests.
5. **Accept operations and security.** Establish a reliable scheduler, alerts/on-call owner, backlog/reconciliation monitoring, retention and a restore drill. Review Supabase's existing [leaked-password-protection warning and plan support](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Complete merchant business/KYC, support/refund/privacy/terms and invoice obligations. Paid infrastructure requires your approval.

No SMTP, Google provider, application-key or Admin/MFA enrollment needs repeating.

## Later Live preparation and activation

Test and Live transactions are separate at Razorpay; Test records do not become Live transactions. Keep Test keys, receipt intake and its worker available for old obligations. Never change this deployment's existing `RAZORPAY_ENVIRONMENT=test` to Live: Live uses its own profile. See [Razorpay Test/Live modes](https://razorpay.com/docs/payments/dashboard/test-live-modes/).

These are **operator steps after a separate explicit owner decision**, not instructions to activate Live now:

1. Finish genuine Test acceptance and security/operations acceptance. Record the exact accepted runtime, merchant identity, method policy, rollback revision and approved initial bounded Live purchaser. Reconcile every unresolved Test order before promotion.
2. Review and install `docs/proposals/cluera-live-billing.sql` once with Test still selected. Verify existing rows/trial/balances and privileges, all Live tables empty, all Live gates off. The proposal is reproducibly generated by `scripts/prepare-cluera-live-schema.cjs`; do not edit generated SQL or rerun an applied installation.
3. Privately provision **distinct** `RAZORPAY_LIVE_KEY_ID`, `RAZORPAY_LIVE_KEY_SECRET`, `RAZORPAY_LIVE_WEBHOOK_SECRET`, `RAZORPAY_LIVE_ACCOUNT_ID` and `CLUERA_LIVE_WORKER_SECRET`. Never use `NEXT_PUBLIC_*`, chat or Git for these secrets. Merchant API/webhook credentials belong only on the existing Cluera Vercel project's **Production-named environment**, not Preview; Render needs the dedicated worker signer and non-secret target metadata. The profile rejects Preview and foreign project/team metadata. “Production” here is Vercel's environment name, not permission to charge.
4. Set non-secret `CLUERA_LIVE_PROJECT_REF=yhnqlfcgrmckhyjdxegg`, both `CLUERA_LIVE_ACCOUNT_ORIGIN` and `CLUERA_LIVE_APPROVED_ORIGIN` to `https://cluera-ai-staging.vercel.app`, and `CLUERA_LIVE_MERCHANT_DIGEST` to SHA-256 of the exact UTF-8 string `razorpay:live:<account ID>:<Live key ID>`. Independently confirm the merchant/key pair in the correct dashboard and canonical API reads. A hash alone does not prove merchant ownership.
5. Prepare the private profile using `scripts/payments/prepare-cluera-live-profile.cjs`. It only emits reviewable SQL; it performs no service call. Input JSON has exactly `phase`, `merchantDigest`, `origin`, `acceptanceDigest`, `operationId`, `expectedEpoch`. Values are non-secret: phase is `profile`, `intake` or `promote`; digests are 64-character lowercase hex; operation is a fresh UUID; epoch comes from the current database owner. `acceptanceDigest` identifies the private approved change record. First run `profile` against the initial owner/epoch; read back its incremented epoch for the next phases. Review each output before applying it. Profile creation keeps charging off; promotion refuses unresolved Test intents/events and active usage.
6. Configure the **separate Live webhook** at `https://cluera-ai-staging.vercel.app/api/account/payments/cluera/live/webhook` with its dedicated Live secret. Retain the existing Test destination. Use the same supported payment/order/refund/subscription events as the reviewed Test intake. Prepare the Live worker at `/api/internal/billing/cluera/live/tick` with the matching pinned epoch (`CLUERA_LIVE_WORKER_EPOCH` on Render), separate signer, monitoring and durable scheduling.
7. Approve runtime gates deliberately: `CLUERA_LIVE_OWNER_APPROVED`, `CLUERA_LIVE_SECURITY_ACCEPTED`, `CLUERA_LIVE_TEST_ACCEPTED`, `CLUERA_LIVE_RUNTIME_ACCEPTED`. Only after their evidence is accepted, review the `intake` SQL and enable `CLUERA_LIVE_INTAKE_ENABLED` plus `CLUERA_LIVE_SCHEDULER_ENABLED`. Set the dispatcher owner/runtime gates on Render too. These steps still do not authorize a customer sale.
8. Prepare Live catalog revisions through `CLUERA_LIVE_ADMIN_ENABLED` and existing fresh-MFA Admin using actual **Live** plan IDs. For reports/history, use `CLUERA_LIVE_ADMIN_REPORTS_ENABLED`, `CLUERA_LIVE_HISTORY_ENABLED`, `CLUERA_LIVE_NATIVE_HISTORY_READ_ENABLED`. Monthly charging additionally requires its separate native database gate, `CLUERA_LIVE_RECURRING_ENABLED`, `CLUERA_LIVE_CANCELLATION_ENABLED` and accepted methods; Enterprise additionally requires `CLUERA_LIVE_ENTERPRISE_APPROVED`. Leave unsupported tiers disabled.
9. During a controlled sales/usage pause, separately approve bounded Live charging. Apply the reviewed `promote` SQL, set `CLUERA_BILLING_UI_MODE=live`, `CLUERA_LIVE_CHECKOUT_ENABLED=true` and an explicit bounded `CLUERA_LIVE_PURCHASER_IDS` UUID list on Vercel. Deploy/read back both services and bank/profile/epoch before reopening. Keep `CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED` absent/false. Perform one explicitly authorized genuine Live journey and verify payment, signed delivery, grant, usage and settlement independently.
10. Only after genuine Live acceptance, make a separate public-sales/release decision. Invoice/tax documents, supplier cost acceptance, availability and legal obligations are not established by a successful checkout.

To pause new Live sales, turn off the Live checkout gate and withdraw catalog availability while preserving receipt intake, cancellation and reconciliation for existing obligations. Never roll back to code that ignores mode provenance after the Live bank is installed. Do not switch banks while usage is active, delete receipts or compensate uncertainty with manual credits.

## Moving to a custom domain later

The merchant digest and financial IDs are independent of the domain. Origin-bound callbacks and worker signatures are deliberately not portable to an unapproved origin. Keep the staging domain until a coordinated migration is accepted.

For migration, review the exact new domain in Auth/cookie configuration, Google/Supabase redirects, website/desktop links, CSP, billing profile and worker audience. Add the narrow new OAuth return before retiring the old one; expect users to sign in again because cookies are host-bound. Keep receipt processing available while changing the Razorpay webhook destination. Update both services and the database profile together during a controlled sales pause, verify callbacks and reject old-origin worker proofs. Do not use wildcard redirects or copy sessions between domains. Changing DNS alone is insufficient.

## Verification record and Windows next step

Automated checks use synthetic identities, isolated PostgreSQL fixtures and intercepted provider calls. They verify Test/Live separation, explicit checkout, signed receipts, exactly-once grants, all three Live monthly tiers, renewal, preserved cancellation, refunds, account ownership and bounded transport. They do not prove actual inbox delivery, mandate behavior, paid settlement, operational uptime or a physical Windows device.

**Verified runtime checkpoint, October 20, 09:10–09:13 UTC (14:40–14:43 IST):**

| Evidence | Verified result |
| --- | --- |
| Source | [`39d35d92e5c7dce038d73eb93ec1eecaf55f0a53`](https://github.com/kireetikotturu/Cluera-AI/commit/39d35d92e5c7dce038d73eb93ec1eecaf55f0a53), staging; tree `3e655e657e1acb4ad50c8f54e7e6f7942bb97cb4`, 828 blobs. The implementation changed 56 explicitly reviewed paths, including a two-file deployment-target hardening follow-up; 772 prior blobs retained unchanged, no deletions. |
| Website | Vercel `dpl_A4rwpPsXbGyLUfzzpm7MAivApgZr`, READY, exact source. `cluera-ai-staging.vercel.app` assigned and independently read back. The bounded 100 build events show compilation/deployment complete and no error-level event; npm configuration/install-script warnings are not relabelled as errors or hidden. |
| Relay | Render `dep-dbbit567bikc73aob0a0`, LIVE, exact source; health revision independently checked. No error-level log entries in the bounded 09:04:15–09:06:00 UTC rollout window. This is not long-term uptime evidence. |
| Hosted CI | [Run 39397995331](https://github.com/kireetikotturu/Cluera-AI/actions/runs/39397995331), **success**, exact source. **2,369 web passed / 22 opt-in skipped; 417 desktop passed / 1 opt-in skipped; 154 preparation passed.** All typechecks, web/relay/desktop code builds and dependency audits pass. |
| Source/artifacts | Exact hosted scan: **828 files / 0 findings**. Web production build includes the artifact scan and passes. |
| Public boundaries | **16/16** credential-free GET checks passed at `2026-10-20T09:10:51.920Z`: Google enabled, anonymous credits/checkout/history/Admin denied, monthly catalog disabled, release unapproved, exact relay revision. Nine Live account routes return 404/no-store; Live worker GET returns 405. **10/10 additional boundaries pass.** |
| Browser | Isolated, intercepted synthetic financial requests: no automatic order, one explicit mocked create, one mocked callback, exact verified-payment success and automatic balance/history refresh to synthetic 3h 15m. Three monthly offers disabled. Google visible on Create Account; 390px viewport has no horizontal overflow; no page errors in the final check. No credential submission or genuine payment. |
| Data and activation | 2 customers and 2 original trials retained; no payments/events/subscriptions or cancellation/native commands created. Native processing remains false. Live schema/profile/flags remain uninstalled/off. Main remains `3d813f8f88cb3adacffe9afb889efa8ce07476bc`; unrelated local drafts excluded. |

Earlier local runs are separate evidence: the Windows sandbox prevented esbuild fixture resolution; a subsequent full export run found an obsolete container-source assertion, which was corrected and passed in the focused suite. Concurrent preparation exhausted memory; the serial rerun passed all 154 checks. None of those failed runs is relabelled a passing full run. The exact-source hosted result above is the final full-suite authority.

A documentation-only staging follow-up may advance the branch/relay revision while preserving every runtime blob above. Its new revision does not replace the exact runtime/CI evidence pinned here. Genuine payment, device, provider and operating acceptance remain pending; **Live ready: NO**.

This billing checkpoint retained **1.0.7**, which predates later authentication fixes. The subsequent Windows review has now built **1.0.8 unsigned TEST** with those fixes and additional desktop repairs. Follow [Windows V1 release and acceptance](CLUERA_WINDOWS_V1_RELEASE.md) and the exact hash/evidence in [the final launch checklist](CLUERA_FINAL_LAUNCH_CHECKLIST.md). No installer has been executed, publicly uploaded or approved. Real-device/provider/payment acceptance and deliberate GitHub/Admin distribution approval remain required; do not overwrite 1.0.7 or 1.0.8.
