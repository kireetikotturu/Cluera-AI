# Billing review: findings, fixes and what is still open

Scope reviewed: `web/lib/payments/**`, `web/app/api/account/payments/**`, pricing and checkout pages, the Admin billing panel, `backend/billingTransport.ts` + `backend/liveBillingTransport.ts` + `backend/main.ts` (Render worker), `supabase/migrations/**`, `docs/proposals/**` (read only) and `scripts/payments/**`.

**In plain words:** the payment *security design* is sound (see "Checked and found correct" at the bottom). The review found one problem that would have stopped every Live sale, two that could have left a paying customer without credit or taken the AI relay down, and several that blocked flexible plans. Everything that could be fixed in code is fixed and tested. Database changes are written as proposals for you to review and are **not applied**.

Status key: **FIXED** = changed in code and covered by tests. **PROPOSAL** = SQL written under `docs/proposals/`, never run. **OPEN** = not changed; what to do is stated.

## Critical

### 1. The Live "Buy" button could never turn on (FIXED in code; DB repair in proposal)
- Where: [20261021075249_cluera_live_infrastructure_disabled.sql:256](../supabase/migrations/20261021075249_cluera_live_infrastructure_disabled.sql) (also :557). The Live catalog reports `testPlanValidated` for a pack as `false` because the Live copy of the function lacks the `r.kind='PACK' or` guard that the Test copy received ([prepare-cluera-clean-bootstrap.cjs:74-75](../scripts/migrations/prepare-cluera-clean-bootstrap.cjs)).
- Effect: the checkout page requires that flag for every plan ([ClueraCheckoutClient.tsx:439-441](../web/app/account/checkout/ClueraCheckoutClient.tsx)), so the pack showed "Purchases for this plan are not open yet" even with everything else correct.
- Fix: [purchaseAvailability.ts:13](../web/lib/payments/cluera/purchaseAvailability.ts) treats every pack as validated (a pack needs no Razorpay plan). The database function is corrected in [cluera-live-plan-management.sql](proposals/cluera-live-plan-management.sql) (applied later, optional for this bug because the code already covers it).

## High

### 2. A Live payment could wait for credit indefinitely on a sleeping Render plan (FIXED)
- Where: [liveWorker.ts:28](../web/lib/payments/cluera/liveWorker.ts) and the Live webhook route. The Test receiver wakes the Render worker after a stored receipt; the Live receiver did not. A free Render service sleeps after idle and nothing else wakes it.
- Fix: the Live webhook now sends the same best-effort wake after a receipt is durably stored. A failed wake never changes the acknowledgement. Tested in `clueraLiveWebhookWake.test.ts`.
- Still recommended (OPEN, operational): use an always-on Render plan, or keep an uptime monitor on `/healthz`, because a free plan can take about a minute to wake.

### 3. A mistake in the Live worker settings would take the whole AI relay down (FIXED)
- Where: [backend/main.ts:12-14](../backend/main.ts) (before) built the Live payment worker without protection; a wrong `CLUERA_LIVE_WORKER_EPOCH`, secret or origin threw ([shared/liveBillingDispatch.ts:26](../shared/liveBillingDispatch.ts)) and the relay exited for every customer.
- Fix: a bad Live worker setting is now logged (`configuration_unavailable`) and only the payment worker stays off; the AI relay keeps running. Check the Render logs if credits stop arriving.

### 4. Plans were hard-wired to exactly four rows and one pack (FIXED; DB support in proposal)
- Where (before): [publicCatalog.ts:20](../web/lib/payments/cluera/publicCatalog.ts) and [checkout.ts:13-15](../web/lib/payments/cluera/checkout.ts) allowed at most 4 rows with a unique offer code; [billingPresentation.ts:21](../web/lib/cluera/billingPresentation.ts) returned nothing unless there were exactly 4; [AccountPricing.tsx:8](../web/app/AccountPricing.tsx) used the same test; [admin.ts](../web/lib/payments/cluera/admin.ts) capped catalog reads at 4. Any added or removed plan made the pricing page fall back to hard-coded preview prices (₹549 etc.), and on the home page the real catalog was labelled "Razorpay Test catalog".
- Fix: up to 60 rows, uniqueness by revision (monthly offers stay unique), customers see only plans that are On, an empty list shows "No plans are on sale right now" instead of invented prices.
- Design note: every pack keeps the offer code `cluera_pack_3h_v2` because the installed Windows app validates that exact list in its credits response ([AccountApi.ts:29](../desktop/src/main/accounts/AccountApi.ts)); a new code would make the app show "unavailable" for anyone who bought one.

### 5. Two Test orders block the Live switch and no approved exit existed (PROPOSAL)
- Where: [prepare-cluera-live-profile.cjs:39](../scripts/payments/prepare-cluera-live-profile.cjs) rejects `CREATING`, `BOUND` or `UNCERTAIN` Test intents; the ledger only allows `VERIFIED`/`REFUNDED` as other states ([foundation SQL line 2570](proposals/cluera-clean-foundation.sql)), which need a genuinely paid signed event.
- Fix: [cluera-test-intent-closeout.sql](proposals/cluera-test-intent-closeout.sql) closes only the two named intents with an immutable audit row. Not run. See GO_LIVE_FINAL.md step 1.

### 6. A customer who opened checkout cannot continue if you edit, turn Off or remove that plan (OPEN)
- Where: [checkoutResume.ts:19-24](../web/lib/payments/cluera/checkoutResume.ts) and [ClueraCheckoutClient.tsx:173](../web/app/account/checkout/ClueraCheckoutClient.tsx) only resume an order whose plan is still On and current. One unpaid order per customer is allowed at a time, so that customer is blocked from buying again until it is resolved.
- Why not changed: resuming an order from a superseded revision needs a new, separately reviewed resume path.
- Mitigation shipped: the Plans screen shows how many customers have an unpaid checkout open on a plan and warns before an Edit, Turn Off or Remove. Change plans when few people are buying. If a customer is stuck, follow GO_LIVE_FINAL.md step 6; there is no Live close-out SQL yet (write one like the Test proposal, reviewed first).

## Medium

### 7. The old Admin catalog change looked plans up by offer code, which is no longer unique for packs (FIXED)
- Where: [live migration :278](../supabase/migrations/20261021075249_cluera_live_infrastructure_disabled.sql). With several packs it could pick the wrong one.
- Fix: the proposal wraps that function so it refuses packs; the web route also refuses Live pack changes ([admin.ts](../web/lib/payments/cluera/admin.ts)). Pack changes go only through the new Plans actions. Monthly behaviour is unchanged.

### 8. The public Live catalog listed Off and unreleased monthly plans (FIXED)
- Where: [liveRoutes.ts:46](../web/lib/payments/cluera/liveRoutes.ts). Names and prices of hidden monthly plans were visible to anyone who opened the catalog URL. It now returns only plans that are On.

### 9. A foreign (international) card payment would never credit (OPEN, operational)
- Where: [adapter.ts:19](../web/lib/payments/cluera/adapter.ts) accepts only `international: false`; any other payment fails verification, the receipt retries up to 20 times and stays unresolved while the customer has paid.
- Do: keep international payments **off** in the Razorpay Live dashboard. If one appears, use GO_LIVE_FINAL.md step 6 and refund it.

### 10. The Admin checklist mislabelled a finished database switch (FIXED)
- Where: [readiness.ts:67](../web/lib/payments/cluera/readiness.ts). The "database promoted" line also required the Vercel Buy-button flag, so it stayed red after a successful promote. It now judges only the database result; the Buy-button flag is its own line. The catalog line now accepts any pack that is On, not only the original 3-hour pack. Wording is plain English and points to GO_LIVE_FINAL.md.

### 11. GitHub job "web-relay" failed on a clean machine (FIXED)
- Where: [verify.yml](../.github/workflows/verify.yml). `npm run test:preparation` loads `desktop/electron-builder.cluera.cjs`, which reads `electron/checksums.json` ([line 8](../desktop/electron-builder.cluera.cjs), [test](../tests/clueraPackaging.test.cjs)), but this job never installed the desktop packages. It passed on a developer PC because `desktop/node_modules` existed. Fix: `npm ci --prefix desktop --ignore-scripts` before the test. Reproduced and verified on Linux with Node 24.12.0.

### 12. The home and download pages still say "Windows TEST", "Staging only", "Not commercially approved" (OPEN, your decision)
- Where: [AccountWebsite.tsx:9,25,35](../web/app/AccountWebsite.tsx). These describe the unsigned test installer, not billing, so they were left alone. Change them when you are ready to present the app as a public release.

## Low

13. **Test wording on pages real customers see (FIXED).** Removed the "Razorpay Test catalog" eyebrow, the "Test catalog" badge and "Approved Test customers" from the pricing section, and the "Staging" label from the Admin header.
14. **Raw error codes in Admin (IMPROVED).** Read errors now say what to do next; the bracketed code remains only for support.
15. **Free Render sleeps (OPEN).** See item 2.
16. **No audited exit for a stuck Live order (OPEN).** See item 6.
17. **Monthly plans cannot be edited at Razorpay.** A price change on a monthly plan needs a brand-new Razorpay plan, so monthly plans stay hidden/Off and their code is kept.

## Test-ledger code: removed and kept

Removed (purely cosmetic): the pricing "Test catalog" badge and eyebrow, "Approved Test customers" sentence, Admin "Staging" heading, the invented-price fallback when the real catalog is empty.

Kept, with reasons:
- The whole Test ledger, Test webhook, Test checkout and `mode==='test'` strings in [ClueraCheckoutClient.tsx](../web/app/account/checkout/ClueraCheckoutClient.tsx): the promote check and database reconciliation depend on the Test ledger, and the Test path is still the regression path.
- [RazorpayCheckout.tsx](../web/app/account/checkout/RazorpayCheckout.tsx), `PurchasePortal`/`CheckoutClient` (Paddle Sandbox): the older Account-era checkout, only reachable when new billing is switched off; they have their own tests and preserved history. Not demo-only.
- "Grant staging test minutes" in Admin customer controls: Test entitlements, only shown when that gate is on.
- Homepage "Windows TEST": see item 12.
- No test-card hints, mock shortcuts or debug logging were found in the web app; none were removed.

## Checked and found correct

- Webhooks are verified on the raw bytes before parsing: [events.ts:59](../web/lib/payments/cluera/events.ts), [signatures.ts](../web/lib/payments/providers/razorpay/signatures.ts).
- The server, not the browser, decides price: the browser sends only a plan revision id; the amount comes from the database catalog ([checkout.ts:31](../web/lib/payments/cluera/checkout.ts)) and is checked again at the provider ([adapter.ts:130,185,189](../web/lib/payments/cluera/adapter.ts)).
- One order per purchase: unique request id and one unresolved intent per customer ([live migration :84-89](../supabase/migrations/20261021075249_cluera_live_infrastructure_disabled.sql)); the browser callback grants nothing ([checkout.ts:76](../web/lib/payments/cluera/checkout.ts)).
- Idempotent, audited fulfilment and refunds: unique payment/order keys and immutable `applications` rows.
- Test and Live stay separate: separate ledger schemas, grant prefixes, signer audience and RPC name mapping ([modeProfile.ts:64](../web/lib/payments/cluera/modeProfile.ts)).
- Worker calls use a timing-safe proof plus a one-time nonce ([scheduler.ts:52](../web/lib/payments/cluera/scheduler.ts)).
- Plan changes keep every one of these: the database refuses a plan that is Off or superseded, every Admin change is checked for an MFA session inside the database, and each writes an immutable audit row.

## What was not verified

No real Razorpay request, real payment, real database or Vercel/Render deployment was touched. Database changes were tested only on a throw-away in-memory PostgreSQL copy built from the repository's own migrations.
