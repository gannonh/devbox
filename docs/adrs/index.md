# ADRs

## Accepted

* [Provider boundary for devbox lifecycle commands](0001-provider-boundary.md) - CLI registry routing and local-provider isolation for issue [#3](https://github.com/gannonh/devbox/issues/3).
* [Digest-pinned Vercel image promotion](0001-vercel-image-promotion.md) - digest identity, explicit Sandbox startup, independent consumer proof, and reviewed promotion for issue [#4](https://github.com/gannonh/devbox/issues/4).
* [Vercel provider convergence](0002-vercel-provider-convergence.md) - direct SDK lifecycle, digest pin, and evidence-gated release for issue [#7](https://github.com/gannonh/devbox/issues/7); display auth superseded by ADR 0003.
* [noVNC access-code pairing](0003-novnc-access-code-pairing.md) - the printed display link pairs the browser on click; supersedes the Basic Auth clause of ADR 0002.
* [Image pin as a build output](0004-image-pin-as-build-output.md) - tags for development, digests for releases; removes the promotion pull request.
* [Zero-configuration public app ports](0005-zero-config-public-app-ports.md) - a bounded remote `package.json` detector, one public-route confirmation, and a pending/commit port update for issue [#13](https://github.com/gannonh/devbox/issues/13).
* [Coding-agent version manifest](0006-agent-version-manifest.md) - a single manifest declares the supported agents; the image derives from it and promotion is a reviewable pull request for issue [#12](https://github.com/gannonh/devbox/issues/12).

## Proposed

_None yet._

## Superseded

_None yet._
