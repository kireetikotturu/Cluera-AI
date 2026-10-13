# Cluera AI — implementation and migration
Updated October 13, 2026. Staging only; unsigned TEST, not commercial readiness.

## Implemented product
Cluera is the renamed Account product with independent source, packages, Windows identity, release trust, repository and deployment targets. The owner explicitly approved reusing Account Supabase **dwqltsqumiwsxtkzdoaa / Cluera AI-staging / Mumbai**, not creating another customer population. Cluera and old Account share cloud identities, trials, balances, context and administration; this is NOT database isolation.

```text
cluera-ai/
  desktop/     Electron main, narrow preload, renderer, resources, tests, own lock
  web/         Next customer/Admin/BFF, payment adapters, tests, own lock
  backend/     ESM relay, Dockerfile, own package/lock
  supabase/    historical Account migrations; additive Cluera release DDL
  scripts/     provenance, deployment, UI preview, private preparation, scans
  tests/       source preparation and packaging/private-copy regressions
  docs/        implementation, architecture, setup, security and acceptance
```

Canonical shared contracts remain under desktop/src/shared and are consumed within this repository. No imports or dependency junctions into another product. Dependencies are independently installed. License-only runtime, credential editing, activation routes and old release repositories are removed from Cluera, not from original SigmaRound.

## Source and protected references
Derived from all 581 pinned blobs of Account migration **6e3a4d45111d0f9916881314d5ea8b08b22eef4b**, with exactly 24 explicitly reviewed local Account1.0.11 UI/source/test overlays. The ignored 591-file preparation reference is not deployed. Source preparation independently verifies Git path/mode/tree/blob hashes and rejects incomplete trees, case collisions, private/generated files and overwrites.

License export retains 260 exact blobs of original main **d7477fd00bd11f16484f6e25c9cd3df124a2b74d**, source package1.0.7; it is not asserted to have built the existing License1.0.8 EXE. Original branches, dirty source and old EXEs remain untouched. Original migration and main are never publication targets. Only original temporyguide.md may receive a status record.

## Identity and visual experience
Cluera desktop1.0.0: package cluera-ai-desktop, appID ai.cluera.desktop; per-user install Programs/Cluera AI; profile cluera-ai-desktop-staging; database cluera-ai.sqlite. New channel cluera-beta, audience cluera-ai-desktop-test-update, issuer cluera.ai. New Ed25519 public SPKI fingerprint:
**89d6409d29c8eed4f583936bdd2cab0b84a97b15552c340f5697b7336da6c5c1**.
No Account/License private signing material reused. No automatic updater publication, installer execution or upload.

Dark-first lavender/teal identity covers website, login/signup, dashboard, customer/Admin, settings and desktop artwork. Account1.0.11 changes retain password visibility/clearing and serialized authentication, unsaved session drafts, file-removal errors, safe save/upload ownership fences, scrollable content and an independent visible footer. Additional dashboard deletion fixes preserve concurrently added sessions, fence unmount and serialize same-ID deletion. Credits explain unavailable checkout without falsely inferring a global pause.

Admin retains explicit reads, local search/navigation, catalog/model/provider/customer/usage/release/audit controls, uncertain-operation UUID/body locks, live-session and AAL2 checks. Email alone never grants Admin. The retained SQL test-allowance marker remains **account-staging**; mechanically renaming it was caught and corrected before any hosted mutation.

## Payments and retained data
New Cluera financial routes require an additional **CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED=true**, absent/false by default. Razorpay checkout/intake, Paddle new checkout and all new reconciliation/scheduling remain disabled. No Test credentials/tester list is automatically copied, no recurring/Stripe/Live enabled. Existing old Account site/relay, checkout/intake configuration and Test webhook **TmqOkUNGtvEPLz** URL/secret/events are protected.

Read-only October13 01:23:39–01:31:54UTC evidence matches seven complete-table digests and counts: accounts4/trials4; grants/packs/terms0; old releases1; Paddle intents5/recoveries3/receipts9/jobs7; Razorpay intents1 BOUND/bound order1, receipts/applications/diagnostics0, attributed grants0. This is bounded DB evidence, not provider capture/payment acceptance. The BOUND lock must not be retried/recovered/paid. No writer, event/replay, manual worker wake or credit grant is authorized.

Historical migrations are retained byte-for-byte and NEVER replayed against this backend. Local **20261013021137_cluera_release_distribution.sql** adds only a separate Cluera release registry and bounded service-only audited RPCs. It is reviewed/tested locally but **not applied remotely yet**; no seeded/approved release. Old Account release records remain independent.

## Accepted local evidence
- Complete desktop: **355 passed /1 opt-in skipped**,54 files.
- Complete web: **654 passed /22 opt-in skipped**,84 files.
- Root provenance/packaging/private preparation: **16/16**.
- Both desktop typechecks, web typecheck, backend typecheck and desktop/Next16.3.8/backend production builds pass.
- Actual compiled desktop renderer: **19 synthetic browser checks** covering login/password clearing/signup handoff/dashboard/session save/footer/widths800–1280, zero HTTP writes/provider calls/page errors. Synthetic browser bridges are not native IPC/Auth or provider acceptance.
- Customer/Admin synthetic previews at320/390/1280 have no horizontal overflow. Original private browser cookies/session were not inspected.
- Final archive2,275 entries/six fuses, packaged DOCX extraction and151-file artifact scan pass. Installer121,924,096 bytes, SHA25689a15bc914174c24d019ba650a350128119d88193dbd8e52b2b7f36399a46b53, Authenticode NotSigned. It was not executed/installed/uploaded. A no-window isolated development-Electron synthetic OS encryption round-trip returned os_encryption_unavailable; real Windows secure storage/login is UNACCEPTED. Failed intermediate paths are not accepted passes.

Windows ancestor-path esbuild restrictions were handled with a temporary same-source drive alias, and test TEMP remained inside Cluera. No ACL, execution policy, assertion, deadline or Electron security flag was relaxed. A label assertion and build-hook path issue were corrected. The verifier now requires the actual final installer/archive and independently checks six hardened fuses.

Desktop dependency audits still contain findings: fresh full13 (5 moderate/8 high), production3 moderate. Two underlying advisories propagate to several package entries. [http-cache-semantics advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) affects the development download toolchain; [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) affects the unused Mammoth CLI chain. Neither lists an accepted patched version. Unused Mammoth CLI/argparse/sprintf-js are excluded from the archive; actual packaged DOCX extraction passes without those excluded CLI modules. No advisory is hidden or counted fixed merely by exclusion. Web/backend reports were zero at the local checkpoint.

## Explicit local migration and rollback
Cloud identity and trial/balance continuity require no import or reset. New desktop profile starts clean and requires fresh authentication. Do NOT copy encrypted refresh credentials, old database files or old profile directories automatically.

Future local-history import must be a separate owner-invoked workflow: dry-run verified Account source identity, backup immutable source bytes, bind the signed-in same UUID, copy only selected supported history/settings/documents into the new profile, record provenance and expose rollback. Secure tokens are excluded; no old profile is rewritten. That importer is a documented future option, **not implemented or falsely claimed complete**. Old Account can remain side-by-side as the rollback reference.

## Remaining owner and acceptance boundary
See [private setup](CLUERA_STAGING_SETUP.md). Private existing service-role and Gemini/Flux credentials, new cookie/rate/signing settings and additive Auth redirect/template configuration are genuine owner actions; never paste values in chat. Existing Auth callbacks/Site URL and Google Cloud client must not be replaced. No new administrator/MFA setup is requested.

After private configuration, verify new hosted Auth/Admin/relay boundaries and apply only the reviewed additive release migration with fresh before/after preservation evidence. A new release remains unpublished until independent hosting/hash verification and owner private-MFA approval. Actual Windows password/Google/secure store/restart/A–B isolation, native audio/AI/context/usage/concurrency, update/side-by-side, normal WSS close, restore/performance/monitoring and timestamped Authenticode remain unaccepted. Commercial readiness is not claimed.

## Execution record
Publication, new resource IDs/READY SHA, final installer bytes and fresh security evidence will be appended only after read-back.
