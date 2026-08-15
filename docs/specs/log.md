# Specs Update Log

## 2026-06-29
* **Initialization**: Established the specs roadmap and indexed the implemented [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md).

## 2026-08-14
* **Vercel cloud provider**: Added approved GitHub epic [#2](https://github.com/gannonh/devbox/issues/2) and its five dependency-linked phase issues ([#3](https://github.com/gannonh/devbox/issues/3)-[#7](https://github.com/gannonh/devbox/issues/7)) to the roadmap after current Vercel Sandbox/VCR research and independent adversarial review.

## 2026-08-14 (2)
* **Vercel image supply chain**: Implemented the issue #4 image assets, readiness/smoke/promotion workflow, release pin validation, and operator runbook; live credential-gated execution remains a Verify-time requirement.

## 2026-08-14 (3)
* **Vercel image supply-chain review fixes**: Hardened process/readiness/credential/identity/session/snapshot gates, made promotion evidence-driven, added structured timing artifacts, and documented consumer credential rotation.

## 2026-08-14 (4)
* **Vercel image supply-chain second review fixes**: Corrected flat repository identity handling, scoped all CLI/readiness calls, prevented deletion verification from resuming Sandboxes, rejected forged/minimal promotion reports, withheld artifacts on redaction failure, and pinned the audited CLI.

## 2026-08-14 (5)
* **Vercel image supply-chain third review fixes**: Added deterministic hanging-endpoint coverage, bounded HTTP/SDK/smoke/cleanup execution, eventual deletion retries and recovery, executable working-binary probes, and malformed primitive evidence rejection.

## 2026-08-14 (6)
* **Vercel image supply-chain independent quality fixes**: Added re-promotion and tag/PR idempotency, actual-secret redaction fixtures, owned Sandbox and resolver recovery, reproducible apt snapshot inputs, strict shared evidence URLs, and corrected orphan/runtime documentation.

## 2026-08-15
* **Vercel image cleanup contract correction**: Aligned smoke and Universal resolver cleanup with the pinned SDK's plain snapshot metadata, delayed owned-resource discovery, and bounded residual snapshot proof.

## 2026-08-15 (2)
* **Vercel image final quality cleanup**: Required independent final owned listings, authoritative deleted/absent snapshot metadata, actual SDK behavior fixtures, open-only promotion PR reuse, pinned role-specific orphan cleanup, and fail-closed resolver evidence writes.

## 2026-08-15 (3)
* **Vercel image base correction**: Updated approved issue #4 after live VCR checks proved the managed Universal VMI cannot be used as an OCI `FROM`. The build now mirrors its pinned open-source recipe with checked provenance while retaining the immutable candidate, publisher/consumer smoke, cleanup, promotion, and rollback gates.

## 2026-08-15 (4)
* **Vercel image final verification hardening**: Authorized credentialed PR runs by exact reviewed SHA and repository owner, isolated commit-pinned read-only verification from write-capable promotion, restricted manual dispatch to the default branch, forced fresh run-unique candidate builds, added byte-hashed digest-correlated live zstd manifest evidence, tightened runtime provenance, and closed recovered-cleanup and promotion-branch trust gaps.
