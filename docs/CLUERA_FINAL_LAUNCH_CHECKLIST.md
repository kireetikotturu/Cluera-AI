# Cluera AI final launch checklist

Updated October 19, 2026 (IST). **Commercial release: NO-GO.** This is the consolidated current handoff. Older next-action paragraphs in other guides are historical; completed SMTP, Supabase keys/URLs, owner registration, Admin role and MFA enrollment must not be repeated.

## Evidence labels

- **IMPLEMENTED**: reviewed source exists; it does not establish hosted configuration or real customer acceptance.
- **AUTOMATED TESTED**: the named checks passed on the named source. Skips and earlier failures are separate.
- **DEPLOYED**: the platform's actual revision and endpoint were independently read back.
- **OWNER TEST PENDING**: requires a private identity, Google consent, financial authorization or a real Windows device.
- **PRODUCTION READY**: all functional, financial, security, release and operating gates accepted together. This label does not currently apply.

## Current infrastructure and conserved state

| Component | Independently observed October 19 |
| --- | --- |
| GitHub | [Cluera-AI staging](https://github.com/kireetikotturu/Cluera-AI/tree/staging), `f7ea42ff27ba1a15de717665b927116402557df0` at initial audit; `main` remains `3d813f8f88cb3adacffe9afb889efa8ce07476bc` |
| Website | [Canonical staging](https://cluera-ai-staging.vercel.app), Vercel `cluera-ai-staging`, READY `dpl_Cm2mdQbj91wYtDDwtLrmGSExsYom`, exact `f7ea42ff` at initial audit |
| Relay | [Render service](https://dashboard.render.com/web/srv-db6r6som7kps73b1r4g0), LIVE `dep-dbaobt9srm7s73amb0c0`, exact `f7ea42ff` at initial audit; health HTTP 200 |
| Database | [Cluera Supabase](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg), clean Cluera project only |
| Business state | 08:36:57 UTC / 14:06:57 IST read: 2 customers, 2 trials, 1 BOUND intent, 0 payments, 0 events, 0 applications, 0 provider credentials, 0 Cluera releases |
| Public boundary audit | 08:42:03 UTC / 14:12:03 IST: 16/16 credential-free GET checks pass, matching relay revision. Google disabled; three monthly offers disabled; no approved release |

The supplied local `.git` has an unborn `staging` branch and no remote/history. Publication must use the independently verified GitHub parent, an explicit reviewed file list and an expected-head non-forced update. Never publish every untracked local file. Pre-existing operator/schema drafts are not automatically release changes. SigmaRoundAI License Edition and its infrastructure are outside this task.

## Current engineering work

The October 19 completion pass implements these repairs; exact final test/publication evidence is recorded below when complete:

- Admin SDK session restoration retains rotated refresh credentials only after the original owner/session is independently verified. MFA results are reauthorized before storing an AAL2 session. Rejected release operations preserve an already rotated cookie.
- Admin MFA success refreshes the navigation assurance fence before actionable controls load, preserving pending-operation protection across subsequent focus checks.
- Pending checkout reconciliation refreshes status automatically within a bounded read budget. It never opens Checkout or creates another order. Billing rate limits retain HTTP 429 with a safe wait instruction.
- Relay cancellation during provider preparation does not create a usage reservation. Token expiry is rechecked after preparation. Empty, blocked and thought-only Gemini responses become bounded provider errors.
- Installer publisher verification is enforced when a publisher is configured; the separate unsigned TEST channel remains explicitly unsigned.
- A current fixed-target, GET-only staging checker validates catalog amounts, anonymous API denial, neutral Admin HTML, unapproved release denial, Google capability and relay revision. It never claims private acceptance or production readiness.
- Publication path validation rejects traversal, dot/empty segments and Windows drive/alternate-stream syntax before reading files.

Subscription cancellation work is default-disabled and requires separately reviewed additive SQL. An accepted future-cancellation command must preserve the paid current term; a provider ACK must not fabricate terminal cancellation, remove credits or replay an uncertain POST. See the cancellation implementation/review for its final scope. No schema or flag is enabled merely by adding source.

## Feature readiness and remaining engineering

| Area | Implemented foundation | Remaining gate |
| --- | --- | --- |
| Authentication | Email verification, password login/recovery/change, cookie rotation, persistent-session anchors, same-owner/account-switch fences, guarded Admin/MFA, public Google capability | Private email/session/recovery/Google/device acceptance |
| INR 549 pack | Server price revision, owner-bound Test order, raw webhook signatures, provider-authoritative verification, exactly-once non-expiring 10,800-second pack | Reconcile retained attempt; genuine captured payment + paid order + signed receipt + one grant + Windows balance |
| Monthly INR 5,499/9,599/19,549 | Immutable 40/100/200-hour revisions, Test resource/invoice validation and recurring term processing behind gates | Provider plan mapping, lifecycle command schema/activation and acceptance; complete cross-subscription queuing, pause/resume, upgrades and Pro-to-Enterprise restoration. Do not enable monthly sales before this engineering is complete |
| History | Owner-bound read API/UI; tracked SELECT-only migration applied and separate read flag saved | Next reviewed deployment/read-back and private customer acceptance; downloadable invoices and full Admin financial reporting remain separate work |
| AI | Server Gemini/Deepgram adapters, encrypted vault, model controls, shared reservations/settlement; no customer BYOK | Dedicated encryption custody, disabled credential provisioning, model approval, metered provider acceptance; durable provider-cost telemetry remains engineering work |
| Windows | Account isolation, secure token store, transcription/screenshots/context/settings/update trust and explicit TEST distribution | New candidate build verification, real device acceptance, immutable hosting and fresh-MFA approval; commercial signing |
| Enterprise | Server plan/feature authority retained | Remote Desktop transport/consent and full Enterprise acceptance are unfinished; do not advertise availability or bypass entitlement checks |
| Scheduling/operations | Authenticated bounded worker transport and redacted process logs | Reliable always-on scheduling/capacity, catch-up/backlog monitoring, durable alerts, retention and restore drill; a sleeping free relay is not a commercial renewal guarantee |

## Windows candidate

Retained immutable candidate:

```text
desktop/release-cluera-staging/1.0.3/ClueraAITestSetup-1.0.3.exe
121924027 bytes
SHA-256 d8e782a3cfa18ceb3e10f90940a403f3d0277e701953cc7db1644c17ac078a59
Authenticode: NotSigned — unsigned TEST only
```

New **1.0.5** candidate is built and independently static-verified:

```text
desktop/release-cluera-staging/1.0.5/ClueraAITestSetup-1.0.5.exe
121924952 bytes
SHA-256 f34e02edd07f7fbe26cbc06bfbdc5b7902e98f033c5def55dbdac6be65459a7b
Authenticode: NotSigned — unsigned TEST only
Blockmap: 128446 bytes
Blockmap SHA-256 efedf2d1a3819df2bb1a0326c972b9277e919b8fecdee4e86d219efee138c577
```

Packaging/verifier passes2277ASARentries. Independent static audit matches all106distfiles and3resourcefiles, exact product/version/public-key pin and all6Electron fuses. Compiled Google target/capability/IPC guards pass; extracted pure manifest verifier passes12offline synthetic/adversarial cases with an ephemeral key. No application/installer was launched, uploaded or approved. Initial1.0.4packaging failed ENOSPC before producing an installer; its version directory/failure record is retained and never reused. Reproducible caches, three old test exports, failed unpacked scratch and only1.0.0's old unpacked build were cleaned with bounded verified paths; every existing installer/blockmap is retained. Existing candidate versions must never be overwritten.

## One consolidated owner checklist

Complete these in order when their stated prerequisites are satisfied. Never paste passwords, MFA codes, payment credentials, provider keys or encryption keys into chat or Git.

1. **Accept existing email login and persistence.** Open [Cluera account](https://cluera-ai-staging.vercel.app/account) in a private browser. Sign in with the existing verified support account, reload, then open a second tab. Confirm dashboard identity and balance remain correct. Sign out, confirm both tabs lose protected access, then sign in again. Do not repeat registration, SMTP or MFA enrollment.
2. **Accept recovery and account switching.** Use Forgot password once and the newest email link in that same browser. Confirm a password can be reset, the recovery screen exits correctly, ordinary change-password requires the current password, and old/reused/expired links fail safely. Use a separate ordinary test account to confirm cross-account data isolation, normal users have no Admin navigation, and direct Admin APIs remain denied. The owner performs these real identity/email mutations.
3. **Finish Google private setup and consent.** In [Google Cloud credentials](https://console.cloud.google.com/apis/credentials), use the intended Cluera OAuth web client and authorized redirect `https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/callback`. Configure consent/app audience/test users as appropriate. Privately save its client ID/secret in [Supabase Google Auth](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/providers). Retain [Auth URL configuration](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/url-configuration): web return `https://cluera-ai-staging.vercel.app/api/account/callback` and narrow native loopback `http://127.0.0.1:43822/cluera/callback\?state=*`. Test real consent, selected-plan return, logout and account switching on web and Windows. Google is currently disabled; code readiness is not completed private setup.
4. **Reconcile the existing Test attempt before any new purchase.** In the correct [Razorpay dashboard](https://dashboard.razorpay.com/), select the previously configured Test merchant/mode. Inspect retained order `order_TpRplT79SeFnTp`, its payment attempts, capture status, amount paid/due and webhook delivery. Preserve its existing binding. A fresh protected GET-only diagnostic using the actual configured Test merchant completed at09:00:10UTC/14:30:10IST:2orders(1created/1attempted),9payments(7authorized/2failed/0captured),0refunds and0subscriptions. Both order amount-paid fields failed strict numeric validation; inventory is not financial clearance. The separate Razorpay connector could not find this order and was not proven to use the same merchant/mode. Do not create a replacement order, capture, refund, replay an event or grant credits on either result. Resolve the exact original resource's authoritative disposition first; the local row remains BOUND.
5. **Perform one genuine Test payment only after reconciliation and Auth acceptance.** The controlled purchaser remains the existing approved support account. Open [checkout](https://cluera-ai-staging.vercel.app/account/checkout?offer=cluera_pack_3h_v2), use the existing retained attempt where offered, and complete exactly one approved Test journey. If pending/failed/uncertain, stop and inspect the same attempt. Accept captured INR 549 payment + paid exact order + ordinary signed webhook + exactly one 10,800-second non-expiring pack. Preserve the original trial. A browser callback alone cannot grant credits. Do not activate Live mode.
6. **Provision provider encryption custody privately.** Use only [Cluera Vercel settings](https://vercel.com/kireetikotturus-projects/cluera-ai-staging/settings/environment-variables) and the [Cluera relay environment](https://dashboard.render.com/web/srv-db6r6som7kps73b1r4g0/env). A new dedicated 32-byte KEK/keyring must have encrypted offline recovery escrow separate from DB backups. Follow [vault custody requirements](CLUERA_AI_PROVIDER_VAULT.md). This is a secret change requiring owner action/authorization; it has not been performed. Verify a synthetic envelope round-trip before enabling the vault. Do not reuse cookie, Supabase, webhook, worker or signing keys.
7. **Provision providers disabled, then accept bounded spending deliberately.** With the existing Admin/MFA session, save Gemini/Deepgram credentials disabled in [Admin](https://cluera-ai-staging.vercel.app/account/admin), verify metadata and compatible models, then explicitly authorize the bounded metered provider test/activation. Test text, screenshot/image, both audio channels, cancellation, interruption, expired sessions, exhausted balances and two-device sharing. Check recurring usage is consumed before pack usage once recurring engineering is accepted. No spending was performed by this audit.
8. **Run Windows acceptance on the final verified candidate.** Verify the published handoff hash locally with `Get-FileHash -Algorithm SHA256`, install normally, sign in, restart and test secure restoration, logout and A/B isolation. Check high-DPI bottom controls, shortcuts, files/context/screenshots, both audio channels, assist/cancel, shared website balance and usage history. Use a genuinely newer approved candidate for the update test. Never interpret an unsigned TEST installer as Authenticode-signed.
9. **Approve distribution only after device acceptance.** Choose immutable Cluera-only asset hosting, independently download and verify exact hash/size, then deliberately approve the matching release through fresh-MFA Admin. Verify signed update claims, product/audience/channel/version/origin/hash and public download behavior. Commercial publisher signing and certificate custody remain separate owner decisions. No binary publication is authorized by a source deployment.
10. **Accept security and commercial operations.** Review [Supabase Auth security](https://supabase.com/dashboard/project/yhnqlfcgrmckhyjdxegg/auth/settings); the advisor still reports leaked-password protection disabled. Confirm available plan support before any paid change. Approve a reliable scheduler/service plan if needed; configure alert destinations, backup/restore ownership, retention/support and incident response. Confirm business identity, pricing/tax/refund/privacy/terms and support channels. Approve any paid infrastructure explicitly.
11. **Final financial and public launch approval.** Only after engineering and all acceptance evidence is complete, reconcile real merchant/Live/Paddle obligations, approve exact Live mappings/webhook/signer/worker ownership and perform a separately approved bounded Live acceptance. Do not reuse Test identifiers or create simultaneous financial writers. Explicit owner approval is required for Live charging and public commercial release.

## One complete real-world acceptance journey

After the above prerequisites: new ordinary customer signup → latest verification email → login and reload → select intended plan → one approved payment → provider-authoritative verified payment and signed webhook → exactly one entitlement → install approved Windows build → login with the same identity → start/cancel/use an AI session → website and Windows balances agree after settlement → logout/account switch exposes no other customer's data. Monthly renewal/cancel/expiry/queue/upgrade/refund and two-device exhaustion need additional lifecycle scenarios; one successful pack purchase does not accept those features.

Record exact source revision, deployment IDs, UTC/IST timestamps, test account references, retained provider IDs, grant IDs and measured balance deltas privately. Keep secrets and raw customer/provider payloads out of the public checklist.

## Launch and rollback procedure

1. Finish outstanding engineering; review the exact staging delta, tests, dependency scans and schema proposals. Apply approved migrations as tracked atomic changes with bounded locks and before/after conservation evidence. No historical migration replay.
2. Deploy the reviewed exact commit to the existing Cluera staging project/relay, verify READY/LIVE revisions and run `npm run verify:staging -- <exact-relay-commit>`. Run private acceptance on that exact candidate. Preserve independent Google, payment, AI, Windows and operating evidence.
3. Complete financial/public release approvals. Prepare a named owner, alert/on-call destination, rollback revision, release assets and database restore evidence. Promote only the reviewed source and approved immutable installer; never overwrite `main` or force-push.
4. On an incident, stop new sales/provider starts using the reviewed gates only with the appropriate operational authority; preserve all financial receipts/ledger rows and uncertain operations. Roll back Cluera web/relay to the last compatible accepted revision and withdraw an affected release through its audited workflow. Do not replay orders/events, delete ledger rows, rotate secrets or revert schema blindly. Application rollback does not reverse external financial writes or database changes.

## Final verification/publication record

This section is updated after each completed verification. Initial live revision is recorded above; uncompleted work must not be called deployed or production-ready.

- Fresh npm audits: web, backend and desktop each report **0 vulnerabilities**, October 19. Registry checks succeeded outside the network-restricted sandbox; no install/update was performed.
- Current public staging boundaries: **16/16 passed** on initial deployed `f7ea42ff`; checker unit/security regressions **3/3 passed**.
- Full local preparation: **147/147 passed** using an unchanged-source short drive alias and process-local canonical Git safe-directory setting. Initial native-path failures were esbuild ancestor access denial; an independently discovered publication traversal bug was fixed and regression-tested. No deadlines/assertions were relaxed. Hardened boundary regressions10/10 pass; initial3/3 above is a separate earlier checkpoint.
- Auth focused tests: **114/114** and **149/149** in overlapping suites; do not add the totals. Web typecheck passed at that checkpoint.
- Full web checkpoint: **1940 passed/23 skipped**,143files(134passed/9skipped),353.91s. Skips are not passes. Subsequent resume/native-Google/history integration additions require their own final checks. Web typecheck/production build and105-file artifact scan pass; backend typecheck/build pass. Working-source scan734files/0historyblobs/0findings passes at that checkpoint; this is not a full-history claim.
- History migration **20261019085323** applied with SHA-256 **7a0a066b9fd880f6ca9810a728a4048e5874e08c252c7a8f81b50022d38e1406**. Live body/ACL/config/index verification and anonymous denial pass; all86 pre-existing function definitions retain their before digest. One non-secret Production-named staging history flag was added; all49 pre-existing Vercel entries compare unchanged. Two customers/two trials/oneBOUND intent/zero financial applications/providers/releases remain unchanged at08:57:20UTC.
- Protected inventory diagnostic **dpl_GR6frH5vWCxjLVnLrBCZHbS5RC5U** used exact reviewedf7ea42ff,6GETs/0mutations, verified actual configured Test merchant and completed bounded inventory. IntentionalERROR/exit2 produced no website artifact or promotion; canonical website remained on its priorREADY deployment. Existing strict order warnings and unresolved obligations remain, with no capture/refund/replay/credits.
- Complete desktop suite **375passed/1opt-in skipped**; both TypeScript configurations and hardened renderer/main build pass. New1.0.5package and independent static verification pass as detailed above. Initial1.0.4ENOSPC failure is not relabeled as a pass; subsequent immutable1.0.5is the accepted static candidate.
- Final local web recheck executes **2008passing assertions/23skips**, but its suite result is **FAILED** because Windows denied removal of one synthetic scheduler fixture during afterAll. The bounded own-fixture cleanup was corrected without changing assertions/deadlines/permissions checks; focused rerun **34passed/1Windows-inapplicable skip**, including cleanup, passes. This full run is not relabeled successful. The nine live suites account for22opt-in skips; the additional local skip is the POSIX-permissions case on Windows.
- Full packaged-artifact scan passes **292files/0historyblobs/0findings**. Final hosted full CI, publication commit and new deployment IDs: **pending completion of this engineering pass**.
