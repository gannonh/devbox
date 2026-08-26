# Issue 19 architecture candidate A

## Shape

Use a source-session proof chain. The runtime marker names the prepared
session. The stop result names the snapshot created from that session. A
resumed SDK session exposes the snapshot it came from.

The in-box marker remains a running-session marker. Host branch metadata owns
the retained snapshot ID and cleanup ledger. Do not write a newly returned
snapshot ID into a stopped filesystem because the SDK resumes a sandbox for
filesystem writes.

Add `sourceSnapshotId` to the client handle and expose a reliable current
session ID from the SDK `currentSession().sessionId`, with the existing name
fallback for test doubles and older handles.

Use a discriminated runtime decision with running-session reuse, runtime-only
sync, snapshot fast resume, and full provision. Stable source revision, image,
sandbox name, and snapshot source must match before skipping clone, dependency
installation, and post-create. Token or environment drift refreshes secrets
without reprovisioning.

Snapshot resume restarts display and relay services, writes a new running
marker, and leaves the next running attach on the cheap path. Existing relay
selection is re-bound to the new session rather than reused as a live process
record.

Add `--pause`, keep `--stop` as the existing Vercel snapshot-producing action,
and make local pause use Docker pause. Persist idle policy separately from
create-only configuration. The idle controller polls remote heartbeat and
setup state, and never treats host-side attachment as activity.

## Strengths

- Proves the snapshot with independent lifecycle facts.
- Avoids an impossible post-freeze marker write.
- Keeps cleanup ownership in metadata and preparation ownership in the box.
- Separates snapshot route reconstruction from cheap running attach.

## Risks

- Needs a stable session-ID adapter seam.
- Needs preservation-safe metadata writes as new pause fields are introduced.
- Requires explicit idle heartbeat and setup polling tests.
