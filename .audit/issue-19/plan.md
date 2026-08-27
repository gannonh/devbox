# Issue 19 delivery plan

Definition of done

- `devbox BRANCH --pause` works for local and Vercel providers.
- Local attach resumes paused containers without restarting their display.
- Vercel pause retains one automatic snapshot and reports a paused state.
- Vercel attach and normal branch boot resume a matching snapshot without
  clone, dependency install, or post-create work.
- Runtime secret drift syncs GitHub auth and environment without full
  reprovisioning.
- Snapshot resume restarts display and recorded relay services, then writes
  running-session evidence for the next cheap attach.
- List and remove distinguish and handle paused resources.
- Idle Vercel sessions pause only after a remote heartbeat window and never
  while setup is running.
- CLI help, README, reference, architecture, devbox skill, ADR, tests, local
  gates, and credentialed Nightly evidence describe the same behavior.

Delivery units

1. Provider contract, CLI action, local Docker state, list, and focused tests.
2. Vercel session identity, snapshot lifecycle reporting, metadata preservation,
   list projection, and cleanup tests.
3. Runtime evidence classifier, snapshot fast path, display and relay restore,
   marker rewrite, and focused tests.
4. Heartbeat writer, idle decision/controller, mutable branch policy, and tests.
5. Documentation, ADR, smoke/UAT evidence, full local gates, and diff review.

Riskiest unknowns

- A newly created snapshot ID cannot be written into its frozen filesystem.
- The SDK handle's public `currentSession().sessionId` is the session identity;
  the sandbox name is not enough for cheap attach proof.
- Snapshot resume must rebuild session-local display and relay processes.

Verification rule

Every unit ends with focused tests and a typecheck. The whole feature ends with
the real CLI build, full available tests, artifact inspection, and the
credentialed Nightly UAT path when credentials are available.
