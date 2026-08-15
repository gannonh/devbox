# Specs roadmap

## Implemented

* [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md) - package devbox tooling as an npm package with `init`, launcher commands, release workflow, and E2E validation.
* [Provider foundation and local parity (#3)](https://github.com/gannonh/devbox/issues/3) - verified local-provider boundary and CLI parity, merged in [PR #8](https://github.com/gannonh/devbox/pull/8).
* [Vercel image supply chain (#4)](https://github.com/gannonh/devbox/issues/4) - verified public digest-pinned image workflow, independent consumer smoke, and operator runbook, merged in [PR #9](https://github.com/gannonh/devbox/pull/9).

## Active

* [Cloud devboxes on Vercel Sandbox](https://github.com/gannonh/devbox/issues/2) - approved epic for the first cloud provider.

## Dependency order

* [Core workspace lifecycle (#5)](https://github.com/gannonh/devbox/issues/5) - unblocked by verified phases #3 and #4.
* [Full parity and security (#6)](https://github.com/gannonh/devbox/issues/6) - blocked by #5.
* [Vercel provider convergence (#7)](https://github.com/gannonh/devbox/issues/7) - blocked by #6.

## Planned

_None._

## Blocked

_None._
