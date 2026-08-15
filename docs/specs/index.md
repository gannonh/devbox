# Specs roadmap

## Implemented

* [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md) - package devbox tooling as an npm package with `init`, launcher commands, release workflow, and E2E validation.
* [Provider foundation and local parity (#3)](https://github.com/gannonh/devbox/issues/3) - implementation and acceptance evidence are complete in [PR #8](https://github.com/gannonh/devbox/pull/8), awaiting maintainer sign-off and merge; it is not yet user-verified or merged.

## Active

* [Cloud devboxes on Vercel Sandbox](https://github.com/gannonh/devbox/issues/2) - approved epic for the first cloud provider.
* [Vercel image supply chain (#4)](https://github.com/gannonh/devbox/issues/4) - the remaining active Build phase (`status:approved`, `phase:build`).

## Dependency order

* [Core workspace lifecycle (#5)](https://github.com/gannonh/devbox/issues/5) - blocked by #3 and #4.
* [Full parity and security (#6)](https://github.com/gannonh/devbox/issues/6) - blocked by #5.
* [Vercel provider convergence (#7)](https://github.com/gannonh/devbox/issues/7) - blocked by #6.

## Planned

_None._

## Blocked

_None._
