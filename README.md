# Cluera AI
Independent Account-managed Windows workspace, customer SaaS and MFA Admin. Private staging; unsigned TEST only.

See [implementation and migration](docs/CLUERA_IMPLEMENTATION_MIGRATION.md), [architecture/security](docs/CLUERA_ARCHITECTURE_SECURITY.md) and [private deployment setup](docs/CLUERA_STAGING_SETUP.md).

Install separately: npm ci in desktop/, web/ and backend/. Build/test/typecheck each package independently. Desktop package:win prepares separate versioned Cluera TEST output; never use original SigmaRound package commands. Root npm run test:preparation verifies source/export and packaging guards; npm run verify:source scans publishable working files.
Complete locks are committed. No dependency link to another product. Native code is not browser-only.

New private main contains reviewed snapshots; staging is ongoing integration and Render's configured branch. Changes reach main only after review/tests; both branches initially share the same reviewed source. Vercel's Production-named environment is isolated staging, never License production. Original repositories/branches are not publication targets.

The owner explicitly chose the retained Account Supabase backend: identities/balances/history are shared intentionally. Do not replay historical migrations, seed trials, clear unresolved payments, add workers or activate financial routes. Never commit environment/private settings, profiles, binaries or build outputs.

October 14: the approved temporary old website bridge is completed: owner privately saved its separate modern key, complete unchanged0a5ae015 source reloaded READYdpl_BaQwgcafWd1HofC6LovQkTDDPxX6, protected build checks modern-key shape and fresh signed-feed read authenticates. No old source/payment/scheduler/installer change. Protected environment metadata remains unchanged/stale and cannot independently certify the value update; no secret was decrypted. The exposed legacy JWT remains unrevoked/status unknown. **Phase A stays conditionally approved, unapplied and on containment hold.** Keep old scheduling, Cluera auth-only/all payment flags false/pause true. [Current status](docs/CLUERA_EXECUTION_STATUS.md), [billing plan](docs/CLUERA_BILLING_CUTOVER.md), [incident plan](docs/CLUERA_SHARED_CREDENTIAL_ROTATION.md). Next approval is only temporary old-relay compatibility retention/credential bridging, not another website approval, License change or revocation. Commercial launch NO-GO.

Cluera Admin Users/Release controls now fence each other's pending/uncertain operations, including same-event races; retained UUID/body retries stay available. Server Auth/MFA and release approval are unchanged. This is not a universal mutex for all independent Admin panels. Existing desktop features and four retained EXE hashes are unchanged; no installer was rebuilt or published.

Customer plan navigation now preserves the selected Cluera offer through sign-in and same-browser email/Google return, with an explicit continuation link and no automatic payment. The query contains only an allowlisted offer and optional non-secret desktop-owner hint; server ownership, price revision and rollout checks remain authoritative. Invalid/duplicate handoffs fail closed, local return paths are fixed, temporary state expires and logout/recovery clear it. [Customer/Admin guide](docs/CLUERA_ADMIN_GUIDE.md). Positive real Auth, Windows, providers, billing and commercial operations remain separate acceptance gates.

New Cluera planned prices use separate presentation-policy v2 IDs. Historical shared-ledger/Paddle policies and provider IDs are not changed. The Admin vault remains a [reviewed unapplied proposal](docs/CLUERA_PROVIDER_VAULT_SCHEMA_REVIEW.md), with separate schema/root-key/activation approval required. Customer BYOK and OpenAI/Claude generation stay unavailable. The support contact is `clueraaisupport@gmail.com`; this does not grant Admin authority.

