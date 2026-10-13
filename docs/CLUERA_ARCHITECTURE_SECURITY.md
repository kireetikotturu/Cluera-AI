# Architecture and security
Cluera web/browser → dedicated Vercel BFF → retained Supabase Auth/live sessions/RLS/service-only RPCs.
Cluera Electron renderer → narrow preload → main-memory access credentials + OS-encrypted refresh state → dedicated Render WSS → same retained server usage reservations → server-only Gemini and Flux.
Local history/files stay in the new UUID-isolated profile; selected extracted cloud context uses the retained backend. No automatic original-file backup or cross-product token transfer.

The browser never authorizes balance, capture or paid fulfillment. START/CHECKPOINT/STOP and financial adjustments retain Account-first locks, bounded reservations and idempotent settlement. No per-second DB writes. New payment routes and workers fail closed behind the independent rollout flag; no second scheduler is provisioned.

Release approval uses a new Cluera registry/RPC/product lock and existing explicit MFA Admin authorization/immutable audit. The old Account registry is never read as a fallback. Cluera feed requires the distinct pinned Ed25519 key, product/audience/channel/version/hash/size/origin; old products reject it.

NEXT_PUBLIC key validation rejects service-role/secret keys before bundling. Provider metadata is HMAC-bound to X-Cluera proof headers/nonces and a dedicated scope. Logs retain categorical operation/stage/status, never credentials or provider payloads. Production secrets belong only in the selected new service/project; private local preparation and binaries are ignored.

Compatibility exceptions: account/customer/billing SQL/API names and SIGMAROUND_* configuration names are intentional, separately scoped in new resources. Approved SigmaPro/SigmaEnterprise prices and provider IDs remain financial policy, not branding strings. Historical migrations/audits and old source/profile/EXE names stay unchanged. Support remains sigmaroundsupport@gmail.com. Some isolated audio preference keys retain their old prefix; they live solely inside the new profile. AppConfig's internal licensing property describes release trust only, not License authorization.

Do not run historical migrations, SQL grants, release publication, role/MFA changes, customer/provider spend or payment recovery as a smoke test. New native callback uses43822 rather than old43821. All-device logout affects all clients of the same retained Auth identity by design. Keep old callbacks and rollback clients.

Dependency findings, skipped tests, bounded scans and synthetic/native/hosted evidence must be reported separately. Free Render capacity/sleep and unresolved normal-close propagation are not production availability guarantees.

