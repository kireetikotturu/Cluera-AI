# Cluera-local global-agent TLS compatibility patch

Private build-only dependency: `global-agent@4.1.3-cluera.1`. Not an upstream-fixed claim or customer AI/network adapter.

The upstream npm 4.1.3 archive is pinned by SHA-512 integrity `sha512-KUJEViiuFT3I97t+GYMikLPJS2Lfo/S2F+DQuBWzuzaMPnvt5yyZePzArx36fBzpGTxZjIpDbXLeySLgh+k76g==` in the original reviewed lock. Exact upstream source/build/tests are retained from commit `e9138f654826f9a82e0ac4f3abdb9541ac988286`. `UPSTREAM_PACKAGE.json`, README and BSD-3-Clause LICENSE preserve upstream metadata and attribution. The source manifest pins every retained file; do not regenerate its pins to accept an unreviewed change.

The only behavioral source change, made identically in `src/classes/Agent.ts` and `dist/classes/Agent.js`, is:

```diff
- if (configuration.secureEndpoint) {
+ if (this.protocol === 'https:') {
```

Node's native HTTPS calls and app-builder-lib's actual nested `@electron/get@3.1.0` do not supply `configuration.secureEndpoint`. Upstream 4.1.3 consequently drops explicit CA, hostname/SNI and certificate-validation options. The intrinsic HTTPS transport class now selects the unchanged TLS-option mapping, preserving the preceding v3 behavior without trusting a caller's endpoint flag. Default certificate rejection, explicit CA and hostname checks remain enforced. HTTP behavior and bootstrap API/no-op logging are unchanged.

The active private package uses prebuilt runtime files and the unchanged upstream runtime dependency ranges. Upstream development dependencies/scripts are preserved separately, not installed or invoked as local dependency lifecycle hooks. No upstream test/source file is deleted. Cluera's isolated consumer regressions use only loopback requests, synthetic document/artifact content, a fresh ephemeral certificate and no private service/provider credentials. Native pre-bootstrap TLS is a fixture control. Untrusted TLS must still reject when the caller supplies `secureEndpoint:false`; a trusted CA with the wrong hostname and a downloaded artifact with the wrong checksum must also reject. The actual nested downloader verifies the valid checksum after proxy/NO_PROXY checks.

This fork is excluded from desktop runtime distribution as a development dependency. Existing installers are not rebuilt or changed by this source-only hardening. Revisit the fork after a compatible upstream release; retaining a private fork creates an ongoing review obligation.
