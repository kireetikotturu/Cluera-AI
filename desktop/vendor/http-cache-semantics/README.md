# Cluera-local HTTP cache safety patch

Pinned upstream: kornelski/http-cache-semantics commit b1d4bd682fbab0252985de45219f4e7497c0067c (4.3.0). Upstream LICENSE retained. This is a private local fork, not a registry release or upstream-fixed claim.

The sole executable delta rejects non-storable responses before max-stale handling in evaluateRequest. The previous 4.2.0 and upstream 4.3.0 both failed the committed private/no-store regression. Public fresh caching remains tested. Used only by the Cluera packaging dependency tree; no shared service or original product dependency changes. Remove this fork only after a supported upstream fix passes the same tests and a fresh full build/package review.
