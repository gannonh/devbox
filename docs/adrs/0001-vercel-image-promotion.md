---
type: ADR
title: Digest-pinned Vercel image promotion
status: Accepted
issue: https://github.com/gannonh/devbox/issues/4
---

# Digest-pinned Vercel image promotion

## Decision

Devbox's Vercel Sandbox image is built from a manifest-digest-pinned
`vcr.vercel.com/vercel/sandbox/universal` base and is promoted only as a
fully-qualified public VCR digest reference. The Dockerfile receives the base
manifest digest as a required build argument, builds only `linux/amd64` with
Buildx zstd output, and defines neither `ENTRYPOINT` nor `CMD`; Sandbox startup
is explicit through `/usr/local/bin/devbox-start`.

A candidate is immutable (`sha-<source-commit>-<base-digest>`), waits for VCR readiness under
an enforced child-process deadline, and must pass two real Sandbox gates:
publisher-project filesystem/runtime checks and independent consumer-project
public-pull checks. All VCR CLI calls use the audited `vercel@58.11.0` version
and an explicit publisher/consumer team scope. The flat repository response is
correlated by repository ID/name/project ID, while separately scoped project
and team responses correlate project account ID to one team ID/slug. Both
credential sets are complete, scoped, and token-distinct; returned identity is
verified before smoke. Every required display/proxy process must be running, every required runtime
and display binary must pass a bounded version probe, every VM session must
finish `stopped`/`aborted`, and Sandbox/snapshot deletion must be verified
without resuming a Sandbox. Eventual post-delete `running`/`stopping` responses
receive bounded stop/delete retries and a final re-enumeration before the gate
fails closed. HTTP probes, SDK operations, smoke execution, and cleanup all
have explicit deadlines. Candidate runs are serialized with a non-canceling workflow concurrency group;
existing tags are reused only when their inspected manifest digest matches, and
promotion branch/PR creation is idempotent for an open matching PR; closed
or merged PRs do not suppress a new promotion proposal. Apt inputs come from a reviewed
dated Ubuntu snapshot matched to the pinned base distro rather than a moving
archive index. The pin in `src/providers/vercel/image.ts` is changed only by a reviewed promotion PR that
consumes redacted publisher/consumer evidence for the exact digest, URLs,
complete named checks, timings, scopes, and cleanup. Promotion also rejects
empty IDs/URLs, non-HTTPS noVNC URLs, malformed or unordered ISO timestamps,
insane durations, missing final owned-resource convergence, and malformed
cleanup-error arrays. Evidence upload fails
closed if redaction fails. A scheduled Universal-drift check may open that PR
but cannot merge or release it.

## Rationale

VCR prepares custom images asynchronously and Sandbox does not execute Docker
entrypoint defaults. Digest identity and explicit startup therefore need to be
validated in the same real Sandbox used for promotion. A separate consumer
token and project/team identity proves that public visibility works across
project boundaries, not merely through the publisher's private registry
permissions. Direct repository/project/team correlations avoid accepting
unrelated identity fields from one aggregate response. Centralized artifact
redaction receives both actual publisher and consumer token values in every
redaction path, keeping readiness, session, snapshot, stage-timing, and cleanup
evidence useful without placing credentials in logs or image layers. Owned
Sandbox tags/names support recovery after lost handles, including bounded
Universal digest probing and final snapshot verification. Because
`Snapshot.list()` returns plain metadata, every cleanup resolves the metadata
`id` with `Snapshot.get` before bounded instance deletion; owned name/tag and
snapshot discovery continue through an abortable cleanup grace window. Broad
collection-discovery failures are never treated as empty results: a fresh final
listing must omit every owned Sandbox name, and the final snapshot listing is
authoritative for deleted/absent metadata. Recoverable intermediate cleanup
errors are replaced after convergence; residual IDs/statuses or unresolved
errors fail the gate closed.

## Consequences

- The first publisher repository visibility change is an explicit operator
  action; CI verifies visibility and never changes it silently.
- A live publisher token, separate consumer token, public VCR repository, and
  Sandbox-enabled projects are required for the candidate workflow.
- A failed or same-project-only candidate cannot update the release pin.
- Rollback is a reviewed pin change plus package release. Existing named
  Sandboxes keep their creation image until removal/recreation.

## Rejected alternatives

- Floating `latest` or a bare project-relative image reference: these allow
  the tested bytes to differ from the promoted bytes.
- Docker `ENTRYPOINT`/`CMD`: Vercel Sandbox ignores both for custom images.
- Scheduled auto-promotion: upstream drift must pass the same smoke and review
  gates as a manually requested candidate.
- A registry visibility mutation in CI: public publication is a one-time,
  auditable operator decision.
