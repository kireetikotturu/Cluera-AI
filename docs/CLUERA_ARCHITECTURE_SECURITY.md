# Architecture and security

Current next checkpoint is **private website key mapping confirmation**, superseding relay-approval/saving instructions below: only Cluera's service-entry metadata timestamp changed, while old website metadata stayed unchanged. Old modern-key/read proofs pass, but new Cluera Admin UI rollout is paused; current website still runs3661 source. Reviewed effe866d/hosted CI38596766413 passes web1055/22-skipped and desktop366/1-skipped. Confirm account_web only on sigmaround-account-staging and the distinct Cluera-web key on cluera-ai-staging, without values or changes now. See [current execution status](CLUERA_EXECUTION_STATUS.md). Phase A and commercial release remain held; old relay/License/financial ownership are unchanged.

Latest October14: the owner-approved old website-only bridge is verified READYdpl_BaQwgcafWd1HofC6LovQkTDDPxX6/unchanged0a5ae015. Protected modern-key build preflight and current positive signed-feed SDK read pass; protected metadata stays unchanged/stale, not independent saved-value proof. No old source/payment/scheduler/relay/License change or legacy revocation. All23 preservation snapshots match; Phase A remains held. Cluera Users/Release UI now fences two-way uncertainty and same-event admission while preserving exact retries and server MFA. [Current security boundary and next relay-only approval](CLUERA_EXECUTION_STATUS.md). Health/public UI/synthetic tests are not full containment, private Auth or financial acceptance.

## October 14 navigation/security boundary

Plan navigation is a hint, never a server price/revision/identity/permission. Four allowlisted Cluera codes and an optional desktop UUID survive into fixed local account/checkout links. Duplicate/invalid hints, hostile return URLs and unexpected stored fields cannot enable checkout. Same-browser state expires after30 minutes; logout/reset clear it and recovery cannot continue. No password/token/provider resource is stored; no automatic SDK/order/payment. Server live-session/owner/tester/catalog and raw-signature/provider-evidence checks remain authoritative.

Owner confirms suspected legacy service-role JWT format, not dummy/retired status. Five supplied attachments contained no unique candidate; no authorization check was attempted. Conditional Phase A cannot expand privileged billing APIs before containment. Replacement keys, disabled buttons, RLS and unchanged digests are not retirement proof. [Execution/approval map](CLUERA_EXECUTION_STATUS.md). No old service, License, key trust, financial row or frozen SQL was changed.

Cluera web/browser → dedicated Vercel BFF → retained Supabase Auth/live sessions/RLS/service-only RPCs.
Cluera Electron renderer → narrow preload → main-memory access credentials + OS-encrypted refresh state → dedicated Render WSS → same retained server usage reservations → server-only Gemini and Flux.
Local history/files stay in the new UUID-isolated profile; selected extracted cloud context uses the retained backend. No automatic original-file backup or cross-product token transfer.

The browser never authorizes balance, capture or paid fulfillment. START/CHECKPOINT/STOP and financial adjustments retain Account-first locks, bounded reservations and idempotent settlement. No per-second DB writes. New payment routes and workers fail closed behind the independent rollout flag; no second scheduler is provisioned.

Release approval uses a new Cluera registry/RPC/product lock and existing explicit MFA Admin authorization/immutable audit. The old Account registry is never read as a fallback. Cluera feed requires the distinct pinned Ed25519 key, product/audience/channel/version/hash/size/origin; old products reject it.

NEXT_PUBLIC key validation rejects service-role/secret keys before bundling. Provider metadata is HMAC-bound to X-Cluera proof headers/nonces and a dedicated scope. Logs retain categorical operation/stage/status, never credentials or provider payloads. Production secrets belong only in the selected new service/project; private local preparation and binaries are ignored.

Compatibility exceptions: account/customer/billing SQL/API names and SIGMAROUND_* configuration names are intentional, separately scoped in new resources. Historical SigmaPro/SigmaEnterprise prices/provider IDs remain untouched; new Cluera v2 revisions do not alias them. Historical migrations/audits and old source/profile/EXE names stay unchanged. Cluera support is clueraaisupport@gmail.com; old product support is not redirected by this work. Some isolated audio preference keys retain their old prefix solely inside the new profile. AppConfig's internal licensing property describes release trust only, not License authorization.

Do not run historical migrations, SQL grants, release publication, role/MFA changes, customer/provider spend or payment recovery as a smoke test. New native callback uses43822 rather than old43821. All-device logout affects all clients of the same retained Auth identity by design. Keep old callbacks and rollback clients.

Dependency findings, skipped tests, bounded scans and synthetic/native/hosted evidence must be reported separately. Free Render capacity/sleep and unresolved normal-close propagation are not production availability guarantees.

