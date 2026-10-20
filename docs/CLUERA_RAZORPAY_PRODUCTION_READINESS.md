# Cluera Razorpay billing: staging readiness and owner guide

**Superseded setup instructions:** use [CLUERA_BILLING_FINAL_SETUP.md](CLUERA_BILLING_FINAL_SETUP.md) for the latest October 20 engineering, database and owner steps. The configured-merchant diagnostic subsequently verified the retained order as untouched and eligible at 07:57:30 UTC. Monthly dependency SQL is now applied with processing disabled. An isolated Live implementation and unapplied schema proposal are prepared; charging remains off. The older observations and deployment checkpoint below remain historical evidence for their exact source.

Updated October 20, 2026 (IST). **STAGING ONLY**, as confirmed by the owner during this review. **LIVE READY: NO.** No payment, mandate, capture, refund, replay, credit grant, financial migration, flag activation or public release is authorized by this document.

Use only [Cluera staging](https://cluera-ai-staging.vercel.app/pricing), [Cluera Supabase](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg), the existing Cluera Vercel project and the Cluera Render relay. Signup, email/password and Google OAuth remain in place. Existing SMTP, application keys, Admin role and MFA enrollment do not need repeating. Remote Desktop is excluded.

## What is implemented

| Area | Engineering behavior | Acceptance limit |
| --- | --- | --- |
| Pricing | Exact current revision prices; honest disabled public buttons; no “View availability” detour. The plans page uses the same guarded checkout as the account page. | Public purchases remain unavailable. Only the existing approved Test purchaser can open an eligible checkout. |
| Explicit checkout | An authenticated eligible account sees Buy Now or Subscribe Now. The full price, allowance and renewal terms appear before the action. Viewing a page makes no order, loads no payment SDK and opens no mandate. | A signed-out customer signs in and returns to the selected plan, then explicitly confirms the purchase. A URL never authorizes a purchase. |
| Pack | ₹549, INR 54,900 paise, exactly 10,800 seconds, no expiry, stackable. One fresh server claim creates one order; unknown creation outcomes cannot trigger another POST. | The retained order must be reconciled before another purchase. |
| Verification | Raw signed webhook plus independent canonical order/payment/invoice evidence drives exactly-once fulfillment. Checkout callbacks verify their signature and binding but grant nothing. | A callback or provider success screen alone is not payment acceptance. Closing the browser does not replace the durable webhook worker. |
| Progress and success | Bounded automatic status checks, a fresh balance read after resolution, automatic owner-bound history and an exact-payment success message. Success requires the callback's payment ID, revision and amount to match a VERIFIED server history record. Refunded or unrelated rows cannot produce success. | Unknown or pending outcomes stay locked. After bounded observation, the customer can check status or contact support without creating a new order. |
| Request safety | Browser requests and response bodies are bounded to 15 seconds and 128 KiB; transports that ignore abort still settle. No automatic payment retry. Account changes invalidate old responses and close the old checkout. | A timeout does not establish that the provider received no request. |
| Monthly sales | First subscription only. A catalog entry cannot enable monthly checkout unless native recurring processing, receipt intake, scheduler and cancellation gates are also enabled. Enterprise additionally requires `CLUERA_ENTERPRISE_CHECKOUT_APPROVED=true`. The server checks before creating an intent or contacting Razorpay. | All monthly plans remain unavailable in the current deployment. Financial SQL and acceptance are still pending. |
| Shared usage | Website and Windows use the same authenticated customer, usage grants, reservation/settlement ledger and once-only trial. Eligible recurring allowance is consumed before packs. | Real two-device exhaustion and once-only trial acceptance remain private/device checks. The existing installer has not been rebuilt. |
| Cancellation | Durable command, end-of-cycle provider request, uncertain-outcome preservation and independent terminal observation. Paid access remains until its paid cutoff. | Separate cancellation migration and flag remain unapplied/off. An ACK is not terminal cancellation. |
| Refunds and history | Verified full refunds revoke unused entitlement; immutable receipts, applications and tombstones preserve audit and duplicate/out-of-order handling. Customer history automatically reads validated records for the current account. | This is not settlement proof or a tax invoice. Partial/ambiguous provider evidence is not silently converted into a full refund. |
| Administration | Existing Admin role plus fresh MFA protects immutable future catalog revisions and financial reports. Browser metadata or an email address cannot grant Admin. | No financial settings were changed during this review. |

The callback signature authenticates a browser callback. A genuine canonical paid event can still be fulfilled when the customer closes the browser before that callback; making fulfillment depend on a browser remaining open would break recovery.

## Plan availability

| Plan | Terms | Current availability |
| --- | --- | --- |
| 3-hour pack | ₹549 once; 10,800 seconds; non-expiring; packs stack | Guarded Test path only. The retained purchaser's unresolved order blocks another purchase. |
| Pro 40 hours | ₹5,499/month; 144,000 seconds per paid period | Disabled pending first-subscription lifecycle, cancellation and method acceptance. |
| Pro 100 hours | ₹9,599/month; 360,000 seconds per paid period | Disabled pending the same acceptance and an exact immutable Test plan mapping. |
| Enterprise 200 hours | ₹19,549/month; 720,000 seconds per paid period | Disabled; separate feature, lifecycle and payment-method acceptance required. Remote Desktop is not included. |

Monthly hours do not roll over. A one-day grace interval does not grant new hours. A mandate's authorization is not a paid invoice. Cancellation preserves the existing paid term but stops future renewal only once the provider-authoritative outcome is confirmed.

Queues, upgrades and automatic restoration of future Pro billing are **not available**. The internal scheduler preserves funded allowance and calendar time, but this does not prove that every supported Razorpay mandate can be deferred or restarted without another debit. No speculative reschedule PATCH or automatic subscription recreation exists.

Razorpay documents that UPI and eMandate subscriptions cannot use the update endpoint. Its FAQ describes merchant/category-specific UPI limits and additional authentication for higher card debits. Therefore ₹19,549 Enterprise must not promise universal UPI AutoPay or unattended renewal. Let Razorpay display only methods accepted for the actual merchant and plan; do not generate a separate QR. See [subscription updates](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/) and [subscription payment-method restrictions](https://razorpay.com/docs/payments/subscriptions/faqs/). These provider restrictions do not establish that Cluera's complete financial design is accepted.

## Retained order and observed state

`order_TpRplT79SeFnTp` is still **BOUND** in the Cluera database. A read-only aggregate check during this review found 2 customers, 2 original trials, 0 Cluera payments, 0 events, 0 subscriptions and 0 applications; processing owner remains Cluera, epoch 1.

The separate Razorpay connector returned “id does not exist”, but its merchant/mode was not established as the configured Test merchant. This is **not clearance** and must not justify a replacement order.

A protected GET-only obligations diagnostic of reviewed source `de928f04358bb8571aa5ec4a8ec0204a94122c0a`, deployment `dpl_6M8a6E2dJa7hsimqAXbwPcTFmEGJ`, stopped at its phase-specific configuration guard at `2026-10-20T06:46:31.952Z`, with 0 provider requests and 0 mutations. It intentionally produced no website artifact and did not replace the canonical site. The earlier October 19 configured-merchant observation remains historical: two orders, nine payments, no captures, with strict numeric warnings. Neither observation authorizes a new attempt.

Same-order continuation is offered only after independent checks prove an untouched, exactly bound order: created, zero attempts, zero payments, numeric paid amount zero and full amount due. An attempted, authorized, failed, captured or malformed order is not resumable through this path. Do not normalize malformed amounts, abandon the binding or manufacture a successful receipt.

## Verification and deployment record

The focused local billing suite passes **210 tests** across 11 files, including PostgreSQL financial fixtures, signed receipts, preserved legacy ingestion, shared grants, native lifecycle, unknown-outcome handling, history isolation, exact success proof and blocked monthly creation. Web and desktop typechecks pass. All **154 preparation tests** pass with one worker and normal filesystem access; the sandboxed run failed before several assertions because esbuild could not resolve parent directories. The local web production build and artifact scan passed before the final sign-in-link refinement; exact-source hosted CI is the final build authority. Synthetic tests use intercepted provider requests; no customer payment or mandate was performed.

**DEPLOYED / AUTOMATED TESTED checkpoint, October 20 at 07:12 UTC (12:42 IST):**

| Evidence | Verified result |
| --- | --- |
| Runtime source | [`fc0e35a7eeaf8a97d21b4dfcf792b63c09ff9f84`](https://github.com/kireetikotturu/Cluera-AI/commit/fc0e35a7eeaf8a97d21b4dfcf792b63c09ff9f84), staging only; 26 explicit reviewed files; 801 total source blobs; no deletions or unrelated drafts |
| Website | Vercel `dpl_HAR2wGjrACqqEbz7CGsBytki8q25`, READY; exact source; canonical alias assigned and independently read back |
| Relay | Render `dep-dbbh5j3m8hqs738u6s0g`, LIVE; same exact source; health revision verified |
| Hosted CI | [Run 39384325767](https://github.com/kireetikotturu/Cluera-AI/actions/runs/39384325767): **2,281 web passed / 22 opt-in skipped**, **417 desktop passed / 1 opt-in skipped**, **154 preparation passed**; all typechecks, web/relay/desktop code builds and dependency audits passed |
| Source/artifacts | Exact hosted source: **801 files / 0 findings**; web artifact scan passed; Vercel's bounded 98 build events contained no error-level event |
| Public boundaries | **16/16 credential-free GET checks passed** at `2026-10-20T07:12:32.762Z`; Google enabled; anonymous credits/checkout/history/Admin denied; monthly catalog disabled; release still unapproved |
| Browser | Deployed pricing, real narrow SDK CSP and intercepted synthetic checkout/callback/history: no automatic order, one explicit mocked create, one mocked callback, exact verified-payment success, automatic balance to 3h 15m, three disabled monthly offers, no page errors |
| Signed-out/mobile/Auth | Selected pack returns through `/account?offer=cluera_pack_3h_v2#login`; Google visible on Create Account; 390px viewport has no horizontal overflow; no credential submission |
| Preserved boundary | Main remains `3d813f8f88cb3adacffe9afb889efa8ce07476bc`. No financial/SQL/environment/provider activation, real payment, mandate or binary publication |

The browser used an isolated context with all financial requests intercepted. Its displayed balance is synthetic, not a real paid grant. The actual database remains subject to the retained-order blocker. Skipped service/device tests remain skipped. Full genuine Test acceptance is **OWNER ACCEPTANCE PENDING**.

A documentation-only staging follow-up may advance the branch and deployment revision while preserving all runtime blobs from this checkpoint. The measured runtime/CI evidence above remains pinned to the exact feature commit; it is not inferred from a later documentation commit.

## One owner checklist

1. **Confirm Auth privately.** Sign in at [Account](https://cluera-ai-staging.vercel.app/account), reload and verify the same identity and 15-minute once-only trial. Complete real Google consent/sign-out/account switching if not yet accepted. Do not repeat the already completed provider setup.
2. **Reconcile the retained Test order in the correct merchant.** Open [Razorpay](https://dashboard.razorpay.com/) in Test mode. Find `order_TpRplT79SeFnTp`; compare amount, paid/due, attempts, capture state, payments and delivery to the existing Cluera webhook. Resolve the strict numeric warnings and record the authoritative disposition. Keep all IDs/receipts. If the order is absent, establish the merchant/key/account mismatch first. Do not create, capture, refund, replay or manually grant time to bypass the blocker.
3. **Accept one pack journey only after reconciliation.** Use the existing approved purchaser and [selected pack](https://cluera-ai-staging.vercel.app/account/checkout?offer=cluera_pack_3h_v2). Continue the retained order only if the application independently permits it. Stop on failed/pending/unknown outcomes. Accept exact captured ₹549 + paid order + genuine signed webhook + exactly one non-expiring 10,800-second grant, with the original trial intact. Check automatic balance/history and the same balance on Windows.
4. **Choose the monthly scope.** Accept first-subscription-only restrictions, or obtain a merchant/method-specific design for queues/upgrades and future Pro restoration before expanding it. Review [native recurring evidence](CLUERA_NATIVE_RECURRING_REVIEW.md). Review the cancellation proposal, native recurring proposal, usage-refresh bridge and native history proposal together before applying their financial SQL. Confirm reliable receipt processing and independent scheduling before enabling `CLUERA_RECURRING_SCHEDULE_ENABLED` or `CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED`.
5. **Create/verify monthly Test mappings privately after approval.** In the correct Test merchant, use monthly interval 1 and exact INR amounts 549900, 959900 and 1954900 paise. Preserve immutable plan IDs in future catalog revisions through fresh-MFA Admin; verify provider amounts and finite cycle count. Accept each intended method, actual paid invoice, renewal, failure/grace, cancellation, full refund, duplicate/out-of-order delivery and two-device exhaustion. Do not enable Enterprise merely because a plan ID exists; its separate acceptance flag defaults off.
6. **Accept operations and support.** Assign a reliable external scheduler, alerts/on-call owner, receipt/backlog monitoring, retention and a restore drill. The existing [operations reader](CLUERA_OPERATIONS_HEALTH.md) observes; it does not perform recovery. Record customer-facing support, refund, privacy, terms and invoice obligations. Paid infrastructure requires its own approval.
7. **Leave Live off.** The owner requested staging only. Do not replace Test keys or set `RAZORPAY_ENVIRONMENT=live` on this deployment. Follow the future Live checklist below only after successful Test acceptance and a separate explicit owner decision.

## Future Live setup — not an activation recipe for staging

Razorpay maintains separate Test/Live keys and transaction records; Test transactions do not move into Live. See [Test and Live modes](https://razorpay.com/docs/payments/dashboard/test-live-modes/). Cluera's current runtime deliberately accepts only Test keys, Test mode, its pinned merchant and this staging project.

Before Live implementation/activation, record the approved production origin, merchant identity, enabled methods, business/KYC status and supported monthly policy. Then complete a separately reviewed cutover:

- Use a dedicated Live key pair, Live webhook secret and Live plan IDs. Never paste them into chat or Git, reuse Test identifiers, or put them into `NEXT_PUBLIC_*`. Keep the current Test variables and receipts intact.
- Add a separate Live configuration profile with exact origin/project checks and an independently verified Live merchant digest. Current `RAZORPAY_TEST_*` variables are Test-only; no `RAZORPAY_LIVE_*` variable is consumed by this staging runtime.
- Implement and test separate Live financial storage/RPC routing, immutable mode identity, event/payment uniqueness, merchant ownership, plan mappings, worker proofs and grant provenance. The current `cluera_billing_private` writer and `razorpay-test:*` grants are Test-specific. **This engineering work remains required; switching keys is insufficient.** Do not mix Test-paid time with Live entitlements.
- Provision a distinct Live webhook destination and signer, bounded worker/scheduler ownership and rollback controls. Validate raw signatures, canonical captures, invoices and deduplication against that exact Live profile. Keep Test intake operational as needed to settle existing Test obligations; do not run two writers over the same financial records.
- Reconcile existing Test, Live and historical Paddle obligations. Accept an exact rollback revision, immutable deployment source, secret custody, backup/restore and incident owner.
- Only after the above and explicit owner approval, authorize one bounded genuine Live acceptance journey. Review merchant receipts, signed delivery, exactly-once entitlement and settlement separately. Then make a separate public-release decision.

**CODE COMPLETE** applies to the tested staging changes described above, not universal monthly queues or a Live runtime. **TESTED** means automated synthetic evidence unless a private acceptance is explicitly recorded. **DEPLOYED** requires the exact hosted record. **OWNER ACCEPTANCE PENDING** applies to genuine payment/device/provider/operations journeys. **LIVE READY remains NO.**
