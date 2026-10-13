# Cluera release blockers

October 13, 2026. No production readiness or commercial release approval.

- Infrastructure: missing Cluera service-role/rate settings; Render not live/healthy. Owner Not ready yet. No secret format/ownership success inferred from metadata presence.
- Auth: actual hosted signup/verification/resend/Google/recovery/refresh/logout/account switching and normal Windows encrypted store remain unaccepted. Missing service-role key is the confirmed deployed 503 cause; it is not bypassed in source.
- Provider vault: proposed schema **unapplied**, keyring unprovisioned, gates not enabled. See [vault bootstrap](CLUERA_AI_PROVIDER_VAULT.md). Fresh-MFA/cryptographic/SQL/UI tests are synthetic, not actual owner acceptance. Telemetry, actual cost reconciliation, managed KMS custody and rotation/restore need completion.
- AI/usage: authenticated transport, real Gemini/Flux, revocation, shared metering/exhaustion/concurrent devices need authorized acceptance. OpenAI/Claude generation and fallback remain unavailable. Customer BYOK stays off.
- Billing: all new Cluera flags false. Separate immutable processing ownership/cutover design is required before any new webhook/worker/key migration against the shared ledger. Existing BOUND Razorpay order and Paddle draft/history are preserved; no retry/replay/manual grant. Actual signed delivery/capture/refund/recurring lifecycle remain separate financial approval and acceptance.
- Plan decision: current canonical third policy is Enterprise **weekly ₹5,499 /30 hours**, not the newly requested Pro **monthly ₹9,599 /100 hours**. No price/entitlement/history was silently changed. Resolve this policy explicitly in the later billing design before implementing a replacement.
- Windows: retained Cluera1.0.0 unsigned TEST bytes unchanged; no installer rebuild needed for this web/relay change. Normal install/uninstall/login/store/side-by-side/updater/high-DPI/provider journeys remain acceptance gates. Timestamped Authenticode identity and private signing service are required before commercial distribution.
- Security/supply chain: desktop dependency findings remain unresolved; archive exclusion is not an advisory fix. Recheck current audits and supported upstream patches before release. No security flags or ACLs may be relaxed for acceptance.
- Operations: redacted provider telemetry/alerts, budgets, capacity/cold start, durable backups and tested restore, deployment rollback, root-key escrow/rotation, incident access control and support recovery require acceptance.
- Policy/marketing: privacy/data-processing terms, retention/deletion, subprocessors, consent for audio/screenshots, accurate refunds/terms/support commitments need owner/legal review. Marketing may describe accepted features only; no ads, Live launch, tracking secrets, undisclosed transcripts or production conversion claims.

The next owner action is private **infrastructure** setup, not a provider key or payment. Schema application and privileged credential bootstrap/migration require separate approval afterward.
