---
type: ADR
title: Digest-pinned Vercel image promotion
status: Accepted
issue: https://github.com/gannonh/devbox/issues/4
---

# Digest-pinned Vercel image promotion

## Decision

Devbox's Vercel Sandbox image mirrors the audited open-source Universal recipe
at a full upstream commit. `images/vercel/provenance.json` pins the upstream
Dockerfile hashes, digest-pinned Ubuntu and Bun bases, dated apt snapshot,
download checksums, exact runtime versions, and observed managed-VMI parity.
The managed VMI itself is not an OCI build base: credentialed Docker/Buildx
pulls return `not found`, so the build never claims to derive from that
inaccessible reference. The image builds only `linux/amd64` as one Buildx zstd
manifest. The workflow inspects the exact selected digest as raw OCI JSON,
requires its byte hash to equal that digest, and requires every layer descriptor
to use the OCI zstd media type before smoke.
BuildKit's optional provenance attestation is disabled because it wraps the
manifest in an OCI index whose VCR status remains `null`, while VCR optimizes
and reports readiness on the child manifest. Reviewed provenance is instead
checked in as `provenance.json`, embedded in the image, validated against
upstream before publication, and uploaded with workflow evidence. The
image has no `ENTRYPOINT`, clears Ubuntu's inherited shell command with empty
`CMD []`, and starts Sandbox services explicitly through
`/usr/local/bin/devbox-start`.

A candidate is immutable (`sha-<source-commit>-<upstream-commit>-<ubuntu-digest>-<run-id>-<attempt>`), waits for VCR readiness under
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
have explicit deadlines. Candidate runs are serialized with a non-canceling
workflow concurrency group, and every run builds to a never-reused tag containing
its source/provenance identity plus GitHub run ID and attempt. Credentialed PR
verification requires a repository-owner-applied `vcr:<full-head-SHA>` label
event for that exact commit, receives only the required Vercel secrets, and has
read-only repository permission. Manual dispatch is owner-only on the default
branch, and all third-party actions are commit-pinned. A separate write-capable
job generates the pin from verified source and never executes code from a remote
promotion branch. It reuses an open proposal only after proving its sole commit
is rooted at the verified source and changes only the identical pin. An
already-matching source pin exits without publishing an empty branch; closed or
merged PRs do not suppress a new run-suffixed promotion proposal.
Apt inputs come from a reviewed
dated Ubuntu snapshot matched to the pinned base distro rather than a moving
archive index. Candidate validation fetches the exact upstream commit and
recomputes both recorded Dockerfile hashes; release validation binds the pin to
the exact checked-in provenance artifact. The pin in `src/providers/vercel/image.ts` is changed only by a reviewed promotion PR that
consumes redacted publisher/consumer evidence for the exact digest, URLs,
complete named checks, timings, scopes, and cleanup. Promotion also rejects
empty IDs/URLs, non-HTTPS noVNC URLs, malformed or unordered ISO timestamps,
insane durations, missing final owned-resource convergence, and malformed
cleanup-error arrays. Evidence upload fails
closed if redaction fails. A scheduled upstream drift check never builds
floating inputs: unchanged provenance skips, while drift records evidence and
requires a reviewed provenance/recipe update before the same candidate gates
can run. It cannot merge or release changes.

## Rationale

VCR prepares custom images asynchronously and Sandbox does not execute Docker
entrypoint defaults. A direct single-platform manifest gives VCR one status-bearing
artifact to optimize; an attestation-created index has no readiness state even
when its child manifest is ready. Digest identity and explicit startup therefore
need to be validated in the same real Sandbox used for promotion. A separate consumer
token and project/team identity proves that public visibility works across
project boundaries, not merely through the publisher's private registry
permissions. Direct repository/project/team correlations avoid accepting
unrelated identity fields from one aggregate response. Centralized artifact
redaction receives both actual publisher and consumer token values in every
redaction path, keeping readiness, session, snapshot, stage-timing, and cleanup
evidence useful without placing credentials in logs or image layers. Owned
Sandbox tags/names support recovery after lost handles and final snapshot
verification. Because `Snapshot.list()` returns plain metadata, every cleanup resolves the metadata
`id` with `Snapshot.get` before bounded instance deletion; owned name/tag and
snapshot discovery continue through an abortable cleanup grace window. Broad
collection-discovery failures are never treated as empty results: a fresh final
listing must omit every owned Sandbox name, and the final snapshot listing is
authoritative for deleted/absent metadata. Recoverable resource-operation errors
are cleared after final convergence, while discovery failures, residual
IDs/statuses, and unresolved errors fail the gate closed.

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
- Direct `FROM vcr.vercel.com/vercel/sandbox/universal`: authenticated live
  Docker/Buildx checks prove the managed VMI is Sandbox-resolvable but not
  OCI-pullable.
- Runtime-bearing Docker `ENTRYPOINT`/`CMD`: Vercel Sandbox ignores both for
  custom images; only an empty `CMD []` clears Ubuntu's inherited shell.
- Scheduled auto-promotion: upstream drift must pass the same smoke and review
  gates as a manually requested candidate.
- A registry visibility mutation in CI: public publication is a one-time,
  auditable operator decision.
