# Cluera Auth migration to the independent project

## Superseded October 16 - clean setup explicitly selected

The owner confirms the old Cluera database is no longer available and explicitly does **not** require its users or dummy trial balances. The active workflow is a fresh setup only on **yhnqlfcgrmckhyjdxegg**, with no Auth/password/MFA/role/trial import. [Current clean Auth/provider setup](CLUERA_CLEAN_AUTH_PROVIDER_SETUP.md) replaces this historical migration plan and its old-project visibility/backup action. Do not ask the owner to recover old users or repeat old Admin/MFA/key-disable setup. Real provider/payment obligations still require separate reconciliation before financial activation; the clean authorization does not waive them.

The remaining content below records the earlier migration analysis, not current owner instructions or permission to import old authority.

Reviewed October 16, 2026. Source **dwqltsqumiwsxtkzdoaa**; destination **yhnqlfcgrmckhyjdxegg / cluera-ai-production**. Preparation only: no Auth export/import, schema write, sign-in, email send, factor enrollment, OAuth/SMTP configuration or old-project change was performed for this review.

The new project is a destination, not a replacement source of customer truth. The current connector cannot retrieve the old project; this is not proof it was deleted. Current source Auth counts, hash portability and a verified restorable backup remain unavailable. Do not create substitute customers or accept destination login against a partial restore.

## Supported route and excluded authority

Supabase documents users/password-hash migration through a backup or logical SQL export/import, but provides no universal Auth-only migration script. Retain independent destination signing trust: old sessions must reauthenticate. Never copy the old JWT secret to retain their sessions. [Official Auth migration guide](https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects).

Use a reviewed **logical, allowlisted transfer into the existing destination**, not a blind clone. A physical restore-to-new-project copies the source encryption root and immediately starts restored cron/network extensions; it cannot first exclude those jobs. That conflicts with fresh-key isolation and single-owner billing here. [Physical clone behavior](https://supabase.com/docs/guides/platform/clone-project).

| Data or capability | Required disposition |
| --- | --- |
| User UUID, established email/phone verification, disabled/banned/deleted state and ownership | Preserve through explicit private field mapping; never recreate by public signup or merge by email alone. |
| Password hashes | Preserve only through the portability/rewrap gate below; never collect plaintext passwords. |
| `auth.identities` ownership/provider identifiers | Preserve associations and validate uniqueness/FKs. Generated/read-only columns follow destination schema. |
| Customer, once-ever trial, grants, balances and financial/Admin audit history | Preserve original UUIDs and exact historical values before any customer BFF access. No callback/replay/grant is an importer. |
| Authorized `account_admin_profiles` | Preserve only existing explicit roles. User metadata and email text never grant Admin. |
| Sessions, refresh tokens, PKCE/flow state, one-time tokens, active MFA challenges and pending confirmation/recovery/change credentials | Exclude from active destination. Retain original evidence only in protected source backup; restart requests through normal destination Auth later. |
| Secret-bearing MFA enrollment rows | Never blindly copy. Require supported protected rewrap, or fresh destination enrollment after identity/role restoration. |
| Old JWT/API keys, encryption roots, Vault contents, SMTP/OAuth/provider secrets and worker bearers | Never import with customer data. Provision fresh independent infrastructure custody. |
| Managed Auth DDL/migration metadata | Retain destination platform-managed definitions; compare actual versions/columns/FKs rather than replacing them with an old schema dump. |

## Password portability is a real gate

Do not assume every `auth.users.encrypted_password` is directly usable bcrypt. Current upstream Auth can optionally wrap a password hash in encryption and decrypt it using a configured keyring, bound to the user UUID. This proves the capability, **not** that the unavailable source uses it. Classify inside the source and output only aggregate categories: absent, supported bcrypt, supported Argon2, or other/encrypted/unknown. Never print the value, prefix, per-user digest or affected identity. [Primary implementation](https://github.com/supabase/auth/blob/master/internal/models/user.go).

Documented Admin import accepts supported bcrypt/Argon2 hashes and a specified user UUID, but does not automatically preserve all provider identities/history. A data-only users/identities transfer remains the candidate for exact ownership once schema compatibility and password format pass. [Documented hash/UUID support](https://supabase.com/docs/guides/platform/migrating-to-supabase/auth0).

If any value is encrypted or unknown, stop that import. Obtain a Supabase-supported private export/rewrap procedure without copying the old root key. Do not strip ciphertext, import it as a hash, silently reset passwords or fall back to old Auth. A reset alternative needs a separate customer-transition decision and verified destination email delivery.

Explicitly review destination defaults for excluded pending email/phone changes and tokens. Unknown source columns must fail closed, not be copied automatically.

## Backup, ordering and conservation

1. Regain source read access. Pin current schema/migration versions, source timestamp, constraints, extensions, Auth aggregate categories, authorized Admins and exact trial/ledger/history comparison inputs. Old documentation is not a fresh source manifest.
2. Export a consistent backup through a private TLS-verified database connection using the documented CLI/PostgreSQL route. No raw users/hashes in MCP output, shell history, Git or logs. Encrypt/access-restrict the backup, retain byte count/checksum and separate recovery custody, then prove a restore in a non-public isolated test environment. A checksum or count report is not a restorable backup. Storage object bytes require separate preservation. [CLI restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [backup limits](https://supabase.com/docs/guides/platform/backups).
3. Review the allowlist and every Auth/application trigger. Official bulk-restore examples alter replication behavior; that is not permission to bypass production security or financial audit triggers. Establish the isolated import sequence and normal post-import permissions/constraints before exposing APIs. Destination cron/network dispatch and application writers remain inactive.
4. Import compatible users/identities, then dependent customer/trial/ledger/Admin/history rows in FK order using the reviewed transactional importer. Reject unexpected destination users, duplicate emails/provider subjects, orphaned rows, unknown fields or a changed source manifest. Do not mask conflicts with `ON CONFLICT DO NOTHING` or overwrite unrelated users.
5. Privately compare approved persistent Auth fields/identities and complete business rows with the same source snapshot. Output only fixed aggregate match/failure categories. Reconcile intentionally excluded Auth fields separately, not a false whole-Auth-row equality claim. Verify granted/spent/reserved/available conservation, trial uniqueness, attributable grants and zero activated historical jobs.
6. Recheck source changes immediately before the separately reviewed ownership/freeze/handoff. An earlier copy never authorizes both projects to issue trials, reserve balances or process one payment independently.

### Critical existing application invariant

Reviewed `20261004024730_customer_account_foundation.sql` makes `customer_authorize` lazily create a customer and once-ever 900-second trial when absent. `20261004064105_shared_usage_reservations.sql` lazily materializes the unique `(user_id, source_key='lifetime-trial')` grant.

Therefore **even a customer BFF read stays blocked until original UUIDs, trial rows and exact grants/spent/reserved values reconcile**. Never test migrated customer sign-in against a partial production import. Preserve lifetime-trial keys/timestamps; do not replace missing evidence with a fresh trial.

Historical `customer_usage_runs.auth_session_id` is evidence, not an `auth.sessions` FK in reviewed local DDL. It can remain historical while active Auth sessions are excluded; recheck actual source constraints when accessible. Active runs/reservations require the separate ledger drain/conservation gate.

## MFA and Admin acceptance in the new trust domain

Current Auth can encrypt TOTP factor secrets with a configured keyring, bound to factor UUID. Blind factor copies may not be portable; no secret was inspected. The isolated default is to omit active enrollment/challenge secrets and freshly enroll only after identity/role restore, unless a supported protected rewrap is verified first. [Primary factor implementation](https://github.com/supabase/auth/blob/master/internal/models/factor.go).

The owner's completed old-project Admin/MFA acceptance remains valid historical evidence; do not repeat it now. It cannot prove a destination factor/session. Later, only an already-migrated allowlisted Admin signs in privately and, if required by the selected migration method, enrolls/verifies the destination authenticator. Require current destination AAL2/live-session checks; never forge them or grant by public signup. Existing BFF and `account_admin_check` safeguards remain intact. [MFA assurance levels](https://supabase.com/docs/guides/auth/auth-mfa/totp).

## Google, email and customer transition

Destination Google callback: **`https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/callback`**. Application redirect allowlists are separate. Configure the destination provider privately without changing old OAuth/callback settings. Do not transfer secrets through chat/tools. A different OAuth client may affect provider identity behavior: real consent must recover the original migrated customer UUID, not create another trial-bearing user. [Official Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

Install the six prepared Cluera email bodies/subjects only on the **new** project after eligibility/sender review; that does not rebrand old shared-project messages. Retain complete provider-generated ConfirmationURL/Token semantics, PKCE callbacks and anti-enumeration behavior. A support Gmail address does not establish a verified SMTP sending domain. Custom SMTP, domain authentication and real controlled-inbox delivery remain prerequisites. New Free/default-SMTP projects may not support custom templates; no plan upgrade or SMTP change is performed here. [Email handoff](CLUERA_EMAIL_BRANDING.md), [SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp), [template eligibility](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

At a reviewed switch, old cookies, desktop refresh credentials and in-flight PKCE links do not carry new trust. Customers renew sessions privately using preserved passwords or reconciled Google identity. Keep local history/documents intact; never import encrypted refresh material or silently route denied destination Auth back to the old project. A new verification/recovery request may be needed after cutover, but no messages are initiated now.

Required real acceptance remains: email login; destination signup/verification/once-ever trial; Google UUID continuity; refresh/reload/recovery/logout; denied old tokens/foreign identities; private Admin AAL2; Windows secure store/restart/A-B isolation. Schema/SDK fixtures are not these journeys.

## Tool boundary and one next owner check

Connected tools expose metadata/SQL/migrations but no protected streaming hash backup transfer or Auth/SMTP configuration operation. Do not manufacture an export through row-by-row MCP output. Current source backup and executable field mapping remain blocked until source access is restored.

**One check now:** open old project `dwqltsqumiwsxtkzdoaa` in the Supabase dashboard and report only whether it is visible, its status, and whether Database Backups lists an available backup/date. Do not Restore, Resume, Delete, rotate keys or paste credentials/hashes. If not visible, resolve source-project access/Support recovery first. New keys, Google consent and MFA setup are not the next step.

No actual backup restore, identity import or customer migration is claimed complete. SigmaRoundAI License Edition and all old databases/services remain untouched.
