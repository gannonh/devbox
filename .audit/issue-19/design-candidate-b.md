# Issue 19 architecture candidate B

## Shape

Introduce explicit local and Vercel box states. Add a first-class provider
pause operation. Keep Vercel lifecycle handles small and let the provider map
pause to the existing persistent stop operation.

Model local boxes as missing, running, paused, or stopped. Inspect Docker
state before attach and unpause a paused container without restarting its
display. Render paused and stopped distinctly in list output.

Model Vercel list state as running, paused, or stopped. A stopped persistent
sandbox with a current snapshot is paused. Fetch the matching snapshot for an
age when rendering list output. Existing cleanup machinery should delete all
matching snapshots before metadata removal.

Keep two proof authorities. The filesystem marker proves prepared source and
runtime facts. Branch metadata records the snapshot returned by stop. On
resume, require the SDK session `sourceSnapshotId` to match the retained
metadata snapshot and rewrite the marker with the new session identity.

Store `DEVBOX_IDLE_PAUSE_MINUTES` as mutable branch policy. A pure idle
decision function should handle fresh, stale, missing, and unreadable
heartbeats. A host timer polls remote heartbeat and setup state, is suppressed
while setup runs, writes heartbeat on terminal input, and stops with terminal
teardown.

## Strengths

- Gives CLI and list behavior an explicit domain model.
- Makes local paused-container handling safe and predictable.
- Keeps auto-pause testable with a clock and scheduler.
- Orders idle work after the manual pause path is proven.

## Risks

- A large lifecycle entry-result rewrite would increase surface area.
- Snapshot age requires a bounded snapshot lookup path.
- Metadata writes must preserve app-port and display fields.
