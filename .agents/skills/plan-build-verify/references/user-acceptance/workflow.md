# User Acceptance Evidence

## Operating brief

When this workflow runs, gather real evidence that the feature branch, ticket, or PR works. Treat the request as: "prove the completed work by exercising it and producing artifacts a human can inspect."

Acceptance evidence should be experiential and reproducible:

- For every user-facing slice, run at least one durable automated end-to-end test through the public interface. A black-box system or integration test counts when that is the repository's name for the same boundary.
- For UI changes, screenshots at meaningful checkpoints are required. Capture video when practical because it shows timing, transitions, focus, and the complete flow.
- For CLI and TUI apps, capture terminal transcripts, screenshots, recordings, generated files, and exit codes.
- For APIs and SDKs, capture requests, responses, output files, logs, and small runnable examples.
- For native apps, including Electron-type apps, use the real app window. Prefer `agent-browser` through Electron CDP or `agent-cu`/an installed computer-use skill for native accessibility-driven interaction and screenshots.

Automated tests can supplement UAT, but they do not replace an in-app walkthrough, command run, API call, or SDK example.

## Supported targets

Use this workflow for:

1. Web apps
2. CLI and TUI apps
3. APIs and SDKs
4. Native apps, including Electron-type apps

If the requested target is outside this list, ask whether to proceed with a best-effort evidence plan.

## Hard gates

1. **Scope lock first**
   - Start with `UAT Scope: <ticket/PR/branch scope only>`.
   - If the scope is unclear, inspect the branch diff, PR, ticket, or ask the user.

2. **Evidence before recommendation**
   - Do not recommend merge based only on summaries, static code review, or green tests.
   - Exercise the changed behavior and save artifacts.

3. **E2E evidence is mandatory**
   - Every user-facing slice needs at least one passing automated end-to-end test through its public interface: UI, CLI, API, SDK, or operator workflow.
   - A repository may call the test `system` or `integration`; it counts only when it exercises the real public boundary and observable outcome rather than internal units.
   - Capture the command, exit code, and log in `evidence.json` with command kind `e2e`.
   - An approved technical-enablement exception uses a passing contract/integration test with command kind `contract` instead.
   - If the required test cannot run after one focused setup or repair attempt, mark the slice `Blocked` and report what tooling or environment is missing. Do not replace it with screenshots or a manual claim.

4. **Screenshots are mandatory for visual targets**
   - Web, TUI, native, Electron, and mixed UI work needs starting and final screenshots. Add key-state screenshots only when an acceptance criterion needs an intermediate state to be inspectable.
   - Use the preferred screenshot tool, then at most one documented fallback. If both fail, mark the affected slice `Blocked`; video alone does not replace inspectable still evidence.

5. **Video is ideal, not an unbounded gate**
   - For web, TUI, native, and Electron work, attempt video when it would clarify interaction, layout, transitions, timing, state changes, or error handling.
   - Try the preferred recorder once. If the failure has an obvious bounded fix, make one retry or use one documented fallback—not both repeatedly.
   - If recording remains unavailable because of codecs, permissions, display access, or missing tooling, skip it and add `Video: Skipped — <reason>; attempted: <tool>; suggested tooling: <what would unblock it>` to `evidence.md` and the manifest notes.
   - Do not install or debug a new recording stack solely for ideal video during Verify. Missing video alone does not fail or block a slice unless an acceptance criterion explicitly requires temporal proof.

6. **Manual run instructions are mandatory**
   - Always include steps the human can run themselves.
   - For UI work, primary instructions must use normal product-user actions.
   - For CLI, TUI, API, or SDK work, include copy-pasteable commands or code snippets with expected outcomes.

7. **No GO verdict without explicit human acceptance**
   - Before user confirmation, use `Recommendation: Pending user sign-off`.
   - Use `GO` or `GO with follow-ups` only after the user explicitly accepts.

8. **Do not claim acceptance completion unilaterally**
   - Evidence collection supports acceptance.
   - The human grants acceptance.

9. **Adversarial evidence review**
   - When subagents are available, ask at least one adversarial reviewer to compare the gathered evidence against the spec, acceptance criteria, requirements, PR description, or ticket.
   - The reviewer must provide `Pass` or `Fail` for each criterion and cite the artifact path or log line that supports the judgment.
   - If subagents are unavailable, perform the same review inline and label it `Inline adversarial review`.

## Tool selection

Load and use the best available skill or CLI for the target. Install missing tooling when it is needed for required E2E or screenshot evidence and installation is safe in the environment. Do not install or spend unbounded time debugging tooling solely for optional video; use the skip-and-flag contract instead.

| Target | Preferred tools | Evidence to capture |
| --- | --- | --- |
| Web app | `agent-browser` for automation, screenshots, and `record start/stop`; Playwright when the repo already uses it or traces are useful; `chrome-cdp` only for an already-open Chrome page with user approval | Passing E2E log, required screenshots, optional video, DOM/accessibility snapshots, console/network notes |
| CLI app | Repo E2E/system test, shell commands, `script`, generated output files; VHS for deterministic terminal GIF/MP4/WebM when visual proof helps | Passing E2E log, terminal transcript, exit codes, output files, JSON, optional recording |
| TUI app | Repo E2E/system test; VHS for scripted terminal capture; an installed computer-use CLI for real interaction and screenshots | Passing E2E log, required screenshots, transcript/config/output files, optional video/GIF |
| API | Public-boundary E2E/system test, `curl`, HTTP client, repo scripts, logs | Passing E2E log, request/response JSON, status codes, logs, saved payloads |
| SDK | Public-boundary E2E/system test and minimal runnable example using the built package | Passing E2E log, source snippet, command output, generated files, logs |
| Native app, including Electron-type | Existing app E2E harness; `agent-browser` through Electron CDP when available; `agent-cu` or an installed computer-use skill for accessibility-driven desktop interaction and screenshots | Passing E2E log, required window screenshots, accessibility snapshots/logs, optional video |

Useful capability checks:

```bash
command -v agent-browser || true  # web/Electron automation, screenshots, WebM recording
command -v agent-cu || true       # cross-platform accessibility-driven desktop control/screenshots
command -v vhs || true            # deterministic terminal GIF/MP4/WebM
command -v ffmpeg || true         # recorder dependency/fallback, environment-specific
```

Preferred video paths:

```bash
# Web or CDP-accessible Electron
agent-browser record start uat-evidence/<target>-<timestamp>/recordings/flow.webm
# exercise the flow
agent-browser record stop

# Existing Playwright suite: configure `use.video: 'on'` for the evidence run.
# CLI/TUI: render a checked-in or generated VHS tape.
vhs evidence.tape
```

Do not install tools unrelated to the target. For true native desktop apps, `agent-cu` is useful for deterministic accessibility interaction and screenshots but is not the recorder; pair it with an already-available platform recorder, or skip and flag video.

## Evidence workspace

Use the bundled helpers when practical. Resolve script paths relative to the `plan-build-verify` skill directory (`scripts/user-acceptance/`).

```bash
# Create the evidence directory and starter manifest.
node scripts/user-acceptance/init-evidence.mjs --target electron --mode user-facing --visual true --scope "validated behavior"

# Run the required public-boundary E2E test while saving its log and exit code.
node scripts/user-acceptance/run-capture-command.mjs --evidence <dir> --kind e2e --name feature-e2e -- pnpm test:e2e

# Capture a CDP-accessible web/Electron page when agent-browser screenshots fail.
node scripts/user-acceptance/cdp-capture-page.mjs --evidence <dir> --cdp http://127.0.0.1:9222 --title "Kata Desktop" --screenshot screenshots/start.png --checkpoint starting --text logs/start-text.txt

# Generate and check final artifacts before responding.
node scripts/user-acceptance/write-report.mjs --evidence <dir>
node scripts/user-acceptance/verify-evidence.mjs --evidence <dir>
```

The helpers do not replace judgment. They prevent common evidence mistakes: missing E2E/contract logs, missing exit codes, empty reports, invalid `evidence.json`, absent required screenshots, undocumented video skips, and command output that was never saved.

Write generated evidence under a repo-local folder:

```text
uat-evidence/<target>-<YYYYMMDD-HHMMSS>/
```

Create artifacts as appropriate:

```text
evidence.json          # machine-readable manifest
evidence.md            # concise human report
screenshots/           # PNG/JPG checkpoints
recordings/            # MP4/GIF terminal or UI recordings
responses/             # JSON/API/SDK outputs
logs/                  # command logs, server logs, console excerpts
outputs/               # generated files from the feature
```

Keep evidence paths stable and report them in the final answer. Store repo-relative or absolute artifact paths consistently for the run. If `uat-evidence/` is not ignored by git, mention that it should be ignored before committing unless the user explicitly wants artifacts committed.

A minimal `evidence.json` should include:

```json
{
  "scope": "validated behavior",
  "target": "web|cli|tui|api|sdk|native|electron",
  "mode": "user-facing|technical-enablement",
  "visual": true,
  "technical_enablement": null,
  "timestamp": "ISO-8601",
  "git_commit": "short sha",
  "artifacts": [
    {"type": "screenshot", "checkpoint": "starting|key|final", "path": "uat-evidence/.../screenshots/start.png", "description": "what it proves"}
  ],
  "commands": [
    {"name": "feature-e2e", "kind": "e2e|contract|supporting", "argv": ["command", "arg"], "command": "\"command\" \"arg\"", "exit_code": 0, "output_path": "uat-evidence/.../logs/example.log"}
  ],
  "notes": [
    "Video: Skipped — <reason>; attempted: <tool or bounded fallback>; suggested tooling: <what would unblock it>"
  ],
  "slices": [
    {"id": "stable-slice-id", "name": "slice name", "result": "Pass|Fail|Blocked|Not tested", "evidence": ["uat-evidence/.../screenshots/final.png"]}
  ]
}
```

For `mode: technical-enablement`, replace `technical_enablement: null` with:

```json
{
  "approval_ref": "issue/comment URL approving the exception",
  "blocker": "why no safe user-facing slice can include this work",
  "minimum_scope": "bounded approved scope",
  "unlocked_slice": "immediate user-facing slice",
  "dependency_ref": "GitHub issue URL for the native dependency"
}
```

## Workflow

### 1. Identify scope, target, and acceptance slices

- Inspect branch diff, PR description, ticket, README, package scripts, and app entry points as needed.
- Declare `UAT Scope: ...`.
- Declare `Target: web | cli | tui | api | sdk | native | electron | mixed`.
- Declare `Evidence mode: user-facing | technical-enablement`. Use technical enablement only for the approved exception recorded in the spec.
- Declare whether the run is visual. Web, TUI, native, Electron, and mixed UI targets are always visual; mark CLI visual when formatting or terminal UI is part of acceptance.
- For technical enablement, fill `technical_enablement` with the approval reference, blocker, minimum scope, immediately unlocked slice, and dependency reference.
- Break the scope into 1 to 5 acceptance slices. Give each a stable ID, result, and existing evidence paths; empty or non-passing slices prevent evidence validation.
- Define visible pass/fail criteria for each slice.

### 2. Prepare the app or service

- Start the dev server, service, CLI, TUI, API, SDK fixture, or native/Electron-type app needed for the walkthrough.
- Prefer real local behavior over mocks.
- For web and native/Electron-type targets, check ports and existing processes before launch. Record any cleanup in `logs/`.
- Use the user's normal product command for the product smoke path. If you need CDP, traces, or deterministic screenshots, run a second instrumented path and label it as such.
- Pick free debug ports rather than assuming `9222`; if a port is occupied, save the listener evidence and choose another port.
- If credentials, services, hardware, or permissions block proof, record the blocker and provide the closest reproducible plan. Do not mark blocked slices as passed.

### 3. Execute the feature path

Use the matching playbook (paths relative to `references/user-acceptance/`):

- Web app UI flows: `web-playbook.md`
- Native/Electron-type UI flows: `native-electron-playbook.md`
- CLI, TUI, API, and SDK: `cli-api-sdk-playbook.md`

For native/Electron-type app-window validation, use `agent-browser` through Electron CDP when available, or `agent-cu`/an installed computer-use skill for the real desktop surface. Do not let optional video tooling block required E2E and screenshot evidence.

For mixed work, run the user-facing path first, then the technical proof tied to the same outcome.

### 4. Capture durable evidence

- Save artifacts under `uat-evidence/<target>-<timestamp>/`.
- Run and capture the required E2E command with `run-capture-command.mjs --kind e2e`. For approved technical enablement, use `--kind contract`.
- Capture required starting and final screenshots for visual targets. Add key-state screenshots when an acceptance criterion needs intermediate proof.
- Attempt video for web, native/Electron-type, and TUI when it adds useful temporal proof. Follow the bounded retry rule; if it remains unavailable, add the standardized `Video: Skipped` note and continue.
- Capture command output with `tee`, `script`, or `scripts/user-acceptance/run-capture-command.mjs`; always save exit codes.
- Save API/SDK JSON responses and generated output files.
- For bugfix UAT, capture negative evidence that the old failure is absent: search logs for the old error string, search active source/docs for removed flags or stale commands, and save zero-match outputs.
- Classify failed checks. If a failing file or behavior changed in the branch, treat the slice as failed. If it is outside the branch diff, report it as an unrelated validation failure with file/error evidence.
- Write `evidence.json` and `evidence.md`, then run `scripts/user-acceptance/verify-evidence.mjs` before responding. A missing or failed E2E/contract command or missing required screenshot is a blocker; a correctly documented video skip is not.

### 5. Run adversarial evidence review

- Provide the spec, acceptance criteria, requirements, PR description, or ticket plus the saved artifacts to an adversarial review subagent when available.
- Ask the reviewer to decide `Pass` or `Fail` for each criterion and cite exact evidence paths.
- Treat missing, ambiguous, or inaccessible artifacts as failures for the affected criteria.
- If a reviewer flags a gap, collect more evidence or mark the slice failed before reporting.

### 6. Report results

Use this order:

1. `UAT Scope: ...`
2. `Target: ...`
3. `Required Evidence Status` — E2E/contract, screenshots, and video captured/skipped
4. `Slice-by-slice result`
5. `Evidence`
6. `Adversarial Review`
7. `Manual Run Instructions`
8. `Recommendation: Pending user sign-off`
9. `Please reply: accept / reject`

Keep the report concise. Link to artifact paths and explain what each artifact proves.

## Output contract

For every UAT response, include:

```markdown
UAT Scope: <scope>
Target: <web|cli|tui|api|sdk|native|electron|mixed>
Evidence mode: <user-facing|technical-enablement>

Required Evidence Status:
- E2E/contract: Pass | Blocked - <command and log path>
- Screenshots: Pass | Blocked | Not applicable - <paths or reason>
- Video: Captured | Skipped | Not applicable - <path or standardized skip reason>

Slice-by-slice result:
- Pass/Fail: <slice> - <one-line evidence summary>

Evidence:
- <artifact path> - <what it proves>

Adversarial Review:
- Pass/Fail: <criterion> - <artifact-backed reason>

Manual Run Instructions:
1. <human step or command>
   Expected: <visible result or output>

Recommendation: Pending user sign-off
Please reply: accept / reject
```

For UI targets, manual instructions must start with normal user actions in the running app. Put automation commands or test harnesses only in a clearly labeled `Fallback (Engineering Only)` section.

For CLI, TUI, API, and SDK targets, manual instructions may be commands or code snippets, but they must include expected output and any required environment variables.

## Ticket update guidance

If a ticket or PR is known, offer or perform a status update with:

- Scope validated
- Target and tools used
- Slice pass/fail summary
- Evidence paths or links
- Manual run instructions
- Current recommendation

Before explicit user acceptance, label the update `Pending user sign-off`. After explicit acceptance, record the final verdict if the project workflow requires it.

## Pre-response self-check

Before responding, verify:

- Scope is stated.
- Target is stated.
- Each slice has pass/fail status.
- Evidence artifacts exist or blockers are clearly labeled.
- `evidence.json` is valid and `evidence.md` is non-empty.
- User-facing evidence includes a passing public-boundary E2E command tagged `e2e`; approved technical enablement includes a passing command tagged `contract`.
- Visual targets include readable screenshots at required checkpoints. Missing screenshots block the affected slice.
- Video exists when practical. Otherwise the standardized skip note records the reason, attempted tool, and suggested tooling; no further recording retries are pending.
- Native app validation used `agent-cu`, an installed computer-use skill, or another documented real-window method when available.
- Adversarial review checked every criterion against evidence and produced pass/fail judgments.
- Command logs include exit codes.
- Old-bug negative evidence is saved when validating a fix.
- Dev servers, native/Electron-type apps, or background processes launched for UAT are cleaned up or explicitly left running for the user.
- Manual run instructions are included.
- Recommendation remains `Pending user sign-off` unless the user has accepted.

## Common mistakes

- Running only tests and calling it UAT.
- Reporting a code summary without artifacts.
- Treating manual walkthroughs, screenshots, or unit tests as a replacement for the required public-boundary E2E test.
- Skipping required screenshots or treating video as a substitute for them.
- Spinning on optional video recording after the preferred path and one bounded retry/fallback failed.
- Omitting the standardized reason when video is skipped.
- Providing Playwright or test commands as the primary manual UI path.
- Forgetting TUI visual evidence.
- Omitting API request and response files.
- Declaring `GO` before the user accepts.
- Installing every tool instead of selecting the best tool for the target.
