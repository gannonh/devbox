---
okf_version: "0.1"
---

# OKF bundle

## Specs

* [Specs roadmap](/specs/index.md) - active, planned, blocked, and completed work.
* [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md) - implemented package spec and build report.
* [Cloud devboxes on Vercel Sandbox](https://github.com/gannonh/devbox/issues/2) - approved GitHub epic for the first cloud provider; its five sub-issues are linked from the [specs roadmap](/specs/index.md).

## ADRs

* [ADRs index](/adrs/index.md) - architecture decisions and history.
* [Digest-pinned Vercel image promotion](/adrs/0001-vercel-image-promotion.md) - public digest pin, dual-project smoke, and reviewed promotion.
* [Vercel provider convergence](/adrs/0002-vercel-provider-convergence.md) - direct SDK lifecycle, Basic Auth, digest pin, and evidence-gated release.

## Architecture and references

* [Vercel provider architecture](/architecture/vercel-provider.md) - boundaries, data flow, auth, ports, and CI gates.
* [Vercel provider reference](/reference/vercel-provider.md) - commands, configuration, limits, and recovery behavior.

## Runbooks

* [Vercel image supply chain](/runbooks/vercel-image-supply-chain.md) - publisher setup, candidate smoke, promotion, rollback, and cleanup.
* [Vercel provider convergence](/runbooks/vercel-provider-convergence.md) - real UAT and five-run benchmark reproduction.

## History

* [Bundle log](/log.md) - chronological update history.
