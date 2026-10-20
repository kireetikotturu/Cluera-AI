# Cluera AI final launch checklist

Updated October 20, 2026 (IST). **Full commercial launch: NO-GO.** Remote Desktop is explicitly excluded from launch at the owner's request. Existing SMTP, Supabase keys/URLs, registration, Admin role and MFA enrollment are complete; do not repeat them.

This is the single owner checklist. Supporting documents contain technical evidence, not additional setup approvals. Older next-action instructions elsewhere are historical.

## What is complete and what is gated

| Area | Evidence and current limit |
| --- | --- |
| Authentication | **IMPLEMENTED / AUTOMATED TESTED / DEPLOYED:** email/password, recovery, persistent-session anchors, cookie rotation, account switching, guarded Admin/MFA and Google capability. Private email, Google consent and device acceptance remain **OWNER TEST PENDING**. Google is currently disabled. |
| INR 549 pack | Exact 3-hour non-expiring, stackable catalog revision; owner-bound Test checkout, signed receipts, provider verification, exactly-once grant and shared usage ledger. Automatic bounded status polling and safe recovery of the same untouched order are implemented. A genuine paid journey remains unaccepted. |
| Cancellation | End-of-cycle cancellation uses one durable command, preserves the paid term and never repeats an uncertain POST. An ACK is not terminal cancellation. Code/tests are complete; its separate financial SQL and activation flag remain unapplied/off. |
| Monthly plans | Exact INR 5,499 / 40h, INR 9,599 / 100h and INR 19,549 / 200h revisions; new receipt/ledger/usage-refresh/outbox orchestration is implemented and synthetically tested behind default-off gates. Financial SQL is unapplied. Purchase policy is **first subscription only**; competing queues/upgrades are blocked before provider CREATE. |
| Monthly financial limitation | Internal paid-time preservation does not prove that Razorpay can defer/restart every supported mandate without another charge/refund. A supported method-specific financial design and owner acceptance are required before opening queues/upgrades or restoring future Pro billing. No speculative reschedule PATCH or automatic subscription recreation exists. |
| History and Admin | Owner-bound customer history is deployed. SELECT-only Admin financial reporting is deployed and its schema/read flag applied; amounts cover validated local records on the current page, never an unresolved order's expected price. It is not settlement proof or a tax invoice. |
| AI | Server Gemini/Deepgram, encrypted credential vault, model controls, cancellation and shared metering are implemented. No customer BYOK. Provider metadata START/terminal recording and Admin reads are deployed; schema/read flag applied, **collection and providers remain off**. Costs remain explicitly unknown without verified rates/invoices. |
| Windows | Account isolation, secure token storage, existing transcription/screenshots/context/settings, update trust and packaged publisher-pin validation are implemented. Immutable 1.0.7 unsigned TEST candidate built/static-verified. Real device acceptance and approved distribution remain pending. |
| Operations | SELECT-only health RPC applied; bounded fixed-target monitor reports stale admission, backlogs, quarantine and unsettled usage. It never performs recovery. Reliable independent scheduling, alert delivery, retention, restore drill and capacity acceptance remain gates. |

No label above establishes **PRODUCTION READY**. Source, synthetic tests, hosted deployment and owner acceptance are distinct.

Concrete repairs include rotated Admin/MFA session retention, assurance refresh before Admin controls, payment 429 handling, bounded pending polling, same-order recovery without CREATE/retry, cancellation during provider preparation without a usage START, token expiry rechecks, rejection of empty/blocked/thought-only Gemini answers, configured Authenticode enforcement plus post-verification rehash, publication traversal rejection, bounded private reports and durable metadata uncertainty.

## October 20 account-flow follow-up

Signup, sign-in, verification resend, forgot/reset password and support were reviewed again. Failed sign-in and ordinary signed-out session checks now preserve the pending email link's sealed verifier and original expiry; explicit logout and completed callbacks still clear it. Upstream sign-in throttling remains HTTP 429 with a bounded retry delay for both web and native clients.

Password-recovery requests now share the email cooldown after success, throttling or an unknown outcome. Email-only forms explain email validation, sign-in failures give neutral next steps, and inline help explains latest-link/same-browser recovery and provides the fixed support address. The explicit **Check sign-in status** action reads the existing session without resending credentials or email and stays disabled during writes.

Desktop source now exposes support before sign-in, rejects malformed Google loopback callbacks, bounds unresponsive account requests/cleanup and browser-opening waits, and fences late initialization errors. These desktop changes are **source fixes**: the retained immutable **1.0.7 installer predates this follow-up** and has not been rebuilt or redistributed.

Local verification: **198 focused web/Auth/installed-SDK tests**, **57 focused desktop tests**, web and desktop typechecks, and the web production build/artifact scan pass. These checks use synthetic identities and intercepted requests. Actual inbox delivery, one real signup/verification/sign-in/reload and a controlled reset/new-password sign-in still need the owner's private acceptance. Follow [the existing acceptance procedure](CLUERA_AUTHENTICATION_ACCEPTANCE.md); do not repeat completed SMTP/key/Admin/MFA setup. Commercial launch and the Remote Desktop exclusion are unchanged.

## October 20 MFA and recovery correction

A read-only Auth-log review for 03:30–04:25 UTC identified two password-update rejections with **`insufficient_aal`**. The recovery session was valid, but its enrolled authenticator had not been verified. The previous app mapped this to a generic session error and provided no MFA step. Both existing identities were already email-verified before that window; no signup was awaiting confirmation. A successful resend request therefore did not establish that another signup email should be sent. No SMTP failure appeared in the inspected errors; this is not proof of new-inbox delivery.

Password security now checks the current recovery deadline and existing factors before enabling an update. An enrolled account verifies its existing six-digit authenticator code, then explicitly submits its new password. MFA keeps the same owner/session and original recovery deadline; it does not unlock the workspace, enroll/remove factors, retry a password update or send mail automatically. Expired recovery offers an explicit sign-out/restart. Definitively ended sessions can still be signed out locally; service outages and account mismatches are not reported as successful logout.

Resend verification now uses neutral request-received feedback and explains that it applies only to an **unverified signup**. Already verified users choose **Sign in**; a forgotten password uses **Forgot password**. Signup verification, password-reset email, authenticator code and optional reauthentication email code are separate steps. Google sign-in is shown only on signup/sign-in screens. Existing SMTP, confirmation requirements and MFA enrollment are retained.

The installed-Supabase-SDK regression exercises recovery email preparation → PKCE callback → MFA-required rejection → existing authenticator verification → same-session AAL2 rotation → separate password submission → sign-out. It verifies that MFA preserves recovery restrictions and never submits the password automatically. All transport in that regression is intercepted; no real email, password change or MFA verification is performed by the operator.

## Verified October 19 deployment checkpoint

| Component | Independently verified evidence |
| --- | --- |
| Reviewed runtime source | [staging runtime 83a8c241e864e5787656d1c21784d0f8dbd74815](https://github.com/kireetikotturu/Cluera-AI/commit/83a8c241e864e5787656d1c21784d0f8dbd74815), exactly 82 reviewed integration changes after the earlier 62-file completion slice; main remains `3d813f8f88cb3adacffe9afb889efa8ce07476bc` |
| Website | [Canonical staging](https://cluera-ai-staging.vercel.app), READY `dpl_BBLuD4KMFY73YnLi6DykoR9jqHwq`, exact reviewed source; canonical alias read back |
| Relay | [Cluera Render](https://dashboard.render.com/web/srv-db6r6som7kps73b1r4g0), LIVE `dep-dbav2n67bikc73f2rpl0`, same exact source; health 200/no-store/revision match |
| Hosted CI | [39237997137](https://github.com/kireetikotturu/Cluera-AI/actions/runs/39237997137): 2,122 web tests passed / 22 opt-in skipped (150 files passed / 9 skipped); 401 desktop passed / 1 opt-in skipped; 154 preparation passed; all typechecks/builds/audits passed. Exact hosted source: 785 blobs / 0 findings |
| Public boundaries | 21/21 credential-free GET checks passed at 10:39:10–10:39:30 UTC / 16:09:10–16:09:30 IST: 16 fixed checks plus 5 new-route checks. Correct catalog, anonymous report/resume denial, disabled cancellation/native-command denial, neutral Admin HTML, disabled Google, unapproved release denial and exact relay revision |
| Integration scope | Complete reviewed tree adcf07886004d2ce18b034a80aa66ae0ba3683b7: 930 entries / 785 blobs, 82 exact source changes, 703 retained blobs unchanged, no deletions. Native financial/history/command-review SQL and activation remain gated; read-only financial/provider reporting is deployed. |

This checkpoint records validated runtime at 10:39 UTC. A later documentation-only staging commit may advance the branch/relay revision while retaining this exact runtime code; source/CI acceptance remains pinned above. Vercel has 100 bounded build events / 0 errors: exact clone, zero advisories, compilation/build/deployment and protected capability check pass. Render error-level logs contain 0 entries in the bounded 10:30:45–10:34:00 UTC rollout window. This is bounded evidence, not long-term reliability.

The supplied local Git directory is an unborn staging export with no remote/history. Publication uses the verified GitHub parent, explicit scanned/blob-pinned changes and expected-head non-forced updates. Unrelated local drafts are excluded. SigmaRoundAI License Edition and main are unchanged.

## Applied database and configuration

Only [Cluera Supabase yhnqlfcgrmckhyjdxegg](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg) is used.

Applied migrations now consist of the two original clean migrations plus:

| Migration | Effect |
| --- | --- |
| `20261019085323_cluera_customer_billing_history` | One service-only STABLE SELECT RPC and two indexes |
| `20261019095014_cluera_operations_health` | One service-only STABLE SELECT RPC and seven indexes |
| `20261019095719_cluera_admin_financial_report_read` | One service-only STABLE SELECT RPC and two indexes |
| `20261019095939_cluera_provider_usage_metadata` | Two empty private RLS metadata tables, immutable receipts, lookup index and service-only metadata RPCs |

Each application preserved all prior function definitions and the checked business state. There are 50 application tables, zero tables missing RLS and zero direct CRUD/TRUNCATE grants to anon, authenticated or service_role. Intentional service-RPC RLS-without-policy INFO and the existing leaked-password-protection WARN remain; dependency audit success does not waive the Auth warning.

At 10:36:36 UTC / 16:06:36 IST: **2 customers, 2 original trials, 1 original BOUND intent, 0 payments/events/applications/paid usage grants/provider credentials/releases**. Metadata tables are empty. No financial command/fulfilment writer migration, order, capture, refund, signed-event replay, credit grant, provider activation or binary publication was performed.

All 49 original Vercel environment entries compare exactly unchanged without decryption. Only three plain, Production-named **staging read** flags were added: `CLUERA_BILLING_HISTORY_ENABLED`, `CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED` and `CLUERA_PROVIDER_USAGE_READ_ENABLED`. Native recurring, subscription cancellation and provider collection flags remain absent/default off. No secret was created or rotated.

The existing order is `order_TpRplT79SeFnTp`. A protected GET-only diagnostic using the actual configured Test merchant at 09:00:10 UTC found 2 orders (1 created, 1 attempted), 9 payments (7 authorized, 2 failed, 0 captured), 0 refunds and 0 subscriptions. Both order amount-paid fields failed strict numeric validation. This is **not financial clearance**. The separate Razorpay connector was not proven to use the same merchant/mode. No replacement order or automatic capture/refund/replay is permitted on either observation.

Technical evidence: [history](CLUERA_BILLING_HISTORY_REVIEW.md), [same-order recovery](CLUERA_EXISTING_CHECKOUT_RECOVERY.md), [Admin report](cluera-admin-financial-report-review-2026-10-19.md), [provider metadata](CLUERA_PROVIDER_TELEMETRY_REVIEW.md), [operations](CLUERA_OPERATIONS_HEALTH.md), [native recurring limitation](CLUERA_NATIVE_RECURRING_REVIEW.md).

## Windows candidate and automated verification

Current immutable candidate:

~~~text
desktop/release-cluera-staging/1.0.7/ClueraAITestSetup-1.0.7.exe
Product: Cluera AI
Version / FileVersion: 1.0.7
Bytes: 121925178
SHA-256: 52a4dc54b5d48e34bf4143c29c31ae35df77ea05e1473f1f7bd1c3064cc2b961
Authenticode: NotSigned — unsigned TEST only

Blockmap: 128558 bytes
SHA-256: 78783d240e163c6e792b4c82612389c6daa2b5c0b762e68ec8184291cec11b7d
~~~

Package verification passes 2,277 ASAR entries and six hardened Electron fuses. Independent static verification matches all 106 built files and three trust resources, current Google target and compiled publisher loader. The packaged pure manifest verifier passes 10 offline synthetic/adversarial cases with an ephemeral key. No installer/application was run, uploaded or approved.

Full desktop suite: **401 passed / 1 opt-in skipped**. Full preparation: **154/154 passed**. Combined new reporting/metadata/native/operations/relay/UI checkpoint: **216/216 passed** before final monthly presentation additions. Final reporting/command/history checkpoint **75/75** and final native/customer checkpoint **172/172** pass; these overlap and must not be added. An earlier concurrent PGlite run exhausted memory; unchanged source passed with one worker. Hosted full CI above is the final exact-source result. Web/backend typechecks and relay build pass. Working-export source scan: 782 files / 0 findings at an earlier checkpoint; final scanned inventory has 791 local files including intentionally excluded drafts, and the exact published tree contains 785 reviewed blobs; packaged-artifact scan: 316 files / 0 findings. Final exact hosted counts are recorded in the publication checkpoint, not inferred from local drafts.

Web/backend/desktop npm audits each report zero vulnerabilities. Historical local web run with 2,008 passing assertions and 23 skips still **FAILED** on Windows fixture cleanup; bounded own-fixture retry fixed that cleanup without relaxing assertions/deadlines/permissions checks. It is not relabelled a passing full run. Subsequent exact-commit hosted CI is separate evidence. Skipped real-service/device tests remain skipped.

Earlier 1.0.3 and 1.0.5 installers/blockmaps remain preserved. Failed 1.0.4 (disk full) and 1.0.6 (sandbox download denied) versions are retained as failed and never reused. Only verified reproducible caches/unpacked outputs were removed to regain disk headroom; installers, credentials, databases and other products were preserved. No candidate version is overwritten.

## One owner checklist

Do these in order when the stated prerequisites are satisfied. Never paste passwords, MFA codes, merchant/provider keys or encryption keys into chat or Git.

1. **Accept existing Auth and the once-only trial.** Open [Account](https://cluera-ai-staging.vercel.app/account) privately, sign in with the existing support account, reload and open a second tab. Confirm the same identity/dashboard/balance. Sign out and confirm protected access ends in both tabs. Test latest-link password recovery, ordinary current-password change, reused/expired links and A/B isolation with an ordinary test account. Normal users must have no Admin navigation and no Admin API access. A verified customer gets one 900-second lifetime trial; reinstall and a second device must not create another.

2. **Finish Google private configuration and real consent.** In [Google credentials](https://console.cloud.google.com/apis/credentials), use the intended Cluera web OAuth client and redirect `https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/callback`. Configure consent audience/test users, then privately save client ID/secret in [Supabase Google provider](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/providers). Retain [Auth URL configuration](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/url-configuration): web return `https://cluera-ai-staging.vercel.app/api/account/callback` and narrow loopback pattern `http://127.0.0.1:43822/cluera/callback\?state=*`. Accept web consent and return-to-plan, plus Windows Google sign-in, logout and switching; same verified identity must keep the same UUID/trial. Do not repeat existing SMTP/Admin/MFA setup.

3. **Reconcile the retained Test order.** In the correct [Razorpay Test merchant](https://dashboard.razorpay.com/), inspect `order_TpRplT79SeFnTp`, its attempts, amount paid/due, capture status and delivery to the existing verified webhook. Preserve its binding and all receipts. Resolve the strict numeric warnings and authoritative disposition before another purchase. Do not create a replacement, capture, refund, replay or manually grant credits to make the test pass.

4. **Perform exactly one approved genuine pack journey after Auth and reconciliation pass.** Use the existing approved purchaser and [INR 549 checkout](https://cluera-ai-staging.vercel.app/account/checkout?offer=cluera_pack_3h_v2). Continue the same untouched retained order only if the application independently offers that safe recovery. If pending/failed/uncertain, stop on that attempt. Accept captured INR 549 payment + exact paid order + genuine signed receipt + exactly one non-expiring 10,800-second pack, original trial intact. A browser callback cannot grant credits. Live charging remains off.

5. **Decide and accept monthly financial behavior separately.** Review the [native recurring capability and method restrictions](CLUERA_NATIVE_RECURRING_REVIEW.md). Obtain merchant/method-specific evidence for deferral, queues, upgrades, cancellation and future Pro renewal; explicitly accept any supported restriction or changed financial terms. The current first-subscription-only implementation must not be presented as completed universal queuing. Only then review/apply the financial SQL, immutable Test plan mappings, activation controls and command-resolution procedure. Accept all three prices/allowances, renewal, no rollover, recurring-before-pack consumption, fixed grace, cancellation, full refunds, failures, duplicate/out-of-order events, saved Pro restoration and two-device exhaustion. No monthly catalog/flag should be enabled merely because synthetic tests pass.

6. **Establish encryption custody privately.** In [Cluera Vercel settings](https://vercel.com/kireetikotturus-projects/cluera-ai-staging/settings/environment-variables) and [Cluera Render environment](https://dashboard.render.com/web/srv-db6r6som7kps73b1r4g0/env), provision the same dedicated `CLUERA_PROVIDER_VAULT_KEYRING_BASE64`. It encodes a keyring with one active key ID and fresh 32-byte key material; retain separately encrypted offline recovery escrow. Do not reuse cookie, rate, Supabase, webhook, worker or signing secrets. Follow the [vault custody format and synthetic-envelope check](CLUERA_AI_PROVIDER_VAULT.md). No keyring was generated by this audit.

7. **Provision disabled providers, then deliberately authorize bounded spending.** After custody/synthetic verification, enable Vercel `CLUERA_PROVIDER_VAULT_ENABLED=true` and Render `CLUERA_AI_BOOTSTRAP_MODE=admin-vault`, reload the reviewed services and verify metadata/denials. Use existing [Admin/MFA](https://cluera-ai-staging.vercel.app/account/admin) to save Gemini/Deepgram keys disabled, test metadata and approve compatible default models while providers remain disabled. Before enabling a provider or starting the first accepted request, deliberately accept bounded spending and enable Render `CLUERA_PROVIDER_TELEMETRY_ENABLED=true` only with its applied schema and accepted vault mode, so the first accepted operation is recorded. Then deliberately enable the intended provider. Test text, screenshot, both audio channels, cancel/interruption, expiry, disable/outage, exhausted balance and shared devices. Verify durable START/terminal or truthful UNCONFIRMED metadata without content/secrets. Cost remains unavailable until accepted rates/invoices exist. If custody/verification fails, return to auth-only and preserve receipts.

8. **Accept the exact Windows candidate on a real device.** Verify the 1.0.7 hash using `Get-FileHash -Algorithm SHA256`, install normally, sign in/restart, verify secure restoration, logout/A-B isolation and shared trial/paid balances. Check high-DPI/bottom controls, shortcuts, files/context/screenshots, both audio channels, assist/cancel and usage settlement. Use a genuinely newer approved version for update acceptance. Remote Desktop is excluded. This candidate is unsigned TEST software.

9. **Approve immutable distribution after device acceptance.** Choose Cluera-only asset hosting, independently download and rehash exact bytes/size, then deliberately approve that release in fresh-MFA Admin. Verify product/audience/channel/version/origin/hash and download/update behavior. Commercial certificate custody, exact bundled publisher pin and a new signed immutable build require a separate owner decision. No public binary was uploaded or approved.

10. **Accept security and operations.** Review [Supabase Auth security](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/settings), including leaked-password protection and actual plan support before paid changes. Assign reliable scheduler capacity, monitor host, alert destination/on-call owner, retention, backup/restore and incident procedures. The [fixed health reader](CLUERA_OPERATIONS_HEALTH.md) exits 0 for an observation, 1 for attention and 2 for unavailable; connect it only in a trusted private environment with existing credentials, never a new public/shared secret store. Measure sleeping/cold-start/backlog/renewal recovery and restored data. Approve paid infrastructure explicitly. Confirm business identity, tax/invoice/refund/privacy/terms and support obligations.

11. **Give final Live and public-release acceptance.** Only after engineering policy, private/device/payment/provider and operating gates pass, reconcile real merchant/Live/Paddle obligations, approve exact Live mappings/webhook/signer/worker ownership and separately authorize bounded Live acceptance. Do not reuse Test identifiers, enable simultaneous financial writers or bypass remaining gates. Explicit approval is required for Live charging and public commercial release.

## Complete acceptance journey and rollback

New ordinary signup → newest verification email → login/reload → select accepted plan → one approved payment → provider-authoritative verification + genuine signed webhook → exactly one entitlement → install approved Windows build → same identity → start/cancel/use AI → website/Windows balances agree after settlement → logout/switch exposes no other customer's data. Test trial reuse, recurring expiry, actual exhaustion and concurrent devices separately. One successful pack purchase does not accept monthly lifecycle or supplier cost accounting.

Record source revision, deployment IDs, UTC/IST timestamps, private test-account references, original provider/grant IDs and measured balance deltas. Keep secrets and raw customer/provider payloads out of public records.

For launch, finish financial policy and acceptance, review exact source/CI/schema, deploy the existing Cluera services and verify actual revisions and `npm run verify:staging -- <exact-relay-commit>`. Prepare a named operator, alerts, accepted rollback revision, immutable assets and restore evidence before promotion.

For an incident, stop new sales/provider starts through their reviewed gates with the appropriate operational authority; preserve receipts, ledger rows and uncertain commands. Roll back compatible Cluera web/relay code and withdraw an affected release through its audited workflow. A code rollback does not reverse external financial writes or schema. Never repair an incident by replaying an order, deleting financial history, granting minutes, rotating secrets or reverting schema blindly.
