# Shared Supabase credential incident — approval-required plan

October 13, 2026. **Replacement configuration scope approved; owner saving Not ready yet. No key created, replaced, revoked or rotated by the agent.**

Latest launch request authorizes inventory and coordinated private replacement in the two new Cluera and two confirmed original Account services, plus configuration-only reload of pinned reviewed source. The owner answered **Not ready yet** to the private four-key checkpoint (`cluera-web`, `cluera-relay`, `account-web`, `account-relay`). Do not repeat or assume completion of that step. Legacy API deactivation and JWT-secret rotation remain separately unapproved. This supersedes the pending-replacement-approval wording below; inventory gaps and retirement prerequisites remain.

The owner reports that the retained project's service-role credential was exposed in chat. Treat it as compromised. Deleting a message, deploying again, creating a replacement or obtaining a clean source scan does not revoke the exposed credential. Table RLS is not a complete defense against privileged server credentials. No evidence here establishes that the key was or was not abused.

## Scope and dependency inventory

Shared project: **dwqltsqumiwsxtkzdoaa / Cluera AI-staging**, retained Account database, Mumbai. Cluera and old Account deliberately share customers, balances and administration.

| Component | Target | Evidence and rotation scope |
| --- | --- | --- |
| Cluera website/BFF | Vercel prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B | Infrastructure entry Sensitive/Production-only; fixed shared URL in reviewed configuration |
| Cluera AI relay | Render srv-db6r6som7kps73b1r4g0 | Fixed shared URL; owner-provisioned infrastructure; preserve auth-only |
| Original Account website/BFF, native API, billing intake/worker routes | Vercel prj_VuG3xCUQqKmPhT0LIAmLuyUwBXg6 | Public URL independently matches shared project; service entry Sensitive/Production-only |
| Original Account relay | Render srv-db1402u0tbcc739dc5m0 | Retained Account source/configuration targets shared project; key equality not decrypted |
| License and other services | Other Vercel/Render projects | Do not assume a dependency merely because the same variable name exists. License public-URL retrieval was inconclusive; owner must confirm project/key ID privately before excluding it |
| CI, local private settings, external integrations | Owner inventory | Include repository/org/environment secrets, cron/worker clients, scripts, private backups and external consumers of this exact project/key |

Read-only inventory covered the connected team's 22 Vercel projects and workspace's 21 Render web services; it is not a complete external-secret inventory. The retained project lists no Edge Functions. Connected GitHub does not expose secrets APIs, and Render does not expose private env read-back through the available connector. Saved credential equality was not tested by printing/decrypting keys. Inventory confirmation is required before retirement.

The existing sealed database scheduler bearer, payment keys, cookie/rate keys, signing keys and provider keys are different secrets; do not rotate them automatically or wake workers. Confirm whether any scheduler/external task separately uses the compromised Supabase key without reading decrypted Vault values into chat.

## Coordinated sequence after separate approval

1. Record the incident window, exact project and compromised key **type/ID only**, and owner-confirmed dependent components. Review bounded Auth/API/DB logs for unusual privileged requests, new users/roles and financial changes. Preserve evidence; absence of retained logs or aggregate drift is not proof of no compromise. Restrict distribution of old private copies; do not erase evidence or unrelated files.
2. Prefer separately named modern **sb_secret_** backend keys for each confirmed component. These are still privileged service-role/BYPASSRLS credentials, not table-scoped least-privilege keys. Provision privately through the Supabase owner's secure dashboard; never paste replacement values into this conversation or tool arguments. Validate current platform support and deployed SDK/config compatibility first.
3. Privately replace only SUPABASE_SERVICE_ROLE_KEY in every dependent environment/branch scope. Keep all other settings unchanged. Cut over/redeploy complete pinned reviewed source in Cluera and, **only with explicit old-service configuration approval**, the original Account web/relay. Do not change original source, payment gates, URL, scheduler or installer. Additional confirmed components receive the same controlled cutover.
4. Verify each component with bounded read-only authenticated server checks and owner-controlled login/Admin acceptance. Confirm READY/LIVE, fixed target and stable alias, auth-only AI denial, unchanged financial rows/digests and intact original release trust. A 200 health response alone does not prove database authentication. Do not submit orders, events, allowance writes or provider work as a rotation probe.
5. Retire/revoke the exposed credential only after all dependencies are accounted for and using replacements. **If it is a modern secret key:** delete/revoke that exact compromised key. **If it is the legacy service_role JWT:** creating modern keys does not invalidate it. Plan the platform's legacy API-key deactivation only after migrating ALL legacy anon/service_role consumers, including any public/desktop clients. This may require separately approved configuration or a new client release; never disable a shared legacy path blindly.
6. Confirm negative authentication for the retired credential in protected server memory with safe categories only, and positive replacement checks. Record key IDs, deployment SHAs/times and revocation evidence, not values. Remove obsolete secret copies from active configuration/caches/backups according to an approved recoverable inventory. Any failure stops progress; never roll back to an exposed key. A new safe replacement is the rollback credential.

[Supabase API-key guidance](https://supabase.com/docs/guides/getting-started/api-keys) distinguishes modern independently managed keys from legacy JWT keys. [JWT signing-key guidance](https://supabase.com/docs/guides/auth/signing-keys) covers a separate trust system. Exposure of a signed service-role JWT is **not evidence that the underlying JWT signing secret was exposed**. Do not rotate the database password, signing secret or user sessions merely to replace an API key. If signing-secret compromise is independently established, request a separate coordinated signing-key/session/client migration approval.

## Exact approval boundary

The next owner decision should authorize **inventory completion and coordinated private replacement plus revocation of the exposed shared-project server credential**, explicitly including the two new Cluera services, the two original Account services and any additional privately confirmed dependent environment. Permit configuration-only reloads of pinned source in old Account, not changes to its code, payments, history or installers. Owner supplies replacements privately, never in chat. Legacy API-key deactivation requires a confirmed all-client compatibility inventory and explicit approval at that checkpoint; JWT-secret rotation is not included.

Provider-vault schema application and root-key bootstrap are separate later approvals. Keep Cluera auth-only and every Cluera payment flag false while this incident remains open. No safe “complete end-to-end accepted” claim is made before private Auth/provider journeys and credential retirement are verified.
