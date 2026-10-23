# Cluera AI final launch checklist

Updated October 23, 2026 (IST). **Full commercial launch: NO-GO.** Remote Desktop is explicitly excluded from launch at the owner's request. Existing SMTP, Supabase keys/URLs, registration, Admin role and MFA enrollment are complete; do not repeat them.

**October 23 security follow-up:** source now pins Next.js 16.4.2, Vitest 5.0.3 and Electron 44.5.0 after fresh CI identified dependency advisories. See [the production payment handoff](CLUERA_PRODUCTION_PAYMENT_HANDOFF.md) for exact validation/deployment evidence. Windows 1.0.8 is preserved and does not contain the patched Electron dependency. A new immutable build and device/package acceptance are required before distribution; do not release 1.0.8 as patched.

This is the overall launch checklist. Use [Windows V1 release and acceptance](CLUERA_WINDOWS_V1_RELEASE.md) for the new installer and GitHub distribution, and [Billing final setup](CLUERA_BILLING_FINAL_SETUP.md) for payment acceptance. Older next-action instructions below are historical where superseded by those guides.

**Latest payment work:** follow [Production payment handoff](CLUERA_PRODUCTION_PAYMENT_HANDOFF.md). The disabled Live infrastructure is now installed by migration `20261021075249_cluera_live_infrastructure_disabled`; Test is still the active bank, and Live profile/intake/checkout/native gates remain off. At 07:53 UTC October 21, both customers/trials and the retained BOUND Test order were preserved, with zero Test/Live payments or Live grants and no direct application-table privileges. Live eligibility, public-approval access and independent monitoring are implemented and tested. The handoff contains the exact deployment checkpoint and owner-only Test payment, private Live credentials/merchant, operations and activation steps. Do not repeat older Live-schema installation instructions.

Windows 1.0.8 remains immutable and unsigned TEST. Its existing checkout handoff and shared balances are compatible; the current source has a clearer unavailable-checkout message which is not in that installer. No rebuild or public binary approval was performed during this payment follow-up.

The latest October 21 billing follow-up is documented in [Billing final setup](CLUERA_BILLING_FINAL_SETUP.md). **Test remains active; Live charging stays off.** Checkout now re-arms bounded verification after a long payment journey, ignores duplicate callbacks and requires a fresh balance before reporting success. Web/desktop tooling pins Vite 8.3.3 for the newly reported launch-editor advisories; neither development package is in the retained 1.0.8 ASAR, and its EXE/blockmap hashes remain unchanged.

At 05:55:45 UTC October 21, read-only database checks still showed 2 customers, 2 original trials, zero payments/receipts and one BOUND intent. The configured merchant diagnostic on **October 20 at 07:57:30 UTC** verified the retained order as untouched and eligible at that observation. The application rechecks before resuming. At that historical observation, cancellation/native recurring dependencies were installed but disabled and Live was uninstalled. The later migration above installed disabled Live infrastructure; profile and charging remain off. Existing provider configuration, real payment/device acceptance, reliable operations and Live/public-release approval remain required. Follow the updated billing guide's capture, webhook, Test acceptance and later Live checklist; do not repeat completed Auth setup.

Historical October 20 billing runtime checkpoint: [`39d35d92e5c7dce038d73eb93ec1eecaf55f0a53`](https://github.com/kireetikotturu/Cluera-AI/commit/39d35d92e5c7dce038d73eb93ec1eecaf55f0a53); Vercel `dpl_A4rwpPsXbGyLUfzzpm7MAivApgZr` READY/canonical and Render `dep-dbbit567bikc73aob0a0` LIVE. [CI 39397995331](https://github.com/kireetikotturu/Cluera-AI/actions/runs/39397995331) passed **2,369 web, 417 desktop and 154 preparation tests**; 22 web and one desktop opt-in tests remain skipped. Typechecks/builds/audits and the 828-file source scan passed at that checkpoint. The current October 21 evidence is recorded in [Billing final setup](CLUERA_BILLING_FINAL_SETUP.md); historical audit success does not supersede later advisories.

## Windows V1: new immutable 1.0.8 candidate

Current billing/source checkpoint: [`c59d28a5a7bc9c06414a6922af7cbc950acce744`](https://github.com/kireetikotturu/Cluera-AI/commit/c59d28a5a7bc9c06414a6922af7cbc950acce744); Vercel `dpl_BmgaXWQ4PQ71urfJHX8ZvggG3S2q` READY/canonical, Render `dep-dbc5bvuk1f9s73bp93qg` LIVE. [CI 39553231834](https://github.com/kireetikotturu/Cluera-AI/actions/runs/39553231834) passes **2,373 web, 426 desktop and 154 preparation tests**, all typechecks/builds/audits and an 832-file source scan. The 22 web and one desktop private/service tests remain skipped. Public checks pass **16/16 plus 10/10 Live-disabled routes**. The deployed delayed-checkout browser test uses synthetic intercepted financial requests. The full record and original failed-audit run are retained in [Billing final setup](CLUERA_BILLING_FINAL_SETUP.md). A later documentation-only staging/relay revision does not change these runtime blobs or rebuild the installer.

**BUILT / STATICALLY VERIFIED / UNSIGNED TEST. Real-device acceptance and public distribution are pending.** This replaces 1.0.7 as the current candidate; all older installers remain preserved.

~~~text
desktop/release-cluera-staging/1.0.8/ClueraAITestSetup-1.0.8.exe
Product: Cluera AI
Version / FileVersion: 1.0.8
Bytes: 121923717
SHA-256: f8a4536fd130f7c6f7675207d1ea738e9f74c5cdd4703542d3c9f695b39c3927
Authenticode: NotSigned — unsigned TEST only

Blockmap: ClueraAITestSetup-1.0.8.exe.blockmap
Bytes: 128256
SHA-256: b76540696ae508670124f1c65b7f1e1a5c6f6f5154c8c06d32b3be7fdb51e581
~~~

The candidate contains the latest account/Google/session fixes, shared trial/paid-balance integration and existing Gemini/Deepgram, audio, screenshots, context, history, settings and shortcut functionality. New repairs add bounded post-checkout balance observation, hard update transport/body deadlines, safe workspace-initialization retry and fencing of late account responses. Clean builds remove only generated `desktop/dist`, preventing stale renderer assets in the package. Provider gates remain enforced; Remote Desktop remains excluded.

Local verification: **426 desktop tests passed / one opt-in live test skipped**, both TypeScript checks, clean production code build, **154 preparation tests**, desktop npm audit **zero vulnerabilities**, artifact scan **209 files / zero findings**. The actual package passes **2,268 ASAR entries, 97 compiled-file comparisons, three trust-resource comparisons and six security fuses**. The Windows executable's embedded ASAR-header hash and **all 1,937 archive-file hashes/block hashes** match. Its extracted manifest verifier passes **10 offline synthetic/adversarial cases**, with no application or installer execution.

Built-renderer browser checks passed login at 420×360, 800×600 and 1280×800, simulated balance updates, session-editor/footer at 420×360 and 800×600, settings and logout. No horizontal overflow or page errors were observed. These used synthetic IPC and blocked external service requests, not real credentials, payments or hardware. The first expanded archive check failed because its ASAR lookup used POSIX paths on Windows; the checker was corrected and the **same unchanged installer** then passed. That failed check is not relabelled a pass.

Reviewed Windows source: [`bf3e35646ebf25144c0fb278e9e56ecd1ed75ca2`](https://github.com/kireetikotturu/Cluera-AI/commit/bf3e35646ebf25144c0fb278e9e56ecd1ed75ca2), tree `4a2f12af2679a34aa05f354d3ba6a26f83d72070`: **15 explicitly reviewed paths, 831 blobs, 816 prior blobs retained unchanged, no deletions**. Web/backend runtime source is unchanged. Unrelated local drafts are excluded.

**Hosted checkpoint, October 20, 10:10–10:14 UTC / 15:40–15:44 IST:**

| Evidence | Result |
| --- | --- |
| Exact-source CI | [Run 39405727874](https://github.com/kireetikotturu/Cluera-AI/actions/runs/39405727874), **success**, source `bf3e35646ebf25144c0fb278e9e56ecd1ed75ca2`: **2,369 web passed / 22 skipped; 426 desktop passed / one skipped; 154 preparation passed**. All web/relay/desktop typechecks, code builds and dependency audits pass. Exact hosted source scan: **831 files / zero findings**; hosted web artifact scan passes. |
| Website | Existing Vercel `dpl_a2i6sMcSGQBW67YubcositDXTVCz`, **READY**, source `b766b0641e4dfe2eb7b44f2f614c52523784b4c7`; canonical alias independently read back. No web runtime file changed in this Windows release, so no unnecessary website redeployment or environment change was made. |
| Relay | Render `dep-dbbjqujm8hqs739147bg`, **LIVE**, source `bf3e35646ebf25144c0fb278e9e56ecd1ed75ca2`; health revision checked. No error-level entries in the bounded 10:07:45–10:09:10 UTC rollout window; this is not long-term uptime evidence. |
| Public boundaries | **16/16 credential-free GET checks passed** at `2026-10-20T10:10:06.054Z`, including enabled Google, anonymous account/credits/checkout/history/Admin denials, unapproved-release 404 and exact relay revision. |
| Preservation | All **275 desktop source blobs** match the reviewed tree. All **12 retained EXE/blockmap artifacts** rehash unchanged. Main remains `3d813f8f88cb3adacffe9afb889efa8ce07476bc`. |

A subsequent documentation-only staging commit may advance the branch and relay revision while preserving every runtime blob above. The exact Windows source and accepted CI remain pinned here. The installer hash identifies the built bytes; a hosted code build alone is not an installer build or a device acceptance.

At **10:02:24 UTC / 15:32:24 IST**, the read-only database check found **2 customers, 2 original trials, 0 release records, 0 provider records/enabled providers and 0 active usage runs**. No schema, secret, financial flag, provider activation, paid plan or Admin release approval changed. The existing private source repository remains private. No installer was installed, run or uploaded.

**Owner actions:** privately install and accept this exact 1.0.8 hash; finish provider custody and deliberate bounded provider/device testing; accept the retained Test payment and shared-device balance; then explicitly approve distribution. Use the [Windows guide](CLUERA_WINDOWS_V1_RELEASE.md) to publish the accepted EXE/blockmap/checksums in a separate Cluera-only GitHub binary repository, independently download/rehash, and approve the exact release through existing fresh-MFA Admin. Public download remains unavailable until those steps pass. The owner chose unsigned TEST distribution for now; later Authenticode signing uses a new immutable version.

## What is complete and what is gated

| Area | Evidence and current limit |
| --- | --- |
| Authentication | **IMPLEMENTED / AUTOMATED TESTED / DEPLOYED:** email/password, recovery, persistent-session anchors, cookie rotation, account switching, guarded Admin/MFA and Google capability. Google configuration is owner-reported complete and the live capability is **enabled**. Private email, application Google consent/callback and device acceptance remain **OWNER TEST PENDING**. |
| INR 549 pack | Exact 3-hour non-expiring, stackable catalog revision; owner-bound Test checkout, signed receipts, provider verification, exactly-once grant and shared usage ledger. Automatic bounded status polling and safe recovery of the same untouched order are implemented. A genuine paid journey remains unaccepted. |
| Cancellation | End-of-cycle cancellation uses one durable command, preserves the paid term and never repeats an uncertain POST. An ACK is not terminal cancellation. Dependency SQL is applied; runtime activation remains off pending acceptance. |
| Monthly plans | Exact INR 5,499 / 40h, INR 9,599 / 100h and INR 19,549 / 200h revisions; receipt/ledger/usage-refresh/outbox orchestration is implemented behind default-off gates. Dependency SQL is applied with native processing disabled. Purchase policy is **first eligible subscription only**; competing queues/upgrades are blocked before provider CREATE. |
| Monthly financial limitation | Internal paid-time preservation does not prove that Razorpay can defer/restart every supported mandate without another charge/refund. A supported method-specific financial design and owner acceptance are required before opening queues/upgrades or restoring future Pro billing. No speculative reschedule PATCH or automatic subscription recreation exists. |
| History and Admin | Owner-bound customer history is deployed. SELECT-only Admin financial reporting is deployed and its schema/read flag applied; amounts cover validated local records on the current page, never an unresolved order's expected price. It is not settlement proof or a tax invoice. |
| AI | Server Gemini/Deepgram, encrypted credential vault, model controls, cancellation and shared metering are implemented. No customer BYOK. Provider metadata START/terminal recording and Admin reads are deployed; schema/read flag applied, **collection and providers remain off**. Costs remain explicitly unknown without verified rates/invoices. |
| Windows | Account isolation, secure token storage, existing transcription/screenshots/context/settings, update trust and packaged publisher-pin validation are implemented. New immutable **1.0.8 unsigned TEST candidate built/static-verified**, including later Auth and Windows fixes. Real device acceptance and approved distribution remain pending. |
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

The installed-Supabase-SDK regressions exercise recovery email preparation → PKCE callback → MFA-required rejection → existing authenticator verification → same-session AAL2 rotation → separate password submission → sign-out. They also cover a near-expiry token: factor, password and reauthentication calls can proactively refresh the SDK session, so newly rotated credentials are independently authorized and sealed before returning or reporting a later failure. The original recovery deadline remains unchanged. A confirmed password update remains successful even if subsequent credential capture or global sign-out cannot be confirmed; the app never repeats the write. All transport in these regressions is intercepted; no real email, password change or MFA verification is performed by the agent.

## October 20 simplified account flow and OAuth review

The account page now presents the current task: Sign in, Create account, Reset your password or Check your email. Verification resend is contextual; detailed help is collapsed. Disabled Google controls and implementation explanations are removed from the form. Successful email requests show a masked recipient and explicit cooldown without promising delivery. Explicit provider duplicate errors return to sign-in; an unverified-login error offers verification without sending email. Neutral provider responses remain neutral.

Google PKCE now rejects duplicate authorization/callback parameters on both server and browser. An intercepted installed-SDK regression covers Google authorization through callback and session restoration. Admin factor operations preserve independently authorized session refreshes, including later provider failures; restored token assurance and the original owner/session remain mandatory. All **337 focused Auth/authorization tests** and the web typecheck pass. Browser checks exercise signup/reset, explicit duplicate/unverified responses, preserved email and mobile layout without real Auth writes.

Follow [the concise Google setup and account-flow guide](CLUERA_GOOGLE_SIGN_IN.md) for the remaining private Web OAuth client, consent audience and Supabase provider setup. Google is still disabled; real consent and inbox acceptance remain pending. No SMTP/key/Admin/MFA setup was repeated, and no Windows installer was rebuilt. Exact publication/deployment evidence is recorded after hosted checks; this source note is not proof of deployment.

## October 20 Google capability follow-up

The owner completed Google provider configuration. A fresh public capability GET now reports **enabled**, and the live Create account page displays **Continue with Google**. Older open tabs previously retained the initial disabled/unavailable result. Capability refresh now occurs on tab return and switching between Sign in/Create account, with single-flight throttling, a bounded timeout and rejection of late results. These are metadata reads only; no consent, email, account creation or password request starts automatically. Recovery/email-confirmation screens retain their focused flow.

The [Google guide](CLUERA_GOOGLE_SIGN_IN.md) now treats completed private configuration as reference. Earlier disabled observations below are historical. Real application consent, callback, same identity/trial, sign-out and desktop acceptance remain separate.

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

## Historical Windows 1.0.7 checkpoint

Retained historical candidate; use 1.0.8 above for new acceptance:

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

2. **Accept Google application consent and return.** Private Google configuration is owner-reported complete and live capability is enabled; do not repeat it. Follow [the Google account guide](CLUERA_GOOGLE_SIGN_IN.md) to accept web consent/callback and return-to-plan, plus Windows Google sign-in, logout and switching on a current tested build. The same verified identity must keep the same UUID/trial. Keep the existing narrow callback allowlist and SMTP/Admin/MFA setup.

3. **Reconcile the retained Test order.** In the correct [Razorpay Test merchant](https://dashboard.razorpay.com/), inspect `order_TpRplT79SeFnTp`, its attempts, amount paid/due, capture status and delivery to the existing verified webhook. Preserve its binding and all receipts. Resolve the strict numeric warnings and authoritative disposition before another purchase. Do not create a replacement, capture, refund, replay or manually grant credits to make the test pass.

4. **Perform exactly one approved genuine pack journey after Auth and reconciliation pass.** Use the existing approved purchaser and [INR 549 checkout](https://cluera-ai-staging.vercel.app/account/checkout?offer=cluera_pack_3h_v2). Continue the same untouched retained order only if the application independently offers that safe recovery. If pending/failed/uncertain, stop on that attempt. Accept captured INR 549 payment + exact paid order + genuine signed receipt + exactly one non-expiring 10,800-second pack, original trial intact. A browser callback cannot grant credits. Live charging remains off.

5. **Decide and accept monthly financial behavior separately.** Review the [native recurring capability and method restrictions](CLUERA_NATIVE_RECURRING_REVIEW.md). Obtain merchant/method-specific evidence for deferral, queues, upgrades, cancellation and future Pro renewal; explicitly accept any supported restriction or changed financial terms. The current first-subscription-only implementation must not be presented as completed universal queuing. Only then review/apply the financial SQL, immutable Test plan mappings, activation controls and command-resolution procedure. Accept all three prices/allowances, renewal, no rollover, recurring-before-pack consumption, fixed grace, cancellation, full refunds, failures, duplicate/out-of-order events, saved Pro restoration and two-device exhaustion. No monthly catalog/flag should be enabled merely because synthetic tests pass.

6. **Establish encryption custody privately.** In [Cluera Vercel settings](https://vercel.com/kireetikotturus-projects/cluera-ai-staging/settings/environment-variables) and [Cluera Render environment](https://dashboard.render.com/web/srv-db6r6som7kps73b1r4g0/env), provision the same dedicated `CLUERA_PROVIDER_VAULT_KEYRING_BASE64`. It encodes a keyring with one active key ID and fresh 32-byte key material; retain separately encrypted offline recovery escrow. Do not reuse cookie, rate, Supabase, webhook, worker or signing secrets. Follow the [vault custody format and synthetic-envelope check](CLUERA_AI_PROVIDER_VAULT.md). No keyring was generated by this audit.

7. **Provision disabled providers, then deliberately authorize bounded spending.** After custody/synthetic verification, enable Vercel `CLUERA_PROVIDER_VAULT_ENABLED=true` and Render `CLUERA_AI_BOOTSTRAP_MODE=admin-vault`, reload the reviewed services and verify metadata/denials. Use existing [Admin/MFA](https://cluera-ai-staging.vercel.app/account/admin) to save Gemini/Deepgram keys disabled, test metadata and approve compatible default models while providers remain disabled. Before enabling a provider or starting the first accepted request, deliberately accept bounded spending and enable Render `CLUERA_PROVIDER_TELEMETRY_ENABLED=true` only with its applied schema and accepted vault mode, so the first accepted operation is recorded. Then deliberately enable the intended provider. Test text, screenshot, both audio channels, cancel/interruption, expiry, disable/outage, exhausted balance and shared devices. Verify durable START/terminal or truthful UNCONFIRMED metadata without content/secrets. Cost remains unavailable until accepted rates/invoices exist. If custody/verification fails, return to auth-only and preserve receipts.

8. **Accept the exact Windows candidate on a real device.** Verify the 1.0.8 hash using `Get-FileHash -Algorithm SHA256`, install normally, sign in/restart, verify secure restoration, logout/A-B isolation and shared trial/paid balances. Check high-DPI/bottom controls, shortcuts, files/context/screenshots, both audio channels, assist/cancel and usage settlement. Use a genuinely newer approved version for update acceptance. Remote Desktop is excluded. This candidate is unsigned TEST software.

9. **Approve immutable distribution after device acceptance.** Choose Cluera-only asset hosting, independently download and rehash exact bytes/size, then deliberately approve that release in fresh-MFA Admin. Verify product/audience/channel/version/origin/hash and download/update behavior. Commercial certificate custody, exact bundled publisher pin and a new signed immutable build require a separate owner decision. No public binary was uploaded or approved.

10. **Accept security and operations.** Review [Supabase Auth security](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/settings), including leaked-password protection and actual plan support before paid changes. Assign reliable scheduler capacity, monitor host, alert destination/on-call owner, retention, backup/restore and incident procedures. The [fixed health reader](CLUERA_OPERATIONS_HEALTH.md) exits 0 for an observation, 1 for attention and 2 for unavailable; connect it only in a trusted private environment with existing credentials, never a new public/shared secret store. Measure sleeping/cold-start/backlog/renewal recovery and restored data. Approve paid infrastructure explicitly. Confirm business identity, tax/invoice/refund/privacy/terms and support obligations.

11. **Give final Live and public-release acceptance.** Only after engineering policy, private/device/payment/provider and operating gates pass, reconcile real merchant/Live/Paddle obligations, approve exact Live mappings/webhook/signer/worker ownership and separately authorize bounded Live acceptance. Do not reuse Test identifiers, enable simultaneous financial writers or bypass remaining gates. Explicit approval is required for Live charging and public commercial release.

## Complete acceptance journey and rollback

New ordinary signup → newest verification email → login/reload → select accepted plan → one approved payment → provider-authoritative verification + genuine signed webhook → exactly one entitlement → install approved Windows build → same identity → start/cancel/use AI → website/Windows balances agree after settlement → logout/switch exposes no other customer's data. Test trial reuse, recurring expiry, actual exhaustion and concurrent devices separately. One successful pack purchase does not accept monthly lifecycle or supplier cost accounting.

Record source revision, deployment IDs, UTC/IST timestamps, private test-account references, original provider/grant IDs and measured balance deltas. Keep secrets and raw customer/provider payloads out of public records.

For launch, finish financial policy and acceptance, review exact source/CI/schema, deploy the existing Cluera services and verify actual revisions and `npm run verify:staging -- <exact-relay-commit>`. Prepare a named operator, alerts, accepted rollback revision, immutable assets and restore evidence before promotion.

For an incident, stop new sales/provider starts through their reviewed gates with the appropriate operational authority; preserve receipts, ledger rows and uncertain commands. Roll back compatible Cluera web/relay code and withdraw an affected release through its audited workflow. A code rollback does not reverse external financial writes or schema. Never repair an incident by replaying an order, deleting financial history, granting minutes, rotating secrets or reverting schema blindly.
