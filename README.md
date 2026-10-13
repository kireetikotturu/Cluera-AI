# Cluera AI
Independent Account-managed Windows workspace, customer SaaS and MFA Admin. Private staging; unsigned TEST only.

See [implementation and migration](docs/CLUERA_IMPLEMENTATION_MIGRATION.md), [architecture/security](docs/CLUERA_ARCHITECTURE_SECURITY.md) and [private deployment setup](docs/CLUERA_STAGING_SETUP.md).

Install separately: npm ci in desktop/, web/ and backend/. Build/test/typecheck each package independently. Desktop package:win prepares separate versioned Cluera TEST output; never use original SigmaRound package commands. Root npm run test:preparation verifies source/export and packaging guards; npm run verify:source scans publishable working files.
Complete locks are committed. No dependency link to another product. Native code is not browser-only.

New private main contains reviewed snapshots; staging is ongoing integration and Render's configured branch. Changes reach main only after review/tests; both branches initially share the same reviewed source. Vercel's Production-named environment is isolated staging, never License production. Original repositories/branches are not publication targets.

The owner explicitly chose the retained Account Supabase backend: identities/balances/history are shared intentionally. Do not replay historical migrations, seed trials, clear unresolved payments, add workers or activate financial routes. Never commit environment/private settings, profiles, binaries or build outputs.

October 13: existing infrastructure is verified, the Cluera website is READY and Render is LIVE/auth-only. **The separate exposed-credential replacement checkpoint is Not ready yet**; no replacement/revocation has occurred. Follow [ordered launch steps](docs/CLUERA_LAUNCH_STEPS.md) and [the credential incident plan](docs/CLUERA_SHARED_CREDENTIAL_ROTATION.md), not obsolete initial setup instructions. AI START and all Cluera payment flags remain disabled. Real Auth/provider/Windows/payment/commercial acceptance is incomplete; no production or zero-bug claim.

New Cluera planned prices use separate presentation-policy v2 IDs. Historical shared-ledger/Paddle policies and provider IDs are not changed. The Admin vault remains a [reviewed unapplied proposal](docs/CLUERA_PROVIDER_VAULT_SCHEMA_REVIEW.md), with separate schema/root-key/activation approval required. Customer BYOK and OpenAI/Claude generation stay unavailable. The support contact is `clueraaisupport@gmail.com`; this does not grant Admin authority.

