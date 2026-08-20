---
okf_version: "0.1"
---

# OKF bundle

## Specs

* [Cloud devboxes on Vercel Sandbox](https://github.com/gannonh/devbox/issues/2) - approved GitHub epic for the first cloud provider; its five sub-issues are tracked as GitHub issues.
* [Vercel provider convergence](https://github.com/gannonh/devbox/issues/7) - the current phase, its acceptance evidence, and signoff.

## ADRs

* [ADRs index](/adrs/index.md) - architecture decisions and history.
* [Digest-pinned Vercel image promotion](/adrs/0001-vercel-image-promotion.md) - public digest pin, dual-project smoke, and reviewed promotion.
* [Vercel provider convergence](/adrs/0002-vercel-provider-convergence.md) - direct SDK lifecycle, digest pin, and evidence-gated release.
* [noVNC access-code pairing](/adrs/0003-novnc-access-code-pairing.md) - the printed display link pairs the browser on click.
* [Image pin as a build output](/adrs/0004-image-pin-as-build-output.md) - three channels, zero CI-authored pull requests.
* [Zero-configuration public app ports](/adrs/0005-zero-config-public-app-ports.md) - detect from remote metadata, confirm once, update in place.

## Architecture and references

* [Vercel provider architecture](/architecture/vercel-provider.md) - boundaries, data flow, auth, ports, and CI gates.
* [Vercel provider reference](/reference/vercel-provider.md) - commands, configuration, limits, and recovery behavior.

## Runbooks

* [Vercel image supply chain](/runbooks/vercel-image-supply-chain.md) - publisher setup, candidate smoke, promotion, rollback, and cleanup.
* [Vercel provider convergence](/runbooks/vercel-provider-convergence.md) - real UAT and five-run benchmark reproduction.

## History

* [Bundle log](/log.md) - chronological update history.
