# Cluera customer and Admin guide

Current next checkpoint is **private website key mapping confirmation**, superseding relay-approval/saving instructions below: only Cluera's service-entry metadata timestamp changed, while old website metadata stayed unchanged. Old modern-key/read proofs pass, but new Cluera Admin UI rollout is paused; current website still runs3661 source. Reviewed effe866d/hosted CI38596766413 passes web1055/22-skipped and desktop366/1-skipped. Confirm account_web only on sigmaround-account-staging and the distinct Cluera-web key on cluera-ai-staging, without values or changes now. See [current execution status](CLUERA_EXECUTION_STATUS.md). Phase A and commercial release remain held; old relay/License/financial ownership are unchanged.

Private staging, not public sales. Support: **clueraaisupport@gmail.com**.

October14 scoped safety fix: Users/Release controls fence each other's pending/unknown mutations, including before a React render commits. Other controls lock while that release is unresolved, but **Verify/retry same release operation** retains its exact UUID/body and remains available. Parent reads cannot invalidate it; stale child reads are aborted/discarded. A first definitely rejected write permits correction; a later rejection after uncertainty cannot erase the original operation. Confirmed application restores controls and refreshes release rows. This is not an Admin authorization/MFA bypass or universal mutex across other independent panels. No real release action was used for tests.

## Customer navigation

1. `/pricing` lists the four planned Cluera offers, or current immutable revisions after approved schema selection. **View availability** carries only the chosen offer; it is not a purchase.
2. `/account/checkout` keeps the choice visible. **Sign in to Cluera AI** preserves the safe offer/desktop hint. Use your own private email password or Google consent; never send secrets to support/chat.
3. Verification/recovery uses the latest link in the same browser and the existing protected PKCE flow. The temporary plan hint contains no password, access/refresh token, price or provider resource. If browser storage is disabled/expired, choose the plan again.
4. A verified normal session offers **Continue to selected plan**. Recovery must finish and sign out first. Logout clears the navigation hint. Checkout still independently validates the current account, desktop match, tester/rollout and current catalog.
5. No purchase is available now. Never retry/resume old Account-era drafts, substitute a plan or trust a callback as credit evidence. Invoice/history/subscription controls cannot be called accepted until their real staged financial journeys pass.

## Admin boundary

Use `/account/admin` with the already authorized Admin and existing verified authenticator. Public signup never assigns an Admin role, and the support inbox is not an Admin. New invitations/roles require explicit verified-owner authorization; no role was granted by this work.

Customer/catalog/usage/release/provider reads require the existing server authorization. Sensitive operations need reasons, retained operation UUIDs, live allowed MFA and, where required, fresh authenticator reauthentication. An unknown write remains locked to its original operation/body; verify it by a read, never invent a replacement operation. No dashboard metric or provider cost should display a fabricated zero.

### Pricing and payments

The frozen billing schema is unapplied. Billing catalog controls must honestly show unavailable until verified preparation completes. After separately approved schema/configuration, an Admin may create a new **disabled future revision** or explicitly change availability. Existing purchased amount/time/plan/invoice snapshots never change. Recurring revisions require separately configured, independently verified exact Test plans; availability cannot bypass the global financial gates. Full audit-list/invoice/customer-subscription management is not claimed operational by an operation-verification view.

### Providers

The vault is unapplied/unbootstrapped and relay remains auth-only. Do not enter/import real provider keys until approved encryption custody, synthetic envelope/security checks and staging bootstrap pass. Keys remain encrypted/server-side and absent from customers, desktop, API responses and logs. Provider testing and metered acceptance require their own authority. OpenAI/Claude and fallback stay unavailable; BYOK is disabled. Actual usage/cost telemetry remains incomplete.

### Releases/support

Cluera release registry is unapplied; there is no automatic old Account binary/feed fallback. Existing unsigned Cluera TEST files are not commercial installers or automatically upgraded by website work. Commercial distribution requires signing, independent hosted-byte verification, private-MFA approval and real normal-Windows update acceptance.

Support reports should contain app version, stage and fixed safe error/result categories only. Never request passwords, verification links/codes, cookies, API keys, raw payment/card data or transcripts/screenshots lacking consent. Refund/cancellation promises and retention/deletion/legal wording require owner review before sales.
