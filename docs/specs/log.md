# Specs Update Log

## 2026-06-29
* **Initialization**: Established the specs roadmap and indexed the implemented [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md).

## 2026-08-14
* **Vercel cloud provider**: Added approved GitHub epic [#2](https://github.com/gannonh/devbox/issues/2) and its five dependency-linked phase issues ([#3](https://github.com/gannonh/devbox/issues/3)-[#7](https://github.com/gannonh/devbox/issues/7)) to the roadmap after current Vercel Sandbox/VCR research and independent adversarial review.

## 2026-08-14 (2)

* **Provider foundation**: Issue [#3](https://github.com/gannonh/devbox/issues/3) implementation is staged as a typed registry boundary with local lifecycle parity; Vercel remains an explicit unavailable provider until its later phases.

## 2026-08-14 (3)

* **Build hardening**: Added deterministic clean packaging, missing-executable runner handling, and caller-owned devcontainer stderr routing to the Issue #3 implementation.

## 2026-08-14 (4)

* **Roadmap status**: Marked Issue [#3](https://github.com/gannonh/devbox/issues/3) implemented with acceptance evidence complete in [PR #8](https://github.com/gannonh/devbox/pull/8), awaiting maintainer sign-off/merge; identified #4 as the remaining active Build phase and preserved #5 → #6 → #7 dependency order.

## 2026-08-14 (5)
* **Vercel image supply chain**: Implemented the issue #4 image assets, readiness/smoke/promotion workflow, release pin validation, and operator runbook; live credential-gated execution remains a Verify-time requirement.

## 2026-08-14 (6)
* **Vercel image supply-chain review fixes**: Hardened process/readiness/credential/identity/session/snapshot gates, made promotion evidence-driven, added structured timing artifacts, and documented consumer credential rotation.

## 2026-08-14 (7)
* **Vercel image supply-chain second review fixes**: Corrected flat repository identity handling, scoped all CLI/readiness calls, prevented deletion verification from resuming Sandboxes, rejected forged/minimal promotion reports, withheld artifacts on redaction failure, and pinned the audited CLI.

## 2026-08-14 (8)
* **Vercel image supply-chain third review fixes**: Added deterministic hanging-endpoint coverage, bounded HTTP/SDK/smoke/cleanup execution, eventual deletion retries and recovery, executable working-binary probes, and malformed primitive evidence rejection.

## 2026-08-14 (9)
* **Vercel image supply-chain independent quality fixes**: Added re-promotion and tag/PR idempotency, actual-secret redaction fixtures, owned Sandbox and resolver recovery, reproducible apt snapshot inputs, strict shared evidence URLs, and corrected orphan/runtime documentation.

## 2026-08-15
* **Vercel image cleanup contract correction**: Aligned smoke and Universal resolver cleanup with the pinned SDK's plain snapshot metadata, delayed owned-resource discovery, and bounded residual snapshot proof.

## 2026-08-15 (2)
* **Vercel image final quality cleanup**: Required independent final owned listings, authoritative deleted/absent snapshot metadata, actual SDK behavior fixtures, open-only promotion PR reuse, pinned role-specific orphan cleanup, and fail-closed resolver evidence writes.

## 2026-08-15 (3)
* **Vercel image base correction**: Updated approved issue #4 after live VCR checks proved the managed Universal VMI cannot be used as an OCI `FROM`. The build now mirrors its pinned open-source recipe with checked provenance while retaining the immutable candidate, publisher/consumer smoke, cleanup, promotion, and rollback gates.

## 2026-08-15 (4)
* **Vercel image final verification hardening**: Authorized credentialed PR runs by exact reviewed SHA and repository owner, isolated commit-pinned read-only verification from write-capable promotion, restricted manual dispatch to the default branch, forced fresh run-unique candidate builds, added byte-hashed digest-correlated live zstd manifest evidence, tightened runtime provenance, and closed recovered-cleanup and promotion-branch trust gaps.

## 2026-08-15 (5)

* **Verified phase convergence**: Integrated the merged provider foundation with the verified Vercel image supply chain and advanced the roadmap to the core workspace lifecycle phase.

## 2026-08-18
* **Phase 5 convergence**: Linked issue #7's benchmark, UAT, release gates, architecture, ADR, runbook, and reference evidence into the OKF bundle.
